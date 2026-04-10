/**
 * LobbyDO — Generic phase-running Durable Object for lobbies.
 *
 * Zero game-specific code. Delegates all game logic to LobbyPhase instances
 * declared by the game plugin via `plugin.lobby.phases[]`.
 *
 * Lifecycle: running → starting → game
 *                              ↘ failed
 *
 * HTTP routes (sub-path, forwarded from the main Worker):
 *   POST /           — create lobby { lobbyId, gameType, noTimeout? }
 *   GET  /state      — lobby state (?playerId=X for player-specific view)
 *   POST /join       — { playerId, handle, elo? }
 *   POST /action     — generic phase action { playerId, type, payload }
 *   POST /tool       — plugin tool call { playerId, pluginId, tool, args }
 *   POST /no-timeout — disable the phase timer
 *   DELETE /         — disband lobby
 *
 * WebSocket:
 *   WS / — spectator (no auth, receives lobby state updates)
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { getGame } from '@coordination-games/engine';
import type {
  LobbyPhase,
  PhaseActionResult,
  PhaseResult,
  AgentInfo,
} from '@coordination-games/engine';

// Side-effect imports — register game plugins with the engine registry
import '@coordination-games/game-ctl';
import '@coordination-games/game-oathbreaker';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_SPECTATOR = 'spectator';

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

interface LobbyMeta {
  lobbyId: string;
  gameType: string;
  currentPhaseIndex: number;
  accumulatedMetadata: Record<string, any>;
  phase: 'running' | 'starting' | 'game' | 'failed';
  deadlineMs: number | null;
  gameId: string | null;
  error: string | null;
  noTimeout: boolean;
  createdAt: number;
}

interface AgentEntry {
  id: string;
  handle: string;
  elo: number;
  joinedAt: number;
}

interface RelayMessage {
  index: number;
  type: string;
  data: unknown;
  scope: string;
  pluginId: string;
  sender: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// LobbyDO
// ---------------------------------------------------------------------------

export class LobbyDO extends DurableObject<Env> {
  private _loaded = false;
  private _meta: LobbyMeta | null = null;
  private _agents: AgentEntry[] = [];
  private _phaseState: any = null;
  private _relay: RelayMessage[] = [];

  // ─────────────────────────────────────────────────────────────────────────
  // fetch() — HTTP + WS entry point
  // ─────────────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      await this.ensureLoaded();
      return this.handleWebSocket();
    }

    // Create is allowed before loading (it's the initializer)
    if (method === 'POST' && path === '/') return this.handleCreate(request);

    await this.ensureLoaded();

    if (method === 'GET' && path === '/state') return this.handleGetState(url);
    if (method === 'POST' && path === '/join') return this.handleJoin(request);
    if (method === 'POST' && path === '/action') return this.handleAction(request);
    if (method === 'POST' && path === '/tool') return this.handleTool(request);
    if (method === 'POST' && path === '/no-timeout') return this.handleNoTimeout();
    if (method === 'DELETE' && path === '/') return this.handleDisband();

    return new Response('Not found', { status: 404 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // alarm() — phase timeout
  // ─────────────────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (!this._meta || this._meta.phase !== 'running') return;

    const phase = this.getCurrentPhase();
    if (!phase) {
      await this.failLobby('No current phase for timeout');
      return;
    }

    console.log(`[LobbyDO] Phase "${phase.id}" timeout — lobby ${this._meta.lobbyId}`);

    try {
      const result = phase.handleTimeout(this._phaseState, this.agentInfos());
      if (result) {
        await this.advancePhase(result);
      } else {
        await this.failLobby('Lobby timed out');
      }
    } catch (err: any) {
      await this.failLobby(`Phase timeout error: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WS lifecycle (hibernatable)
  // ─────────────────────────────────────────────────────────────────────────

  async webSocketClose(_ws: WebSocket): Promise<void> {}

  async webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): Promise<void> {}

  // ─────────────────────────────────────────────────────────────────────────
  // Route handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleCreate(request: Request): Promise<Response> {
    if (this._meta) return Response.json({ error: 'Lobby already created' }, { status: 409 });

    const body = await this.parseJson(request);
    if (body instanceof Response) return body;

    const { lobbyId, gameType, noTimeout } = body;
    if (!lobbyId || !gameType) {
      return Response.json({ error: 'lobbyId and gameType are required' }, { status: 400 });
    }

    const plugin = getGame(gameType);
    if (!plugin) {
      return Response.json({ error: `Unknown game type: ${gameType}` }, { status: 400 });
    }

    const lobbyConfig = plugin.lobby;
    if (!lobbyConfig || !lobbyConfig.phases.length) {
      return Response.json({ error: `Game "${gameType}" has no lobby phases configured` }, { status: 400 });
    }

    const phases = lobbyConfig.phases;
    const firstPhase = phases[0];

    // Initialize first phase with empty player list
    let phaseState: any;
    try {
      phaseState = firstPhase.init([], {});
    } catch (err: any) {
      return Response.json({ error: `Phase init failed: ${err.message}` }, { status: 500 });
    }

    const now = Date.now();
    const deadlineMs = noTimeout
      ? null
      : firstPhase.timeout != null
        ? now + firstPhase.timeout * 1000
        : null;

    this._meta = {
      lobbyId,
      gameType,
      currentPhaseIndex: 0,
      accumulatedMetadata: {},
      phase: 'running',
      deadlineMs,
      gameId: null,
      error: null,
      noTimeout: !!noTimeout,
      createdAt: now,
    };
    this._agents = [];
    this._phaseState = phaseState;
    this._relay = [];

    await this.saveState();
    if (deadlineMs && !noTimeout) {
      await this.ctx.storage.setAlarm(deadlineMs);
    }

    console.log(`[LobbyDO] Created ${gameType} lobby ${lobbyId}`);
    return Response.json({ ok: true, lobbyId, gameType });
  }

  private async handleGetState(url: URL): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    const playerId = url.searchParams.get('playerId') ?? undefined;
    return Response.json(this.buildState(playerId));
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'running') {
      return Response.json({ error: `Cannot join lobby in phase: ${this._meta.phase}` }, { status: 409 });
    }

    const body = await this.parseJson(request);
    if (body instanceof Response) return body;

    const { playerId, handle, elo } = body;
    if (!playerId || !handle) {
      return Response.json({ error: 'playerId and handle are required' }, { status: 400 });
    }

    // Idempotent — don't add twice
    if (this._agents.find(a => a.id === playerId)) {
      return Response.json({ ok: true, ...this.buildState(playerId) });
    }

    const agent: AgentEntry = { id: playerId, handle, elo: elo ?? 1000, joinedAt: Date.now() };
    this._agents.push(agent);

    const phase = this.getCurrentPhase();
    if (!phase) {
      await this.failLobby('No current phase');
      return Response.json({ error: 'Lobby failed: no current phase' }, { status: 500 });
    }

    if (phase.acceptsJoins && phase.handleJoin) {
      const agentInfo: AgentInfo = { id: playerId, handle };
      try {
        const result = phase.handleJoin(this._phaseState, agentInfo, this.agentInfos());
        await this.processActionResult(result);
      } catch (err: any) {
        await this.failLobby(`Phase handleJoin error: ${err.message}`);
        return Response.json({ error: 'Lobby failed during join' }, { status: 500 });
      }
    }

    await this.saveState();
    this.broadcastUpdate();

    console.log(`[LobbyDO] ${handle} joined lobby ${this._meta.lobbyId}`);
    return Response.json({ ok: true, ...this.buildState(playerId) });
  }

  private async handleAction(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'running') {
      return Response.json({ error: `Cannot perform actions in phase: ${this._meta.phase}` }, { status: 409 });
    }

    const body = await this.parseJson(request);
    if (body instanceof Response) return body;

    const { playerId, type, payload } = body;
    if (!playerId || !type) {
      return Response.json({ error: 'playerId and type are required' }, { status: 400 });
    }

    const phase = this.getCurrentPhase();
    if (!phase) {
      return Response.json({ error: 'No current phase' }, { status: 500 });
    }

    let result: PhaseActionResult;
    try {
      result = phase.handleAction(
        this._phaseState,
        { type, playerId, payload },
        this.agentInfos(),
      );
    } catch (err: any) {
      return Response.json({ error: `Phase action error: ${err.message}` }, { status: 500 });
    }

    if (result.error) {
      return Response.json(
        { error: result.error.message },
        { status: result.error.status ?? 400 },
      );
    }

    await this.processActionResult(result);
    await this.saveState();
    this.broadcastUpdate();

    return Response.json({ ok: true, ...this.buildState(playerId) });
  }

  private async handleTool(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });

    const body = await this.parseJson(request);
    if (body instanceof Response) return body;

    const { playerId, relay } = body;
    if (!playerId || !relay?.type || !relay?.pluginId) {
      return Response.json(
        { error: 'Body must be { playerId, relay: { type, data, scope, pluginId } }' },
        { status: 400 },
      );
    }

    // Store relay message with team routing
    const msg: RelayMessage = {
      index: this._relay.length,
      type: relay.type,
      data: relay.data,
      scope: relay.scope ?? 'all',
      pluginId: relay.pluginId,
      sender: playerId,
      timestamp: Date.now(),
    };
    this._relay.push(msg);

    await this.saveState();
    this.broadcastUpdate();
    return Response.json({ ok: true });
  }

  private async handleNoTimeout(): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    this._meta.noTimeout = true;
    this._meta.deadlineMs = null;
    try { await this.ctx.storage.deleteAlarm(); } catch {}
    await this.saveState();
    return Response.json({ ok: true });
  }

  private async handleDisband(): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    this._meta.phase = 'failed';
    this._meta.error = 'Disbanded';
    try { await this.ctx.storage.deleteAlarm(); } catch {}
    await this.saveState();
    await this.updateLobbyPhaseInD1();
    this.broadcastUpdate();
    for (const ws of this.ctx.getWebSockets(TAG_SPECTATOR)) {
      try { ws.close(1000, 'Lobby disbanded'); } catch {}
    }
    return Response.json({ ok: true });
  }

  private handleWebSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [TAG_SPECTATOR]);
    if (this._meta) {
      server.send(JSON.stringify(this.buildState()));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase advancement
  // ─────────────────────────────────────────────────────────────────────────

  private async processActionResult(result: PhaseActionResult): Promise<void> {
    this._phaseState = result.state;

    // Buffer any relay messages from the phase
    if (result.relay) {
      for (const r of result.relay) {
        this._relay.push({
          index: this._relay.length,
          type: r.type,
          data: r.data,
          scope: r.scope,
          pluginId: r.pluginId,
          sender: 'system',
          timestamp: Date.now(),
        });
      }
    }

    if (result.completed) {
      await this.advancePhase(result.completed);
    }
  }

  private async advancePhase(phaseResult: PhaseResult): Promise<void> {
    if (!this._meta) return;

    // Merge metadata from completed phase
    Object.assign(this._meta.accumulatedMetadata, phaseResult.metadata);

    // Remove ejected agents
    if (phaseResult.removed?.length) {
      const removedIds = new Set(phaseResult.removed.map(a => a.id));
      this._agents = this._agents.filter(a => !removedIds.has(a.id));
    }

    // Cancel current alarm
    try { await this.ctx.storage.deleteAlarm(); } catch {}

    // Check if there are more phases
    const plugin = getGame(this._meta.gameType);
    const phases = plugin?.lobby?.phases;
    if (!phases) {
      await this.failLobby('Game plugin has no lobby phases');
      return;
    }

    const nextIndex = this._meta.currentPhaseIndex + 1;

    if (nextIndex < phases.length) {
      // Init next phase
      this._meta.currentPhaseIndex = nextIndex;
      const nextPhase = phases[nextIndex];

      // Build AgentInfo list from current agents for the new phase
      const players = this.agentInfos();

      try {
        this._phaseState = nextPhase.init(players, this._meta.accumulatedMetadata);
      } catch (err: any) {
        await this.failLobby(`Phase init error: ${err.message}`);
        return;
      }

      // Set alarm for next phase timeout
      if (!this._meta.noTimeout && nextPhase.timeout != null) {
        const deadlineMs = Date.now() + nextPhase.timeout * 1000;
        this._meta.deadlineMs = deadlineMs;
        await this.ctx.storage.setAlarm(deadlineMs);
      } else {
        this._meta.deadlineMs = null;
      }

      await this.saveState();
      await this.updateLobbyPhaseInD1();
      this.broadcastUpdate();

      console.log(`[LobbyDO] ${this._meta.lobbyId} → phase "${nextPhase.id}"`);
    } else {
      // All phases complete — start game
      await this.doCreateGame();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Game creation
  // ─────────────────────────────────────────────────────────────────────────

  private async doCreateGame(): Promise<void> {
    if (!this._meta) return;

    this._meta.phase = 'starting';
    try { await this.ctx.storage.deleteAlarm(); } catch {}
    await this.saveState();

    const plugin = getGame(this._meta.gameType);
    if (!plugin?.createConfig) {
      await this.failLobby(`Game plugin "${this._meta.gameType}" does not implement createConfig`);
      return;
    }

    // Pass plain player entries + all accumulated phase metadata to the plugin.
    // The plugin's createConfig knows what metadata keys its own phases produce
    // and enriches players accordingly.
    const metadata = this._meta.accumulatedMetadata;
    const playerEntries = this._agents.map(a => ({ id: a.id, handle: a.handle }));

    const seed = `lobby_${this._meta.lobbyId}_${Date.now()}`;
    let setup: { config: unknown; players: { id: string; team: string }[] };
    try {
      setup = plugin.createConfig(playerEntries, seed, metadata);
    } catch (err: any) {
      await this.failLobby(`createConfig failed: ${err.message}`);
      return;
    }

    const handleMap: Record<string, string> = {};
    for (const a of this._agents) handleMap[a.id] = a.handle;

    const teamMap: Record<string, string> = {};
    for (const p of setup.players) teamMap[p.id] = p.team;

    const gameId = crypto.randomUUID();
    const playerIds = setup.players.map(p => p.id);

    try {
      // 1. Create GameRoomDO
      const gameStub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(gameId));
      const createResp = await gameStub.fetch(new Request('https://do/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameType: this._meta.gameType,
          config: setup.config,
          playerIds,
          handleMap,
          teamMap,
        }),
      }));
      if (!createResp.ok) {
        const err = await createResp.json() as any;
        throw new Error(err.error ?? 'Game creation failed');
      }

      // 2. Send game_start system action
      const startResp = await gameStub.fetch(new Request('https://do/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: null, action: { type: 'game_start' } }),
      }));
      if (!startResp.ok) {
        console.warn(`[LobbyDO] game_start action failed for game ${gameId}`);
      }

      // 3. Write game_sessions + games rows in D1
      const now = new Date().toISOString();
      const stmts = [
        this.env.DB.prepare(
          'INSERT OR REPLACE INTO games (game_id, game_type, finished, created_at) VALUES (?, ?, 0, ?)',
        ).bind(gameId, this._meta.gameType, now),
        ...playerIds.map(pid =>
          this.env.DB.prepare(
            'INSERT OR REPLACE INTO game_sessions (player_id, game_id, game_type, joined_at) VALUES (?, ?, ?, ?)',
          ).bind(pid, gameId, this._meta!.gameType, now),
        ),
      ];

      // 4. Remove lobby_sessions rows
      for (const pid of playerIds) {
        stmts.push(
          this.env.DB.prepare('DELETE FROM lobby_sessions WHERE player_id = ?').bind(pid),
        );
      }
      await this.env.DB.batch(stmts);

      // 5. Finalize lobby metadata
      this._meta.gameId = gameId;
      this._meta.phase = 'game';
      await this.saveState();
      await this.updateLobbyPhaseInD1();
      this.broadcastUpdate();
      console.log(`[LobbyDO] ${this._meta.gameType} game ${gameId} created from lobby ${this._meta.lobbyId}`);
    } catch (err: any) {
      console.error(`[LobbyDO] Game creation error:`, err);
      await this.failLobby(err.message ?? String(err));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State builder
  // ─────────────────────────────────────────────────────────────────────────

  private buildState(playerId?: string): object {
    if (!this._meta) return { error: 'Lobby not found' };

    const plugin = getGame(this._meta.gameType);
    const phases = plugin?.lobby?.phases ?? [];
    const currentPhase = phases[this._meta.currentPhaseIndex];

    // Filter relay messages by scope for the requesting player
    const filteredRelay = playerId
      ? this._relay.filter(msg => this.isRelayVisible(msg, playerId, currentPhase))
      : this._relay;

    const state: Record<string, any> = {
      lobbyId: this._meta.lobbyId,
      gameType: this._meta.gameType,
      agents: this._agents.map(a => ({
        id: a.id,
        handle: a.handle,
        elo: a.elo,
      })),
      currentPhase: currentPhase
        ? {
            id: currentPhase.id,
            name: currentPhase.name,
            view: currentPhase.getView(this._phaseState, playerId),
            tools: currentPhase.tools ?? [],
          }
        : null,
      relay: filteredRelay,
      phase: this._meta.phase,
      deadlineMs: this._meta.deadlineMs,
      gameId: this._meta.gameId,
      error: this._meta.error,
      noTimeout: this._meta.noTimeout,
    };

    return state;
  }

  private isRelayVisible(msg: RelayMessage, playerId: string, currentPhase?: LobbyPhase): boolean {
    if (msg.scope === 'all') return true;
    if (msg.sender === playerId) return true;

    if (msg.scope === 'team' && currentPhase?.getTeamForPlayer) {
      const senderTeam = currentPhase.getTeamForPlayer(this._phaseState, msg.sender);
      const playerTeam = currentPhase.getTeamForPlayer(this._phaseState, playerId);
      return senderTeam != null && senderTeam === playerTeam;
    }

    // If phase doesn't implement getTeamForPlayer, team-scoped falls back to all
    if (msg.scope === 'team') return true;

    return false;
  }

  private broadcastUpdate(): void {
    if (!this._meta) return;
    const msg = JSON.stringify(this.buildState());
    for (const ws of this.ctx.getWebSockets(TAG_SPECTATOR)) {
      try { ws.send(msg); } catch {}
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getCurrentPhase(): LobbyPhase | null {
    if (!this._meta) return null;
    const plugin = getGame(this._meta.gameType);
    const phases = plugin?.lobby?.phases;
    if (!phases || this._meta.currentPhaseIndex >= phases.length) return null;
    return phases[this._meta.currentPhaseIndex];
  }

  private agentInfos(): AgentInfo[] {
    return this._agents.map(a => ({ id: a.id, handle: a.handle }));
  }

  private async failLobby(error: string): Promise<void> {
    if (!this._meta) return;
    this._meta.phase = 'failed';
    this._meta.error = error;
    try { await this.ctx.storage.deleteAlarm(); } catch {}
    await this.saveState();
    await this.updateLobbyPhaseInD1();
    this.broadcastUpdate();
    console.log(`[LobbyDO] ${this._meta.lobbyId} failed: ${error}`);
  }

  private async parseJson(request: Request): Promise<any | Response> {
    try {
      return await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // D1 helpers
  // ─────────────────────────────────────────────────────────────────────────

  private async updateLobbyPhaseInD1(): Promise<void> {
    if (!this._meta) return;
    try {
      await this.env.DB.prepare(
        'UPDATE lobbies SET phase = ?, game_id = ? WHERE id = ?',
      ).bind(this._meta.phase, this._meta.gameId ?? null, this._meta.lobbyId).run();
    } catch (err) {
      console.warn(`[LobbyDO] Failed to update lobbies D1 row:`, err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State persistence
  // ─────────────────────────────────────────────────────────────────────────

  private async saveState(): Promise<void> {
    await Promise.all([
      this.ctx.storage.put('meta', this._meta),
      this.ctx.storage.put('agents', this._agents),
      this.ctx.storage.put('phaseState', this._phaseState),
      this.ctx.storage.put('relay', this._relay),
    ]);
  }

  private async ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this._loaded) return;
      const [meta, agents, phaseState, relay] = await Promise.all([
        this.ctx.storage.get<LobbyMeta>('meta'),
        this.ctx.storage.get<AgentEntry[]>('agents'),
        this.ctx.storage.get<any>('phaseState'),
        this.ctx.storage.get<RelayMessage[]>('relay'),
      ]);

      this._meta = meta ?? null;
      this._agents = agents ?? [];
      this._phaseState = phaseState ?? null;
      this._relay = relay ?? [];
      this._loaded = true;
    });
  }
}
