/**
 * GameRoomDO — Durable Object for a single live game.
 *
 * State lives in transactional DO storage. Turn deadlines use DO alarms.
 * All real-time updates (both players and browser spectators) use hibernatable
 * WebSockets tagged by role so the right view goes to the right connection.
 *
 * HTTP routes (sub-path, forwarded from the main Worker):
 *   POST /          — create game { gameType, config, playerIds, handleMap, teamMap }
 *   POST /action    — apply action { action }. Identity from X-Player-Id
 *                     header; missing header = system action (null).
 *   POST /tool      — plugin tool call { relay }. Same identity rule.
 *   GET  /state     — fog-filtered state for the X-Player-Id header;
 *                     missing = spectator view. Query params and bodies
 *                     are never trusted for identity.
 *   GET  /result    — Merkle root + outcome (only when finished)
 *   GET  /spectator — current delayed spectator view (HTTP snapshot, no WS)
 *   GET  /bundle   — full action bundle for verification (only when finished)
 *
 * WebSocket routes (forwarded from main Worker after auth):
 *   WS / (no X-Player-Id header)   — spectator: delayed view, no auth required
 *   WS / (X-Player-Id: <playerId>) — player: real-time fog-filtered view, auth
 *                                    validated by Worker before forwarding
 *
 * On each state change the DO pushes:
 *   - spectator tag: delayed spectator view → browser watchers
 *   - <playerId> tag: fog-filtered view → that player's CLI connection
 */

import { DurableObject } from 'cloudflare:workers';
import { getGame, buildActionMerkleTree, validateChatScope } from '@coordination-games/engine';
import type { CoordinationGame, MerkleLeafData } from '@coordination-games/engine';
import type { Env } from '../env.js';
import { computePublicSnapshotIndex } from './spectator-delay.js';
import { resolveGameId } from './resolve-gameid.js';

// Side-effect imports: each calls registerGame() on module load
import '@coordination-games/game-ctl';
import '@coordination-games/game-oathbreaker';

// ---------------------------------------------------------------------------
// WS tags
// ---------------------------------------------------------------------------

const TAG_SPECTATOR = 'spectator';
// Player connections are tagged with their playerId string directly.

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

interface GameMeta {
  gameId: string;
  gameType: string;
  playerIds: string[];
  handleMap: Record<string, string>;  // playerId → display handle
  teamMap: Record<string, string>;    // playerId → 'A' | 'B' | 'FFA'
  createdAt: string;
  finished: boolean;
  /**
   * Spectator delay (progress ticks) frozen at game creation so deploys
   * never retroactively change visibility for in-flight games.
   */
  spectatorDelay: number;
}

interface ProgressState {
  counter: number;
  snapshots: number[];  // action log index at each progress point
}

interface ActionEntry {
  playerId: string | null;
  action: unknown;
}

interface DeadlineEntry {
  action: unknown;
  deadlineMs: number;
}

/** A relay message stored in the DO. Mirrors the client-side RelayMessage shape. */
interface RelayMessage {
  index: number;
  type: string;
  data: unknown;
  scope: string;       // 'all' | 'team' | handle (DM to a specific player)
  pluginId: string;
  sender: string;      // playerId of the sender
  turn: number;        // progress counter at time of send
  timestamp: number;
}

// ---------------------------------------------------------------------------
// GameRoomDO
// ---------------------------------------------------------------------------

export class GameRoomDO extends DurableObject<Env> {
  // In-memory cache — valid for the lifetime of this DO instance
  private _loaded = false;
  private _meta: GameMeta | null = null;
  private _plugin: CoordinationGame<any, any, any, any> | null = null;
  private _state: unknown = null;
  private _actionLog: ActionEntry[] = [];
  private _progress: ProgressState = { counter: 0, snapshots: [0] };
  private _relay: RelayMessage[] = [];
  private _deadlineMs: number | null = null;
  private _config: unknown = null;  // game config (for replay reconstruction)
  private _spectatorSnapshots: unknown[] = [];  // spectator view at each progress point
  // Last publicSnapshotIndex() value pushed to spectator WS sockets —
  // broadcastUpdates skips the push when the index hasn't advanced.
  private _lastSpectatorIdx: number | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // fetch() — HTTP + WS entry point
  // ─────────────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocket(request);
    }

    if (method === 'POST' && path === '/') return this.handleCreate(request);
    if (method === 'POST' && path === '/action') return this.handleAction(request);
    if (method === 'POST' && path === '/tool') return this.handleTool(request);
    if (method === 'GET'  && path === '/state') return this.handleState(request);
    if (method === 'GET'  && path === '/result') return this.handleResult();
    if (method === 'GET'  && path === '/spectator') return this.handleSpectator();
    if (method === 'GET'  && path === '/replay') return this.handleReplay();
    if (method === 'GET'  && path === '/bundle') return this.handleBundle();

    return new Response('Not found', { status: 404 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // alarm() — turn deadline
  // ─────────────────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return;

    const deadline = await this.ctx.storage.get<DeadlineEntry>('deadline');
    if (!deadline) return;

    if (Date.now() < deadline.deadlineMs - 500) {
      // Fired too early (clock drift) — re-arm
      await this.ctx.storage.setAlarm(deadline.deadlineMs);
      return;
    }

    console.log(`[GameRoomDO] Alarm fired — applying deadline action for turn ${this._progress.counter}`);
    try {
      await this.applyActionInternal(null, deadline.action);
    } catch (err: any) {
      console.error(`[GameRoomDO] Alarm action failed:`, err?.stack ?? err);
      // Delete the broken deadline to avoid infinite retry loop
      await this.ctx.storage.delete('deadline');
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket lifecycle (hibernatable)
  // ─────────────────────────────────────────────────────────────────────────

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // All WS connections are receive-only (spectators and players).
    // Players submit actions via POST /action, not via WS.
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // CF removes closed sockets from getWebSockets() automatically.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Route handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleCreate(request: Request): Promise<Response> {
    if (this._meta) return Response.json({ error: 'Game already created' }, { status: 409 });

    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { gameType: rawGameType, config, playerIds, handleMap, teamMap, gameId: bodyGameId } = body ?? {} as Record<string, unknown>;
    if (!rawGameType || !config || !Array.isArray(playerIds)) {
      return Response.json({ error: 'gameType, config, and playerIds are required' }, { status: 400 });
    }
    const gameType = rawGameType as string;

    const plugin = getGame(gameType);
    if (!plugin) return Response.json({ error: `Unknown game type: ${gameType}` }, { status: 400 });

    let initialState: unknown;
    try { initialState = plugin.createInitialState(config); }
    catch (err: any) {
      return Response.json({ error: `createInitialState failed: ${err.message}` }, { status: 400 });
    }

    // Authoritative: ctx.id.name IS the gameId. Body field is optional and
    // must match if present — otherwise an attacker could pre-claim a future
    // game UUID and brick its on-chain settlement. See resolve-gameid.ts.
    const resolved = resolveGameId(bodyGameId as string | undefined, this.ctx.id.name);
    if (resolved.ok === false) {
      console.warn(
        `[GameRoomDO] settlement.gameid.mismatch requestedId=${resolved.log.requestedId} actualId=${resolved.log.actualId}`,
      );
      return new Response(resolved.body, { status: resolved.status });
    }
    const gameId = resolved.gameId;
    const meta: GameMeta = {
      gameId,
      gameType,
      playerIds: playerIds as string[],
      handleMap: (handleMap as Record<string, string>) ?? {},
      teamMap: (teamMap as Record<string, string>) ?? {},
      createdAt: new Date().toISOString(),
      finished: false,
      spectatorDelay: plugin.spectatorDelay ?? 0,
    };
    const progress: ProgressState = { counter: 0, snapshots: [0] };

    // Build initial spectator snapshot (turn 0)
    const initialCtx = { handles: meta.handleMap, relayMessages: [] };
    const initialSnapshot = plugin.buildSpectatorView(initialState, null, initialCtx);

    await Promise.all([
      this.ctx.storage.put('meta', meta),
      this.ctx.storage.put('state', initialState),
      this.ctx.storage.put('actionLog', []),
      this.ctx.storage.put('progress', progress),
      this.ctx.storage.put('relay', []),
      this.ctx.storage.put('config', config),
      this.ctx.storage.put('snapshotCount', 1),
      this.ctx.storage.put('snapshot:0', initialSnapshot),
    ]);

    this._meta = meta;
    this._plugin = plugin;
    this._state = initialState;
    this._actionLog = [];
    this._progress = progress;
    this._relay = [];
    this._config = config;
    this._spectatorSnapshots = [initialSnapshot];
    this._loaded = true;

    // Write initial summary to D1 so /api/games shows real data from turn 0
    this.writeSummaryToD1();

    console.log(`[GameRoomDO] Created ${gameType} game, ${playerIds.length} players`);
    return Response.json({ ok: true, gameType, playerCount: playerIds.length });
  }

  private async handleAction(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta) return Response.json({ error: 'Game not found' }, { status: 404 });
    if (this._meta.finished) return Response.json({ error: 'Game already finished' }, { status: 410 });

    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { action } = body ?? {} as Record<string, unknown>;
    if (action === undefined) return Response.json({ error: 'action is required' }, { status: 400 });

    const playerId = this.trustedPlayerId(request);
    if (playerId instanceof Response) return playerId;

    try {
      return Response.json(await this.applyActionInternal(playerId, action));
    } catch (err: any) {
      console.error(`[GameRoomDO] Error in applyActionInternal:`, err?.stack ?? err);
      return Response.json({ error: 'Internal server error', details: String(err), stack: err?.stack ?? '' }, { status: 500 });
    }
  }

  private async handleState(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });

    const playerId = this.trustedPlayerId(request);
    if (playerId instanceof Response) return playerId;

    return Response.json(this.buildPlayerMessage(playerId));
  }

  /**
   * Single trust boundary for player identity. Read X-Player-Id from
   * the request headers (set by the authenticated Worker, or absent
   * for internal system calls). Never trust request bodies or query
   * params. Returns a Response on auth failure; null means "system
   * action — no authenticated player".
   */
  private trustedPlayerId(request: Request): string | null | Response {
    const header = request.headers.get('X-Player-Id');
    const playerId = header && header.length > 0 ? header : null;
    if (playerId !== null && this._meta && !this._meta.playerIds.includes(playerId)) {
      return Response.json({ error: 'Not a player in this game' }, { status: 403 });
    }
    return playerId;
  }

  private async handleResult(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });
    if (!this._plugin.isOver(this._state as any)) {
      return Response.json({ error: 'Game not finished yet' }, { status: 409 });
    }

    const leaves: MerkleLeafData[] = this._actionLog.map((e, i) => ({
      actionIndex: i,
      playerId: e.playerId,
      actionData: JSON.stringify(e.action),
    }));
    const tree = buildActionMerkleTree(leaves);

    const config = {
      gameType: this._meta.gameType,
      playerIds: this._meta.playerIds,
      handleMap: this._meta.handleMap,
      teamMap: this._meta.teamMap,
      createdAt: this._meta.createdAt,
    };
    const configJson = JSON.stringify(config, Object.keys(config).sort());
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(configJson));
    const configHash = '0x' + Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    return Response.json({
      gameType: this._meta.gameType,
      playerIds: this._meta.playerIds,
      outcome: this._plugin.getOutcome(this._state),
      movesRoot: tree.root,
      turnCount: this._actionLog.length,
      timestamp: Date.now(),
      configHash,
    });
  }

  private async handleBundle(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });
    if (!this._plugin.isOver(this._state as any)) {
      return Response.json({ error: 'Game not finished yet' }, { status: 409 });
    }

    const config = {
      gameType: this._meta.gameType,
      playerIds: this._meta.playerIds,
      handleMap: this._meta.handleMap,
      teamMap: this._meta.teamMap,
      createdAt: this._meta.createdAt,
    };

    const turns = this._actionLog.map((entry, i) => ({
      turnNumber: i,
      moves: [{
        player: this._meta!.handleMap[entry.playerId] || entry.playerId,
        data: JSON.stringify(entry.action),
        signature: '',
      }],
      result: null,
    }));

    return Response.json({ config, turns });
  }

  private async handleSpectator(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });
    return Response.json(this.buildSpectatorMessage());
  }

  private async handleReplay(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });

    const idx = this.publicSnapshotIndex();
    if (idx === null) {
      // Pre-window: delay hasn't elapsed yet. Nothing public to show.
      return Response.json({
        type: 'spectator_pending',
        gameType: this._meta.gameType,
        gameId: this._meta.gameId,
        handles: this._meta.handleMap,
        teamMap: this._meta.teamMap,
        finished: false,
        progressCounter: null,
        snapshots: [],
      });
    }

    // Raw _relay is NOT returned: it contains DMs, team chat, and per-turn
    // cadence. Chat a spectator is entitled to read is already baked into
    // the snapshots themselves.
    return Response.json({
      type: 'replay',
      gameType: this._meta.gameType,
      gameId: this._meta.gameId,
      handles: this._meta.handleMap,
      teamMap: this._meta.teamMap,
      finished: this._meta.finished,
      progressCounter: idx,
      snapshots: this._spectatorSnapshots.slice(0, idx + 1),
    });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    await this.ensureLoaded();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // X-Player-Id is set by the Worker after validating the Bearer token.
    // Absent = spectator (no auth required).
    const playerId = request.headers.get('X-Player-Id');

    if (playerId) {
      // Authenticated player connection
      this.ctx.acceptWebSocket(server, [playerId]);
      if (this._meta && this._plugin) {
        server.send(JSON.stringify(this.buildPlayerMessage(playerId)));
      }
    } else {
      // Unauthenticated spectator connection
      this.ctx.acceptWebSocket(server, [TAG_SPECTATOR]);
      if (this._meta && this._plugin) {
        server.send(JSON.stringify(this.buildSpectatorMessage()));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Plugin tool call handler
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * POST /tool — accepts a pre-formed relay envelope.
   * Body: { relay: { type, data, scope, pluginId } }.
   * Sender identity comes from X-Player-Id (never the body).
   */
  private async handleTool(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta) return Response.json({ error: 'Game not found' }, { status: 404 });

    const playerId = this.trustedPlayerId(request);
    if (playerId instanceof Response) return playerId;
    if (playerId === null) {
      return Response.json({ error: 'X-Player-Id header required for tool calls' }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { relay } = body ?? {} as Record<string, unknown>;
    if (!relay) {
      return Response.json({ error: 'relay envelope is required' }, { status: 400 });
    }
    const relayObj = relay as Record<string, unknown>;
    if (!relayObj.type || !relayObj.pluginId) {
      return Response.json({ error: 'relay must have type and pluginId' }, { status: 400 });
    }

    if (relayObj.type === 'messaging') {
      const scopeError = validateChatScope(relayObj.scope as string | undefined, this._plugin?.chatScopes);
      if (scopeError) {
        return Response.json({ error: { code: 'INVALID_CHAT_SCOPE', message: scopeError } }, { status: 400 });
      }
    }

    try {
      const msg: RelayMessage = {
        index: this._relay.length,
        type: relayObj.type as string,
        data: relayObj.data ?? null,
        scope: (relayObj.scope as string) ?? 'all',
        pluginId: relayObj.pluginId as string,
        sender: playerId,
        turn: this._progress.counter,
        timestamp: Date.now(),
      };
      this._relay.push(msg);
      await this.ctx.storage.put('relay', this._relay);
      this.broadcastRelayMessage(msg);

      return Response.json({ ok: true, index: msg.index });
    } catch (err: any) {
      console.error(`[GameRoomDO] Error in handleTool:`, err);
      return Response.json({ error: 'Internal server error', details: String(err) }, { status: 500 });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Relay helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns relay messages visible to a given player, based on scope:
   *   'all'   → everyone
   *   'team'  → sender's teammates (same teamMap value)
   *   <other> → treat as a display handle; also accept exact playerId match
   *             (DM: only sender and recipient see it)
   */
  private getVisibleRelay(playerId: string | null): RelayMessage[] {
    if (!this._meta) return [];
    const team = playerId ? this._meta.teamMap[playerId] : null;
    const handle = playerId ? (this._meta.handleMap[playerId] ?? playerId) : null;

    return this._relay.filter(msg => {
      if (msg.scope === 'all') return true;

      if (msg.scope === 'team') {
        if (!playerId || !team) return false;
        const senderTeam = this._meta!.teamMap[msg.sender];
        return senderTeam && senderTeam === team;
      }

      // DM: scope is a handle or playerId
      // Visible to the sender and the recipient
      if (playerId === msg.sender) return true;
      // Scope matches recipient's handle
      if (handle && msg.scope === handle) return true;
      // Scope matches recipient's playerId directly
      if (msg.scope === playerId) return true;

      return false;
    });
  }

  /**
   * Resolve which playerIds should receive a relay message push.
   * Same scoping rules as getVisibleRelay, but returns the set of pids to push to.
   */
  private resolveRelayRecipients(msg: RelayMessage): string[] {
    if (!this._meta) return [];
    const { playerIds, teamMap, handleMap } = this._meta;

    if (msg.scope === 'all') return playerIds;

    if (msg.scope === 'team') {
      const senderTeam = teamMap[msg.sender];
      if (!senderTeam) return [];
      return playerIds.filter(pid => teamMap[pid] === senderTeam);
    }

    // DM: scope is a handle or playerId — find the recipient
    const recipientId = playerIds.find(pid =>
      pid === msg.scope || (handleMap[pid] ?? pid) === msg.scope
    );
    // Sender always sees their own DM; recipient gets it too
    const recipients = new Set<string>([msg.sender]);
    if (recipientId) recipients.add(recipientId);
    return [...recipients];
  }

  private broadcastRelayMessage(msg: RelayMessage): void {
    const recipients = this.resolveRelayRecipients(msg);
    for (const pid of recipients) {
      const conns = this.ctx.getWebSockets(pid);
      if (conns.length === 0) continue;
      const payload = JSON.stringify(this.buildPlayerMessage(pid));
      for (const ws of conns) {
        try { ws.send(payload); } catch {}
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Core game logic
  // ─────────────────────────────────────────────────────────────────────────

  private async applyActionInternal(
    playerId: string | null,
    action: unknown,
  ): Promise<{ success: boolean; error?: string; progressCounter?: number }> {
    if (!this._plugin || !this._meta) return { success: false, error: 'Game not loaded' };

    if (!this._plugin.validateAction(this._state, playerId, action)) {
      return { success: false, error: 'Invalid action' };
    }

    const result = this._plugin.applyAction(this._state, playerId, action);
    const prevState = this._state;
    this._state = result.state;
    this._actionLog.push({ playerId, action });

    // Deadline management
    if (result.deadline !== undefined) {
      if (result.deadline === null) {
        this._deadlineMs = null;
        await this.ctx.storage.delete('deadline');
        try { await this.ctx.storage.deleteAlarm(); } catch {}
      } else {
        const deadlineMs = Date.now() + result.deadline.seconds * 1000;
        this._deadlineMs = deadlineMs;
        await this.ctx.storage.put('deadline', { action: result.deadline.action, deadlineMs });
        await this.ctx.storage.setAlarm(deadlineMs);
      }
    }

    if (result.progressIncrement) {
      this._progress.counter++;
      this._progress.snapshots.push(this._actionLog.length - 1);

      // Capture spectator snapshot at this progress point
      // Include all relay messages up to this turn for chat replay
      const snapshotRelay = this._relay.filter(m => m.scope === 'all' || m.scope === 'team');
      const snapshotCtx = { handles: this._meta.handleMap, relayMessages: snapshotRelay };
      const snapshot = this._plugin.buildSpectatorView(this._state, prevState, snapshotCtx);
      this._spectatorSnapshots.push(snapshot);

      // Update cached summary in D1
      this.writeSummaryToD1();
    }

    const storagePuts: Promise<void>[] = [
      this.ctx.storage.put('state', this._state),
      this.ctx.storage.put('actionLog', this._actionLog),
      this.ctx.storage.put('progress', this._progress),
    ];
    if (result.progressIncrement) {
      const idx = this._spectatorSnapshots.length - 1;
      storagePuts.push(
        this.ctx.storage.put(`snapshot:${idx}`, this._spectatorSnapshots[idx]),
        this.ctx.storage.put('snapshotCount', this._spectatorSnapshots.length),
      );
    }
    await Promise.all(storagePuts);

    const finished = this._plugin.isOver(this._state as any);
    if (finished && !this._meta.finished) {
      this._meta.finished = true;
      await this.ctx.storage.put('meta', this._meta);
      try { await this.ctx.storage.deleteAlarm(); } catch {}
      await this.ctx.storage.delete('deadline');
      console.log(`[GameRoomDO] Game over — ${this._meta.gameType}, ${this._actionLog.length} actions`);
      // Write final summary (with finished=true reflected in game state)
      this.writeSummaryToD1();
      // Mark the game finished in D1. Player sessions still point at the
      // parent lobby (via player_sessions → lobbies.game_id), so state reads
      // continue to resolve here and return gameOver: true until the player
      // joins a new lobby (which UPDATEs their session pointer).
      try {
        await this.env.DB.prepare(
          'UPDATE games SET finished = 1 WHERE game_id = ?'
        ).bind(this._meta.gameId).run();
      } catch (err) {
        console.error(`[GameRoomDO] Failed to update D1 on game over:`, err);
      }
      // Settle on-chain (or against MockRelay in dev). ctx.waitUntil keeps the
      // isolate alive past this request's response; otherwise the Workers runtime
      // may hibernate the DO before the tx lands.
      this.ctx.waitUntil(this.settleOnChain());
    }

    this.broadcastUpdates();

    return { success: true, progressCounter: this._progress.counter };
  }

  /**
   * Anchor the finished game on-chain with credit deltas from the plugin.
   *
   * Server-side invariants (enforced before sending tx):
   *   • sum(deltas) === 0              — zero-sum; GameAnchor enforces this too
   *   • every delta ≥ -entryCost       — no player loses more than their stake
   *   • every player has chain_agent_id — only registered identities can settle
   *
   * If any invariant fails we log and skip — never throw, never attack chain.
   * MockRelay ignores deltas, so in dev mode this still exercises the path.
   */
  private async settleOnChain(): Promise<void> {
    if (!this._plugin || !this._meta) return;
    const gameId = this._meta.gameId;
    const { playerIds, gameType, handleMap, teamMap, createdAt } = this._meta;

    try {
      // Build merkle + configHash (same as before)
      const leaves: MerkleLeafData[] = this._actionLog.map((e: any, i: number) => ({
        actionIndex: i,
        playerId: e.playerId,
        actionData: JSON.stringify(e.action),
      }));
      const tree = buildActionMerkleTree(leaves);

      const config = { gameType, playerIds, handleMap, teamMap, createdAt };
      const configJson = JSON.stringify(config, Object.keys(config).sort());
      const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(configJson));
      const configHash = '0x' + Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      const outcome = this._plugin.getOutcome(this._state);
      const entryCost = this._plugin.entryCost;
      const payouts = this._plugin.computePayouts(outcome, playerIds, entryCost);

      // Build delta array in playerIds order; default to 0 for any missing entry
      const deltas: { agentId: string; delta: number }[] = playerIds.map(id => ({
        agentId: id,
        delta: payouts.get(id) ?? 0,
      }));

      // Invariant 1: zero-sum
      const sum = deltas.reduce((acc, d) => acc + d.delta, 0);
      if (sum !== 0) {
        console.error(`[settle ${gameId}] skip: non-zero-sum deltas sum=${sum}`, deltas);
        return;
      }

      // Invariant 2: no player loses more than their stake
      const floorViolation = deltas.find(d => d.delta < -entryCost);
      if (floorViolation) {
        console.error(
          `[settle ${gameId}] skip: delta ${floorViolation.delta} < -entryCost(${entryCost}) for ${floorViolation.agentId}`,
          deltas,
        );
        return;
      }

      // Invariant 3: all players must have an on-chain identity (in on-chain mode).
      // MockRelay doesn't use chain_agent_id — skip this check when RPC_URL is unset.
      if (this.env.RPC_URL) {
        const rows = await this.env.DB.prepare(
          `SELECT id, chain_agent_id FROM players WHERE id IN (${playerIds.map(() => '?').join(',')})`
        ).bind(...playerIds).all<{ id: string; chain_agent_id: number | null }>();
        const chainMap = new Map((rows.results ?? []).map(r => [r.id, r.chain_agent_id]));
        const unregistered = playerIds.filter(id => !chainMap.get(id));
        if (unregistered.length > 0) {
          console.warn(
            `[settle ${gameId}] skip: ${unregistered.length}/${playerIds.length} players lack chain_agent_id`,
            unregistered,
          );
          return;
        }
      }

      const { createRelay } = await import('../chain/index.js');
      const relay = createRelay(this.env);

      // merkle.ts returns un-prefixed hex; viem needs 0x-prefixed for bytes32.
      const movesRoot = tree.root.startsWith('0x') ? tree.root : `0x${tree.root}`;

      const receipt = await relay.settleGame({
        gameId,
        gameType,
        playerIds,
        outcome,
        movesRoot,
        configHash,
        turnCount: this._actionLog.length,
        timestamp: Date.now(),
      }, deltas);

      console.log(`[settle ${gameId}] ok tx=${receipt.txHash ?? 'mock'} deltas=${JSON.stringify(deltas)}`);
    } catch (err) {
      console.error(`[settle ${gameId}] failed:`, err);
    }
  }

  /**
   * Fire-and-forget D1 upsert of the public game summary. Gated by
   * publicSnapshotIndex so /api/games never reveals a turn ahead of
   * what the spectator view has caught up to.
   */
  private writeSummaryToD1(): void {
    if (!this._meta || !this._plugin) return;

    const idx = this.publicSnapshotIndex();
    if (idx === null) return;

    const publicSnapshot = this._spectatorSnapshots[idx];
    let summary: Record<string, any> = {};
    if (typeof this._plugin.getSummaryFromSpectator === 'function') {
      summary = this._plugin.getSummaryFromSpectator(publicSnapshot);
    } else if (typeof this._plugin.getSummary === 'function') {
      // Plugins that omit getSummaryFromSpectator must have a spectator
      // shape that getSummary can read directly (same field names).
      summary = this._plugin.getSummary(publicSnapshot as any);
    }
    const json = JSON.stringify(summary);
    // Fire-and-forget: catch all errors to prevent unhandled rejections
    (async () => {
      try {
        await this.env.DB.prepare(
          `INSERT INTO game_summaries (game_id, progress_counter, summary_json, updated_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(game_id) DO UPDATE SET
             progress_counter = ?2, summary_json = ?3, updated_at = datetime('now')`
        ).bind(this._meta!.gameId, idx, json).run();
      } catch (err: any) {
        // Auto-create table if it doesn't exist yet (migration not applied)
        if (String(err).includes('no such table')) {
          try {
            await this.env.DB.exec(
              `CREATE TABLE IF NOT EXISTS game_summaries (
                game_id TEXT PRIMARY KEY REFERENCES games(game_id),
                progress_counter INTEGER NOT NULL DEFAULT 0,
                summary_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL DEFAULT (datetime('now')))`
            );
            // Retry the upsert
            await this.env.DB.prepare(
              `INSERT INTO game_summaries (game_id, progress_counter, summary_json, updated_at)
               VALUES (?1, ?2, ?3, datetime('now'))
               ON CONFLICT(game_id) DO UPDATE SET
                 progress_counter = ?2, summary_json = ?3, updated_at = datetime('now')`
            ).bind(this._meta!.gameId, idx, json).run();
          } catch (e) {
            console.error(`[GameRoomDO] Failed to auto-create game_summaries:`, e);
          }
        } else {
          console.error(`[GameRoomDO] Failed to write summary:`, err);
        }
      }
    })().catch((err) => {
      // Final catch-all to prevent unhandled rejections
      console.error(`[GameRoomDO] Unhandled error in writeSummaryToD1:`, err);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message builders
  // ─────────────────────────────────────────────────────────────────────────

  private buildPlayerMessage(playerId: string | null): object {
    const finished = this._plugin!.isOver(this._state as any);
    const visible = this._plugin!.getVisibleState(this._state, playerId);
    const relayMessages = this.getVisibleRelay(playerId);
    // Tool discovery: mirror LobbyDO.buildState() currentPhase.tools shape so
    // CLI + MCP consume one uniform surface. Today every game has one game
    // phase — when GamePhase[] lands, this becomes the current GamePhase's
    // {id, name, tools}.
    const currentPhase = {
      id: 'game',
      name: 'Game',
      tools: this._plugin!.gameTools ?? [],
    };
    return {
      type: 'state_update',
      gameOver: finished,
      gameType: this._meta!.gameType,
      handles: this._meta!.handleMap,
      progressCounter: this._progress.counter,
      relayMessages,
      currentPhase,
      ...(visible as Record<string, unknown>),
    };
  }

  /**
   * Highest snapshot index a caller without player-level authorisation
   * may see. `null` pre-window. Sole gate for every public emission —
   * spectator WS, /spectator, /replay, /api/games summary.
   */
  private publicSnapshotIndex(): number | null {
    if (!this._meta) return null;
    return computePublicSnapshotIndex(
      this._spectatorSnapshots.length,
      this._meta.finished,
      this._meta.spectatorDelay ?? 0,
    );
  }

  private buildSpectatorMessage(): object {
    const idx = this.publicSnapshotIndex();
    if (idx === null) {
      return {
        type: 'spectator_pending',
        gameType: this._meta!.gameType,
        handles: this._meta!.handleMap,
        progressCounter: null,
      };
    }
    const snapshot = this._spectatorSnapshots[idx] as Record<string, unknown>;
    return {
      type: 'state_update',
      gameType: this._meta!.gameType,
      handles: this._meta!.handleMap,
      progressCounter: idx,
      ...snapshot,
    };
  }

  private broadcastUpdates(): void {
    if (!this._meta || !this._plugin) return;

    try {
      // Push to spectators only on public-index advance — prevents
      // counting push events to infer hidden action cadence.
      const idx = this.publicSnapshotIndex();
      if (idx !== this._lastSpectatorIdx) {
        const spectatorMsg = JSON.stringify(this.buildSpectatorMessage());
        for (const ws of this.ctx.getWebSockets(TAG_SPECTATOR)) {
          try { ws.send(spectatorMsg); } catch {}
        }
        this._lastSpectatorIdx = idx;
      }

      for (const pid of this._meta.playerIds) {
        const playerConns = this.ctx.getWebSockets(pid);
        if (playerConns.length === 0) continue;
        const playerMsg = JSON.stringify(this.buildPlayerMessage(pid));
        for (const ws of playerConns) {
          try { ws.send(playerMsg); } catch {}
        }
      }
    } catch (err) {
      // Don't let broadcast errors crash the alarm handler / action pipeline
      console.error('[GameRoomDO] broadcastUpdates failed:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State loading
  // ─────────────────────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this._loaded) return;
      const [meta, state, actionLog, progress, relay, deadline, config, snapshotCount] = await Promise.all([
        this.ctx.storage.get<GameMeta>('meta'),
        this.ctx.storage.get<unknown>('state'),
        this.ctx.storage.get<ActionEntry[]>('actionLog'),
        this.ctx.storage.get<ProgressState>('progress'),
        this.ctx.storage.get<RelayMessage[]>('relay'),
        this.ctx.storage.get<DeadlineEntry>('deadline'),
        this.ctx.storage.get<unknown>('config'),
        this.ctx.storage.get<number>('snapshotCount'),
      ]);

      // Drop the legacy prevProgressState key from older games.
      this.ctx.storage.delete('prevProgressState').catch(() => {});

      if (!meta) { this._loaded = true; return; }

      const plugin = getGame(meta.gameType);
      if (!plugin) {
        console.error(`[GameRoomDO] Unknown game type on load: ${meta.gameType}`);
        this._loaded = true;
        return;
      }

      // Load individual snapshot keys
      const count = snapshotCount ?? 0;
      let loadedSnapshots: unknown[] = [];
      if (count > 0) {
        const snapshotKeys = Array.from({ length: count }, (_, i) => `snapshot:${i}`);
        const snapshotMap = await this.ctx.storage.get<unknown>(snapshotKeys);
        loadedSnapshots = snapshotKeys.map(k => snapshotMap.get(k)).filter(Boolean) as unknown[];
      }

      // Back-fill for games created before this field was persisted.
      if (typeof meta.spectatorDelay !== 'number') {
        meta.spectatorDelay = plugin.spectatorDelay ?? 0;
      }

      this._meta = meta;
      this._plugin = plugin;
      this._state = state ?? null;
      this._actionLog = actionLog ?? [];
      this._progress = progress ?? { counter: 0, snapshots: [0] };
      this._relay = relay ?? [];
      this._deadlineMs = deadline?.deadlineMs ?? null;
      this._config = config ?? null;
      this._spectatorSnapshots = loadedSnapshots;
      this._loaded = true;
    });
  }
}
