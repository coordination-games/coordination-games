/**
 * GameRoomDO — Durable Object for a single live game.
 *
 * Replaces packages/engine/src/game-session.ts (GameRoom) with a DO-native
 * equivalent: game state lives in transactional DO storage, turn deadlines
 * use DO alarms, spectator WS connections use the hibernatable API.
 *
 * HTTP routes (sub-path after the main Worker strips /games/:id):
 *   POST /          — create game { gameType, config, playerIds, handleMap, teamMap }
 *   POST /action    — apply action { playerId, action }
 *   GET  /state     — visible state  ?playerId=X
 *   GET  /wait      — poll for update ?playerId=X&since=N
 *   GET  /result    — Merkle root + outcome (only when finished)
 *   GET  /spectator — delayed spectator view (no auth required)
 *   WS   /          — upgrade → hibernatable spectator WS
 */

import { DurableObject } from 'cloudflare:workers';
import { getGame, buildActionMerkleTree } from '@coordination-games/engine';
import type { CoordinationGame, MerkleLeafData } from '@coordination-games/engine';
import type { Env } from '../env.js';

// Side-effect imports: each calls registerGame() on module load
import '@coordination-games/game-ctl';
import '@coordination-games/game-oathbreaker';

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

interface GameMeta {
  gameType: string;
  playerIds: string[];
  handleMap: Record<string, string>;   // playerId → display handle
  teamMap: Record<string, string>;     // playerId → 'A' | 'B' | 'FFA'
  createdAt: string;
  finished: boolean;
}

interface ProgressState {
  counter: number;
  /** History index of each progress snapshot, for spectator delay. */
  snapshots: number[];
}

interface ActionEntry {
  playerId: string | null;
  action: unknown;
}

interface DeadlineEntry {
  action: unknown;
  deadlineMs: number;
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
  /** Only the state at the previous progress point (for delay=1 spectator view). */
  private _prevProgressState: unknown = null;
  private _actionLog: ActionEntry[] = [];
  private _progress: ProgressState = { counter: 0, snapshots: [0] };

  // ─────────────────────────────────────────────────────────────────────────
  // fetch() — main HTTP + WS entry point
  // ─────────────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/\/$/, '') || '/';

    // WebSocket upgrade → hibernatable spectator WS
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return this.handleWebSocket();
    }

    if (method === 'POST' && path === '/') return this.handleCreate(request);
    if (method === 'POST' && path === '/action') return this.handleAction(request);
    if (method === 'GET'  && path === '/state') return this.handleState(url);
    if (method === 'GET'  && path === '/wait') return this.handleWait(url);
    if (method === 'GET'  && path === '/result') return this.handleResult();
    if (method === 'GET'  && path === '/spectator') return this.handleSpectator();

    return new Response('Not found', { status: 404 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // alarm() — fires for turn deadlines
  // ─────────────────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return;

    const deadline = await this.ctx.storage.get<DeadlineEntry>('deadline');
    if (!deadline) return;

    await this.ctx.storage.delete('deadline');
    const now = Date.now();
    if (now < deadline.deadlineMs - 500) {
      // Fired too early (clock drift) — re-arm
      await this.ctx.storage.setAlarm(deadline.deadlineMs);
      await this.ctx.storage.put('deadline', deadline);
      return;
    }

    console.log(`[GameRoomDO] Alarm fired, applying deadline action`);
    await this.applyActionInternal(null, deadline.action);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket lifecycle (hibernatable)
  // ─────────────────────────────────────────────────────────────────────────

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Spectators are read-only; no incoming messages expected.
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // Nothing to clean up — Cloudflare removes the WS from getWebSockets() automatically.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Route handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleCreate(request: Request): Promise<Response> {
    if (this._meta) {
      return Response.json({ error: 'Game already created' }, { status: 409 });
    }

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { gameType, config, playerIds, handleMap, teamMap } = body ?? {};
    if (!gameType || !config || !Array.isArray(playerIds)) {
      return Response.json({ error: 'gameType, config, and playerIds are required' }, { status: 400 });
    }

    const plugin = getGame(gameType);
    if (!plugin) {
      return Response.json({ error: `Unknown game type: ${gameType}` }, { status: 400 });
    }

    let initialState: unknown;
    try {
      initialState = plugin.createInitialState(config);
    } catch (err: any) {
      return Response.json({ error: `createInitialState failed: ${err.message}` }, { status: 400 });
    }

    const meta: GameMeta = {
      gameType,
      playerIds: playerIds as string[],
      handleMap: handleMap ?? {},
      teamMap: teamMap ?? {},
      createdAt: new Date().toISOString(),
      finished: false,
    };
    const progress: ProgressState = { counter: 0, snapshots: [0] };

    await Promise.all([
      this.ctx.storage.put('meta', meta),
      this.ctx.storage.put('state', initialState),
      this.ctx.storage.put('prevProgressState', null),
      this.ctx.storage.put('actionLog', []),
      this.ctx.storage.put('progress', progress),
    ]);

    // Cache in memory
    this._meta = meta;
    this._plugin = plugin;
    this._state = initialState;
    this._prevProgressState = null;
    this._actionLog = [];
    this._progress = progress;
    this._loaded = true;

    console.log(`[GameRoomDO] Created ${gameType} game with ${playerIds.length} players`);

    return Response.json({ ok: true, gameType, playerCount: playerIds.length });
  }

  private async handleAction(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta) return Response.json({ error: 'Game not found' }, { status: 404 });
    if (this._meta.finished) return Response.json({ error: 'Game is already finished' }, { status: 410 });

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { playerId, action } = body ?? {};
    if (action === undefined) {
      return Response.json({ error: 'action is required' }, { status: 400 });
    }

    const result = await this.applyActionInternal(playerId ?? null, action);
    return Response.json(result);
  }

  private async handleState(url: URL): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });

    const playerId = url.searchParams.get('playerId') ?? null;
    const visible = this._plugin.getVisibleState(this._state, playerId);
    const finished = this._plugin.isOver(this._state as any);

    return Response.json({
      phase: finished ? 'finished' : 'game',
      gameOver: finished,
      gameType: this._meta.gameType,
      handles: this._meta.handleMap,
      progressCounter: this._progress.counter,
      relayMessages: [],
      ...(visible as any),
    });
  }

  private async handleWait(url: URL): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });

    const playerId = url.searchParams.get('playerId') ?? null;
    const since = parseInt(url.searchParams.get('since') ?? '-1', 10);
    const finished = this._plugin.isOver(this._state as any);

    if (finished) {
      const visible = this._plugin.getVisibleState(this._state, playerId);
      return Response.json({
        reason: 'game_over',
        gameOver: true,
        gameType: this._meta.gameType,
        handles: this._meta.handleMap,
        progressCounter: this._progress.counter,
        relayMessages: [],
        ...(visible as any),
      });
    }

    // Progress advanced since caller's last known counter → return state immediately
    if (since < this._progress.counter) {
      const visible = this._plugin.getVisibleState(this._state, playerId);
      return Response.json({
        reason: 'turn_changed',
        gameType: this._meta.gameType,
        handles: this._meta.handleMap,
        progressCounter: this._progress.counter,
        relayMessages: [],
        ...(visible as any),
      });
    }

    // Nothing new — caller should retry after a short delay.
    // NOTE: DO requests are sequential; we can't block here for 25s.
    // The CLI/coga already handles this with short polling.
    return Response.json({ reason: 'no_update', progressCounter: this._progress.counter });
  }

  private async handleResult(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });
    if (!this._plugin.isOver(this._state as any)) {
      return Response.json({ error: 'Game is not finished yet' }, { status: 409 });
    }

    const leaves: MerkleLeafData[] = this._actionLog.map((entry, index) => ({
      actionIndex: index,
      playerId: entry.playerId,
      actionData: JSON.stringify(entry.action),
    }));
    const tree = buildActionMerkleTree(leaves);

    return Response.json({
      gameType: this._meta.gameType,
      playerIds: this._meta.playerIds,
      outcome: this._plugin.getOutcome(this._state),
      actionsRoot: tree.root,
      actionCount: this._actionLog.length,
      timestamp: Date.now(),
    });
  }

  private async handleSpectator(): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta || !this._plugin) return Response.json({ error: 'Game not found' }, { status: 404 });

    const delay = this._plugin.spectatorDelay ?? 0;
    const ctx = { handles: this._meta.handleMap, relayMessages: [] };
    const view = this.buildSpectatorView(delay, ctx);

    return Response.json({
      gameType: this._meta.gameType,
      handles: this._meta.handleMap,
      progressCounter: this._progress.counter,
      ...(view as any),
    });
  }

  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);

    // Send initial state if game is already running
    if (this._meta && this._plugin) {
      const delay = this._plugin.spectatorDelay ?? 0;
      const ctx = { handles: this._meta.handleMap, relayMessages: [] };
      const view = this.buildSpectatorView(delay, ctx);
      try {
        server.send(JSON.stringify({
          type: 'state_update',
          data: { gameType: this._meta.gameType, handles: this._meta.handleMap, ...(view as any) },
        }));
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
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

    if (result.progressIncrement) {
      this._prevProgressState = prevState;
      this._progress.counter++;
      this._progress.snapshots.push(this._actionLog.length - 1);
    }

    // Handle deadline
    if (result.deadline !== undefined) {
      if (result.deadline === null) {
        await this.ctx.storage.delete('deadline');
        try { await this.ctx.storage.deleteAlarm(); } catch {}
      } else {
        const deadlineMs = Date.now() + result.deadline.seconds * 1000;
        await this.ctx.storage.put('deadline', { action: result.deadline.action, deadlineMs });
        await this.ctx.storage.setAlarm(deadlineMs);
      }
    }

    // Persist
    await Promise.all([
      this.ctx.storage.put('state', this._state),
      this.ctx.storage.put('prevProgressState', this._prevProgressState),
      this.ctx.storage.put('actionLog', this._actionLog),
      this.ctx.storage.put('progress', this._progress),
    ]);

    // Game over?
    const finished = this._plugin.isOver(this._state as any);
    if (finished && !this._meta.finished) {
      this._meta.finished = true;
      await this.ctx.storage.put('meta', this._meta);
      try { await this.ctx.storage.deleteAlarm(); } catch {}
      await this.ctx.storage.delete('deadline');
      console.log(`[GameRoomDO] Game over — ${this._meta.gameType}, ${this._actionLog.length} actions`);
    }

    // Broadcast to hibernated spectator WS connections
    this.broadcastToSpectators();

    return { success: true, progressCounter: this._progress.counter };
  }

  private buildSpectatorView(delay: number, ctx: { handles: Record<string, string>; relayMessages: any[] }): unknown {
    if (!this._plugin) return null;
    if (delay <= 0 || !this._prevProgressState) {
      return this._plugin.buildSpectatorView(this._state, this._prevProgressState, ctx);
    }
    // delay >= 1: show state from the previous progress point
    return this._plugin.buildSpectatorView(this._prevProgressState, null, ctx);
  }

  private broadcastToSpectators(): void {
    if (!this._meta || !this._plugin) return;
    const delay = this._plugin.spectatorDelay ?? 0;
    const ctx = { handles: this._meta.handleMap, relayMessages: [] };
    const view = this.buildSpectatorView(delay, ctx);
    const msg = JSON.stringify({
      type: 'state_update',
      data: { gameType: this._meta.gameType, handles: this._meta.handleMap, ...(view as any) },
    });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State loading (lazy, cached per DO instance)
  // ─────────────────────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this._loaded) return;
      const [meta, state, prevProgressState, actionLog, progress] = await Promise.all([
        this.ctx.storage.get<GameMeta>('meta'),
        this.ctx.storage.get<unknown>('state'),
        this.ctx.storage.get<unknown>('prevProgressState'),
        this.ctx.storage.get<ActionEntry[]>('actionLog'),
        this.ctx.storage.get<ProgressState>('progress'),
      ]);

      if (!meta) { this._loaded = true; return; }

      const plugin = getGame(meta.gameType);
      if (!plugin) {
        console.error(`[GameRoomDO] Unknown game type on load: ${meta.gameType}`);
        this._loaded = true;
        return;
      }

      this._meta = meta;
      this._plugin = plugin;
      this._state = state ?? null;
      this._prevProgressState = prevProgressState ?? null;
      this._actionLog = actionLog ?? [];
      this._progress = progress ?? { counter: 0, snapshots: [0] };
      this._loaded = true;
    });
  }
}
