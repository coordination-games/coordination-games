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
    if (method === 'GET'  && path === '/state') return this.handleState(url);
    if (method === 'GET'  && path === '/result') return this.handleResult();
    if (method === 'GET'  && path === '/spectator') return this.handleSpectator();

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

    await this.ctx.storage.delete('deadline');
    if (Date.now() < deadline.deadlineMs - 500) {
      // Fired too early (clock drift) — re-arm
      await this.ctx.storage.setAlarm(deadline.deadlineMs);
      await this.ctx.storage.put('deadline', deadline);
      return;
    }

    console.log(`[GameRoomDO] Alarm fired — applying deadline action`);
    await this.applyActionInternal(null, deadline.action);
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

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { gameType, config, playerIds, handleMap, teamMap } = body ?? {};
    if (!gameType || !config || !Array.isArray(playerIds)) {
      return Response.json({ error: 'gameType, config, and playerIds are required' }, { status: 400 });
    }

    const plugin = getGame(gameType);
    if (!plugin) return Response.json({ error: `Unknown game type: ${gameType}` }, { status: 400 });

    let initialState: unknown;
    try { initialState = plugin.createInitialState(config); }
    catch (err: any) {
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

    this._meta = meta;
    this._plugin = plugin;
    this._state = initialState;
    this._prevProgressState = null;
    this._actionLog = [];
    this._progress = progress;
    this._loaded = true;

    console.log(`[GameRoomDO] Created ${gameType} game, ${playerIds.length} players`);
    return Response.json({ ok: true, gameType, playerCount: playerIds.length });
  }

  private async handleAction(request: Request): Promise<Response> {
    await this.ensureLoaded();
    if (!this._meta) return Response.json({ error: 'Game not found' }, { status: 404 });
    if (this._meta.finished) return Response.json({ error: 'Game already finished' }, { status: 410 });

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { playerId, action } = body ?? {};
    if (action === undefined) return Response.json({ error: 'action is required' }, { status: 400 });

    return Response.json(await this.applyActionInternal(playerId ?? null, action));
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
    return Response.json(this.buildSpectatorMessage());
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

    // Deadline management
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

    await Promise.all([
      this.ctx.storage.put('state', this._state),
      this.ctx.storage.put('prevProgressState', this._prevProgressState),
      this.ctx.storage.put('actionLog', this._actionLog),
      this.ctx.storage.put('progress', this._progress),
    ]);

    const finished = this._plugin.isOver(this._state as any);
    if (finished && !this._meta.finished) {
      this._meta.finished = true;
      await this.ctx.storage.put('meta', this._meta);
      try { await this.ctx.storage.deleteAlarm(); } catch {}
      await this.ctx.storage.delete('deadline');
      console.log(`[GameRoomDO] Game over — ${this._meta.gameType}, ${this._actionLog.length} actions`);
    }

    this.broadcastUpdates();

    return { success: true, progressCounter: this._progress.counter };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message builders
  // ─────────────────────────────────────────────────────────────────────────

  private buildPlayerMessage(playerId: string | null): object {
    const finished = this._plugin!.isOver(this._state as any);
    const visible = this._plugin!.getVisibleState(this._state, playerId);
    return {
      type: 'state_update',
      gameOver: finished,
      gameType: this._meta!.gameType,
      handles: this._meta!.handleMap,
      progressCounter: this._progress.counter,
      relayMessages: [],  // Phase 5 wires relay messages
      ...(visible as any),
    };
  }

  private buildSpectatorMessage(): object {
    const delay = this._plugin!.spectatorDelay ?? 0;
    const ctx = { handles: this._meta!.handleMap, relayMessages: [] };
    const view = delay > 0 && this._prevProgressState
      ? this._plugin!.buildSpectatorView(this._prevProgressState, null, ctx)
      : this._plugin!.buildSpectatorView(this._state, this._prevProgressState, ctx);
    return {
      type: 'state_update',
      gameType: this._meta!.gameType,
      handles: this._meta!.handleMap,
      progressCounter: this._progress.counter,
      ...(view as any),
    };
  }

  private broadcastUpdates(): void {
    if (!this._meta || !this._plugin) return;

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
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State loading
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
