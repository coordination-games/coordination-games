/**
 * GameRoomDO — Durable Object for a single live game.
 *
 * State lives in transactional DO storage. Turn deadlines use DO alarms.
 * All real-time updates (both players and browser spectators) use hibernatable
 * WebSockets tagged by role so the right view goes to the right connection.
 *
 * HTTP routes (sub-path, forwarded from the main Worker):
 *   POST /          — create game { gameType, config, playerIds, handleMap, teamMap }
 *   POST /action    — apply action { playerId, action }
 *   GET  /state     — fog-filtered state  ?playerId=X
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
import { getGame, buildActionMerkleTree } from '@coordination-games/engine';
import type { CoordinationGame, MerkleLeafData } from '@coordination-games/engine';
import type { Env } from '../env.js';

// Side-effect imports: each calls registerGame() on module load
import '@coordination-games/game-comedy-of-the-commons';
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
  private _prevProgressState: unknown = null;  // state at last progress point (spectator delay)
  private _actionLog: ActionEntry[] = [];
  private _progress: ProgressState = { counter: 0, snapshots: [0] };
  private _relay: RelayMessage[] = [];
  private _deadlineMs: number | null = null;
  private _config: unknown = null;  // game config (for replay reconstruction)
  private _spectatorSnapshots: unknown[] = [];  // spectator view at each progress point

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
    if (method === 'GET'  && path === '/state') return this.handleState(url);
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

    const gameId = (bodyGameId as string | undefined) ?? (this.ctx.id.name ?? '');
    const meta: GameMeta = {
      gameId,
      gameType,
      playerIds: playerIds as string[],
      handleMap: (handleMap as Record<string, string>) ?? {},
      teamMap: (teamMap as Record<string, string>) ?? {},
      createdAt: new Date().toISOString(),
      finished: false,
    };
    const progress: ProgressState = { counter: 0, snapshots: [0] };

    // Build initial spectator snapshot (turn 0)
    const initialCtx = { handles: meta.handleMap, relayMessages: [] };
    const initialSnapshot = plugin.buildSpectatorView(initialState, null, initialCtx);

    await Promise.all([
      this.ctx.storage.put('meta', meta),
      this.ctx.storage.put('state', initialState),
      this.ctx.storage.put('prevProgressState', null),
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
    this._prevProgressState = null;
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

    const { playerId, action } = body ?? {} as Record<string, unknown>;
    if (action === undefined) return Response.json({ error: 'action is required' }, { status: 400 });

    try {
      return Response.json(await this.applyActionInternal((playerId as string) ?? null, action));
    } catch (err: any) {
      console.error(`[GameRoomDO] Error in applyActionInternal:`, err?.stack ?? err);
      return Response.json({ error: 'Internal server error', details: String(err), stack: err?.stack ?? '' }, { status: 500 });
    }
  }

  private async handleState(url: URL): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });

    const playerId = url.searchParams.get('playerId') ?? null;
    return Response.json(this.buildPlayerMessage(playerId));
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

    // If no snapshots stored (pre-feature game), return what we can
    if (this._spectatorSnapshots.length === 0) {
      // Build a single snapshot from current state as fallback
      const ctx = { handles: this._meta.handleMap, relayMessages: this._relay };
      const current = this._plugin.buildSpectatorView(this._state, this._prevProgressState, ctx);
      return Response.json({
        gameType: this._meta.gameType,
        gameId: this._meta.gameId,
        handles: this._meta.handleMap,
        teamMap: this._meta.teamMap,
        finished: this._meta.finished,
        progressCounter: this._progress.counter,
        snapshots: [current],
        relay: this._relay,
      });
    }

    return Response.json({
      gameType: this._meta.gameType,
      gameId: this._meta.gameId,
      handles: this._meta.handleMap,
      teamMap: this._meta.teamMap,
      finished: this._meta.finished,
      progressCounter: this._progress.counter,
      snapshots: this._spectatorSnapshots,
      relay: this._relay,
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
   * POST /tool — accepts a pre-formed relay envelope from the CLI.
   * Body: { relay: { type, data, scope, pluginId }, playerId }
   *
   * The CLI calls plugin.handleCall() locally and sends us the result.
   * We are a dumb pipe: store it, route it by scope, push WS updates.
   * No server-side plugin registry needed.
   */
  private async handleTool(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta) return Response.json({ error: 'Game not found' }, { status: 404 });

    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { relay, playerId } = body ?? {} as Record<string, unknown>;
    if (!relay || !playerId) {
      return Response.json({ error: 'relay envelope and playerId are required' }, { status: 400 });
    }
    const relayObj = relay as Record<string, unknown>;
    if (!relayObj.type || !relayObj.pluginId) {
      return Response.json({ error: 'relay must have type and pluginId' }, { status: 400 });
    }

    try {
      const msg: RelayMessage = {
        index: this._relay.length,
        type: relayObj.type as string,
        data: relayObj.data ?? null,
        scope: (relayObj.scope as string) ?? 'all',
        pluginId: relayObj.pluginId as string,
        sender: playerId as string,
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
      this._prevProgressState = prevState;
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
      this.ctx.storage.put('prevProgressState', this._prevProgressState),
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
      // Update D1: mark game finished. Keep game_sessions so players can
      // still fetch the final state with gameOver: true. Sessions are replaced
      // automatically when the player joins a new game (INSERT OR REPLACE).
      try {
        await this.env.DB.prepare(
          'UPDATE games SET finished = 1 WHERE game_id = ?'
        ).bind(this._meta.gameId).run();
      } catch (err) {
        console.error(`[GameRoomDO] Failed to update D1 on game over:`, err);
      }
      // Fire-and-forget: settle game on-chain if relay is configured
      (async () => {
        try {
          const { createRelay } = await import('../chain/index.js');
          const relay = createRelay(this.env);

          // Build settlement data
          const leaves: MerkleLeafData[] = this._actionLog.map((e: any, i: number) => ({
            actionIndex: i,
            playerId: e.playerId,
            actionData: JSON.stringify(e.action),
          }));
          const tree = buildActionMerkleTree(leaves);

          const config = {
            gameType: this._meta!.gameType,
            playerIds: this._meta!.playerIds,
            handleMap: this._meta!.handleMap,
            teamMap: this._meta!.teamMap,
            createdAt: this._meta!.createdAt,
          };
          const configJson = JSON.stringify(config, Object.keys(config).sort());
          const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(configJson));
          const configHash = '0x' + Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

          const outcome = this._plugin!.getOutcome(this._state);

          // Build credit deltas from outcome (game plugin determines who wins/loses credits)
          // For now, empty deltas — credit changes will be added when games have entry fees
          const deltas: { agentId: string; delta: number }[] = [];

          await relay.settleGame({
            gameId: this._meta!.gameId,
            gameType: this._meta!.gameType,
            playerIds: this._meta!.playerIds,
            outcome,
            movesRoot: tree.root,
            configHash,
            turnCount: this._actionLog.length,
            timestamp: Date.now(),
          }, deltas);

          console.log(`[GameRoomDO] Game ${this._meta!.gameId} settled on-chain`);
        } catch (err) {
          console.error(`[GameRoomDO] On-chain settlement failed (will retry via cron):`, err);
        }
      })();
    }

    this.broadcastUpdates();

    return { success: true, progressCounter: this._progress.counter };
  }

  /** Fire-and-forget upsert of game summary into D1 for the listing page. */
  private writeSummaryToD1(): void {
    if (!this._meta || !this._plugin) return;
    const summary = typeof this._plugin.getSummary === 'function'
      ? this._plugin.getSummary(this._state)
      : {};
    const json = JSON.stringify(summary);
    // Fire-and-forget: catch all errors to prevent unhandled rejections
    (async () => {
      try {
        await this.ensureGameRowInD1();
        await this.env.DB.prepare(
          `INSERT INTO game_summaries (game_id, progress_counter, summary_json, updated_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(game_id) DO UPDATE SET
             progress_counter = ?2, summary_json = ?3, updated_at = datetime('now')`
        ).bind(this._meta!.gameId, this._progress.counter, json).run();
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
            ).bind(this._meta!.gameId, this._progress.counter, json).run();
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

  /** Ensure the parent games row exists before summary writes that FK-reference it. */
  private async ensureGameRowInD1(): Promise<void> {
    if (!this._meta) return;
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO games (game_id, game_type, finished, created_at)
       VALUES (?1, ?2, ?3, ?4)`
    ).bind(
      this._meta.gameId,
      this._meta.gameType,
      this._meta.finished ? 1 : 0,
      this._meta.createdAt,
    ).run();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message builders
  // ─────────────────────────────────────────────────────────────────────────

  private buildPlayerMessage(playerId: string | null): object {
    const finished = this._plugin!.isOver(this._state as any);
    const visible = this._plugin!.getVisibleState(this._state, playerId);
    const relayMessages = this.getVisibleRelay(playerId);
    return {
      type: 'state_update',
      gameOver: finished,
      gameType: this._meta!.gameType,
      handles: this._meta!.handleMap,
      progressCounter: this._progress.counter,
      relayMessages,
      ...(visible as Record<string, unknown>),
    };
  }

  private buildSpectatorMessage(): object {
    const delay = this._plugin!.spectatorDelay ?? 0;
    const finished = this._meta!.finished;
    // Spectators see only 'all'-scoped relay messages (no team chat)
    const relayMessages = this._relay.filter(m => m.scope === 'all');
    const ctx = { handles: this._meta!.handleMap, relayMessages };

    const view = delay > 0 && this._prevProgressState && !finished
      ? this._plugin!.buildSpectatorView(this._prevProgressState, null, ctx)
      : this._plugin!.buildSpectatorView(this._state, this._prevProgressState, ctx);

    return {
      type: 'state_update',
      gameType: this._meta!.gameType,
      handles: this._meta!.handleMap,
      progressCounter: this._progress.counter,
      ...(view as Record<string, unknown>),
    };
  }

  private broadcastUpdates(): void {
    if (!this._meta || !this._plugin) return;

    try {
      // Push delayed spectator view to all spectator connections
      const spectatorMsg = JSON.stringify(this.buildSpectatorMessage());
      for (const ws of this.ctx.getWebSockets(TAG_SPECTATOR)) {
        try { ws.send(spectatorMsg); } catch {}
      }

      // Push fog-filtered view to each player's connection(s)
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
      const [meta, state, prevProgressState, actionLog, progress, relay, deadline, config, snapshotCount] = await Promise.all([
        this.ctx.storage.get<GameMeta>('meta'),
        this.ctx.storage.get<unknown>('state'),
        this.ctx.storage.get<unknown>('prevProgressState'),
        this.ctx.storage.get<ActionEntry[]>('actionLog'),
        this.ctx.storage.get<ProgressState>('progress'),
        this.ctx.storage.get<RelayMessage[]>('relay'),
        this.ctx.storage.get<DeadlineEntry>('deadline'),
        this.ctx.storage.get<unknown>('config'),
        this.ctx.storage.get<number>('snapshotCount'),
      ]);

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

      this._meta = meta;
      this._plugin = plugin;
      this._state = state ?? null;
      this._prevProgressState = prevProgressState ?? null;
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
