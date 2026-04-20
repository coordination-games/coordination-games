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
 *   GET  /state      — lobby state. Per-player view if X-Player-Id set.
 *   POST /join       — body { handle, elo? }; identity from X-Player-Id.
 *   POST /action     — body { type, payload };  identity from X-Player-Id.
 *   POST /tool       — body { relay: {...} };   identity from X-Player-Id.
 *   DELETE /         — disband lobby
 *
 * Identity comes from the X-Player-Id header (set by the Worker after
 * Bearer auth). Request bodies and query params are never trusted for
 * player identity.
 *
 * WebSocket:
 *   WS / — spectator (no auth, receives lobby state updates)
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  AgentInfo,
  LobbyPhase,
  PhaseActionResult,
  PhaseResult,
  RelayScope,
} from '@coordination-games/engine';
import { getGame, validateChatScope } from '@coordination-games/engine';
import type { Env } from '../env.js';
import { DOStorageRelayClient } from '../plugins/relay-client.js';

// Side-effect imports — register game plugins with the engine registry
import '@coordination-games/game-ctl';
import '@coordination-games/game-oathbreaker';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_SPECTATOR = 'spectator';

/**
 * Translate the legacy wire-format `scope` string ('all' | 'team' | <handle>)
 * coming in on a /tool POST into the canonical `RelayScope` discriminated
 * union. `'team'` requires a sender team — falls back to `'all'` if the
 * caller has no team in the current phase.
 */
function resolveWireScope(scope: string | undefined, senderTeam: string | null): RelayScope {
  if (!scope || scope === 'all') return { kind: 'all' };
  if (scope === 'team') {
    if (senderTeam) return { kind: 'team', teamId: senderTeam };
    return { kind: 'all' };
  }
  return { kind: 'dm', recipientHandle: scope };
}

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

interface LobbyMeta {
  lobbyId: string;
  gameType: string;
  currentPhaseIndex: number;
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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

// ---------------------------------------------------------------------------
// LobbyDO
// ---------------------------------------------------------------------------

export class LobbyDO extends DurableObject<Env> {
  private _loaded = false;
  private _meta: LobbyMeta | null = null;
  private _agents: AgentEntry[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
  private _phaseState: any = null;
  private _relayClient: DOStorageRelayClient | null = null;

  /**
   * Lazy accessor — constructs the canonical relay client on first use.
   * Both publish paths (handleTool, processActionResult) and read paths
   * (buildStateForViewer, broadcastUpdate) go through this. The team
   * resolver consults the current phase's `getTeamForPlayer`; the handle
   * resolver looks up `_agents`.
   */
  private getRelayClient(): DOStorageRelayClient {
    if (!this._relayClient) {
      this._relayClient = new DOStorageRelayClient(this.ctx.storage, {
        getTeamForPlayer: (playerId) => {
          const phase = this.getCurrentPhase();
          if (!phase?.getTeamForPlayer) return null;
          return phase.getTeamForPlayer(this._phaseState, playerId) ?? null;
        },
        getHandleForPlayer: (playerId) => {
          return this._agents.find((a) => a.id === playerId)?.handle ?? null;
        },
      });
    }
    return this._relayClient;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // fetch() — HTTP + WS entry point
  // ─────────────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      await this.ensureLoaded();
      return await this.handleWebSocket();
    }

    // Create is allowed before loading (it's the initializer)
    if (method === 'POST' && path === '/') return this.handleCreate(request);

    await this.ensureLoaded();

    if (method === 'GET' && path === '/state') return this.handleGetState(request);
    if (method === 'POST' && path === '/join') return this.handleJoin(request);
    if (method === 'POST' && path === '/action') return this.handleAction(request);
    if (method === 'POST' && path === '/tool') return this.handleTool(request);
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
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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
    if (!lobbyConfig?.phases.length) {
      return Response.json(
        { error: `Game "${gameType}" has no lobby phases configured` },
        { status: 400 },
      );
    }

    const phases = lobbyConfig.phases;
    const firstPhase = phases[0];

    // Initialize first phase with empty player list
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    let phaseState: any;
    try {
      // @ts-expect-error TS18048: 'firstPhase' is possibly 'undefined'. — TODO(2.3-followup)
      phaseState = firstPhase.init([], {});
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      return Response.json({ error: `Phase init failed: ${err.message}` }, { status: 500 });
    }

    const now = Date.now();
    const deadlineMs = noTimeout
      ? null
      : // @ts-expect-error TS18048: 'firstPhase' is possibly 'undefined'. — TODO(2.3-followup)
        firstPhase.timeout != null
        ? // @ts-expect-error TS18048: 'firstPhase' is possibly 'undefined'. — TODO(2.3-followup)
          now + firstPhase.timeout * 1000
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

    await this.saveState();
    if (deadlineMs && !noTimeout) {
      await this.ctx.storage.setAlarm(deadlineMs);
    }

    console.log(`[LobbyDO] Created ${gameType} lobby ${lobbyId}`);
    return Response.json({ ok: true, lobbyId, gameType });
  }

  private async handleGetState(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    const playerId = this.headerPlayerId(request);
    return Response.json(await this.buildStateForViewer(playerId));
  }

  /** X-Player-Id header. Absent = spectator/system. Never read from body or URL. */
  private headerPlayerId(request: Request): string | null {
    const h = request.headers.get('X-Player-Id');
    return h && h.length > 0 ? h : null;
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'running') {
      return Response.json(
        { error: `Cannot join lobby in phase: ${this._meta.phase}` },
        { status: 409 },
      );
    }

    const body = await this.parseJson(request);
    if (body instanceof Response) return body;

    const { handle, elo } = body;
    const playerId = this.headerPlayerId(request);
    if (!playerId || !handle) {
      return Response.json(
        { error: 'X-Player-Id header and body.handle are required' },
        { status: 400 },
      );
    }

    // Idempotent — don't add twice
    if (this._agents.find((a) => a.id === playerId)) {
      return Response.json({ ok: true, ...(await this.buildStateForViewer(playerId)) });
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
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      } catch (err: any) {
        await this.failLobby(`Phase handleJoin error: ${err.message}`);
        return Response.json({ error: 'Lobby failed during join' }, { status: 500 });
      }
    }

    await this.saveState();
    await this.broadcastUpdate();

    console.log(`[LobbyDO] ${handle} joined lobby ${this._meta.lobbyId}`);
    return Response.json({ ok: true, ...(await this.buildStateForViewer(playerId)) });
  }

  private async handleAction(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'running') {
      return Response.json(
        { error: `Cannot perform actions in phase: ${this._meta.phase}` },
        { status: 409 },
      );
    }

    const body = await this.parseJson(request);
    if (body instanceof Response) return body;

    const { type, payload } = body;
    const playerId = this.headerPlayerId(request);
    if (!playerId || !type) {
      return Response.json(
        { error: 'X-Player-Id header and body.type are required' },
        { status: 400 },
      );
    }

    const phase = this.getCurrentPhase();
    if (!phase) {
      return Response.json({ error: 'No current phase' }, { status: 500 });
    }

    let result: PhaseActionResult;
    try {
      result = phase.handleAction(this._phaseState, { type, playerId, payload }, this.agentInfos());
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      return Response.json({ error: `Phase action error: ${err.message}` }, { status: 500 });
    }

    if (result.error) {
      return Response.json({ error: result.error.message }, { status: result.error.status ?? 400 });
    }

    await this.processActionResult(result);
    await this.saveState();
    await this.broadcastUpdate();

    return Response.json({ ok: true, ...(await this.buildStateForViewer(playerId)) });
  }

  private async handleTool(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });

    const body = await this.parseJson(request);
    if (body instanceof Response) return body;

    const { relay } = body;
    const playerId = this.headerPlayerId(request);
    if (!playerId || !relay?.type || !relay?.pluginId) {
      return Response.json(
        {
          error:
            'X-Player-Id header required; body must be { relay: { type, data, scope, pluginId } }',
        },
        { status: 400 },
      );
    }

    if (relay.type === 'messaging') {
      const scopeError = validateChatScope(relay.scope, getGame(this._meta.gameType)?.chatScopes);
      if (scopeError) {
        return Response.json(
          { error: { code: 'INVALID_CHAT_SCOPE', message: scopeError } },
          { status: 400 },
        );
      }
    }

    // Resolve the discriminated scope. Lobby callers send a string scope on
    // the wire today: 'all' | 'team' | <recipientHandle>. The DM branch
    // resolves the team from the current phase (if it knows one).
    const phaseForScope = this.getCurrentPhase();
    const senderTeam = phaseForScope?.getTeamForPlayer?.(this._phaseState, playerId) ?? null;
    const resolvedScope = resolveWireScope(relay.scope, senderTeam);

    await this.getRelayClient().publish({
      type: relay.type,
      data: relay.data,
      scope: resolvedScope,
      pluginId: relay.pluginId,
      sender: playerId,
      turn: null,
    });

    await this.saveState();
    await this.broadcastUpdate();
    return Response.json({ ok: true });
  }

  private async handleDisband(): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    this._meta.phase = 'failed';
    this._meta.error = 'Disbanded';
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {}
    await this.saveState();
    await this.updateLobbyPhaseInD1();
    await this.broadcastUpdate();
    for (const ws of this.ctx.getWebSockets(TAG_SPECTATOR)) {
      try {
        ws.close(1000, 'Lobby disbanded');
      } catch {}
    }
    return Response.json({ ok: true });
  }

  private async handleWebSocket(): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [TAG_SPECTATOR]);
    if (this._meta) {
      // WS connections are unauthenticated spectators — always use the
      // spectator filter for the initial payload.
      server.send(JSON.stringify(await this.buildStateForViewer(null)));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase advancement
  // ─────────────────────────────────────────────────────────────────────────

  private async processActionResult(result: PhaseActionResult): Promise<void> {
    this._phaseState = result.state;

    // Buffer any relay envelopes from the phase
    if (result.relay) {
      const client = this.getRelayClient();
      for (const r of result.relay) {
        await client.publish({
          type: r.type,
          data: r.data,
          scope: r.scope,
          pluginId: r.pluginId,
          sender: 'system',
          turn: null,
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
      const removedIds = new Set(phaseResult.removed.map((a) => a.id));
      this._agents = this._agents.filter((a) => !removedIds.has(a.id));
    }

    // Cancel current alarm
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {}

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
        // @ts-expect-error TS18048: 'nextPhase' is possibly 'undefined'. — TODO(2.3-followup)
        this._phaseState = nextPhase.init(players, this._meta.accumulatedMetadata);
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      } catch (err: any) {
        await this.failLobby(`Phase init error: ${err.message}`);
        return;
      }

      // Set alarm for next phase timeout
      // @ts-expect-error TS18048: 'nextPhase' is possibly 'undefined'. — TODO(2.3-followup)
      if (!this._meta.noTimeout && nextPhase.timeout != null) {
        // @ts-expect-error TS18048: 'nextPhase' is possibly 'undefined'. — TODO(2.3-followup)
        const deadlineMs = Date.now() + nextPhase.timeout * 1000;
        this._meta.deadlineMs = deadlineMs;
        await this.ctx.storage.setAlarm(deadlineMs);
      } else {
        this._meta.deadlineMs = null;
      }

      await this.saveState();
      await this.updateLobbyPhaseInD1();
      await this.broadcastUpdate();

      // @ts-expect-error TS18048: 'nextPhase' is possibly 'undefined'. — TODO(2.3-followup)
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
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {}
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
    const playerEntries = this._agents.map((a) => ({ id: a.id, handle: a.handle }));

    const seed = `lobby_${this._meta.lobbyId}_${Date.now()}`;
    let setup: { config: unknown; players: { id: string; team: string }[] };
    try {
      setup = plugin.createConfig(playerEntries, seed, metadata);
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      await this.failLobby(`createConfig failed: ${err.message}`);
      return;
    }

    const handleMap: Record<string, string> = {};
    for (const a of this._agents) handleMap[a.id] = a.handle;

    const teamMap: Record<string, string> = {};
    for (const p of setup.players) teamMap[p.id] = p.team;

    const gameId = crypto.randomUUID();
    const playerIds = setup.players.map((p) => p.id);

    try {
      // 1. Create GameRoomDO
      const gameStub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(gameId));
      const createResp = await gameStub.fetch(
        new Request('https://do/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gameType: this._meta.gameType,
            config: setup.config,
            playerIds,
            handleMap,
            teamMap,
          }),
        }),
      );
      if (!createResp.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
        const err = (await createResp.json()) as any;
        throw new Error(err.error ?? 'Game creation failed');
      }

      // 2. Send game_start system action — no X-Player-Id header means
      // GameRoomDO treats it as a null-player (system) action.
      const startResp = await gameStub.fetch(
        new Request('https://do/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: { type: 'game_start' } }),
        }),
      );
      if (!startResp.ok) {
        console.warn(`[LobbyDO] game_start action failed for game ${gameId}`);
      }

      // 3. Create the games row. Player session rows already point at this
      // lobby; they route to the new GameRoomDO automatically once step 4
      // writes lobbies.game_id via updateLobbyPhaseInD1().
      await this.env.DB.prepare(
        'INSERT OR REPLACE INTO games (game_id, game_type, finished, created_at) VALUES (?, ?, 0, ?)',
      )
        .bind(gameId, this._meta.gameType, new Date().toISOString())
        .run();

      // 4. Finalize lobby metadata (writes lobbies.game_id → routing flips)
      this._meta.gameId = gameId;
      this._meta.phase = 'game';
      await this.saveState();
      await this.updateLobbyPhaseInD1();
      await this.broadcastUpdate();
      console.log(
        `[LobbyDO] ${this._meta.gameType} game ${gameId} created from lobby ${this._meta.lobbyId}`,
      );
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      console.error(`[LobbyDO] Game creation error:`, err);
      await this.failLobby(err.message ?? String(err));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State builder
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build the lobby state object for a specific viewer. `playerId === null`
   * means an unauthenticated spectator (HTTP `/state` without `X-Player-Id`,
   * or any WS connection — WS has no auth surface).
   *
   * Relay filtering is delegated entirely to the canonical
   * `DOStorageRelayClient.visibleTo(viewer)` — Phase 0.1's inline
   * `filterRelayForSpectator` / `filterRelayForPlayer` helpers are gone.
   */
  private async buildStateForViewer(playerId: string | null): Promise<object> {
    if (!this._meta) return { error: 'Lobby not found' };

    const plugin = getGame(this._meta.gameType);
    const phases = plugin?.lobby?.phases ?? [];
    const currentPhase = phases[this._meta.currentPhaseIndex];

    const viewer: import('../plugins/capabilities.js').SpectatorViewer =
      playerId === null ? { kind: 'spectator' } : { kind: 'player', playerId };
    const filteredRelay = await this.getRelayClient().visibleTo(viewer);

    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    const state: Record<string, any> = {
      lobbyId: this._meta.lobbyId,
      gameType: this._meta.gameType,
      agents: this._agents.map((a) => ({
        id: a.id,
        handle: a.handle,
        elo: a.elo,
      })),
      currentPhase: currentPhase
        ? {
            id: currentPhase.id,
            name: currentPhase.name,
            view: currentPhase.getView(this._phaseState, playerId ?? undefined),
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

  private async broadcastUpdate(): Promise<void> {
    if (!this._meta) return;
    // WS connections are unauthenticated spectators — broadcast the
    // spectator-filtered payload to every connection. (If WS auth lands
    // later, switch to per-connection per-viewer filtering here.)
    const msg = JSON.stringify(await this.buildStateForViewer(null));
    for (const ws of this.ctx.getWebSockets(TAG_SPECTATOR)) {
      try {
        ws.send(msg);
      } catch {}
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
    // @ts-expect-error TS2322: Type 'LobbyPhase<any> | undefined' is not assignable to type 'LobbyPhase<any> |  — TODO(2.3-followup)
    return phases[this._meta.currentPhaseIndex];
  }

  private agentInfos(): AgentInfo[] {
    return this._agents.map((a) => ({ id: a.id, handle: a.handle }));
  }

  private async failLobby(error: string): Promise<void> {
    if (!this._meta) return;
    this._meta.phase = 'failed';
    this._meta.error = error;
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {}
    await this.saveState();
    await this.updateLobbyPhaseInD1();
    await this.broadcastUpdate();
    console.log(`[LobbyDO] ${this._meta.lobbyId} failed: ${error}`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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
      await this.env.DB.prepare('UPDATE lobbies SET phase = ?, game_id = ? WHERE id = ?')
        .bind(this._meta.phase, this._meta.gameId ?? null, this._meta.lobbyId)
        .run();
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
    ]);
  }

  private async ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this._loaded) return;
      const [meta, agents, phaseState] = await Promise.all([
        this.ctx.storage.get<LobbyMeta>('meta'),
        this.ctx.storage.get<AgentEntry[]>('agents'),
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
        this.ctx.storage.get<any>('phaseState'),
      ]);

      // Drop the legacy single-array 'relay' key from pre-Phase-4.4 DOs.
      // Relay envelopes now live under 'relay:<paddedIndex>' + 'relay:tip'.
      // Per the no-backwards-compat rule we don't migrate data — we just
      // evict the stale value so it can't confuse anything.
      this.ctx.storage.delete('relay').catch(() => {});

      this._meta = meta ?? null;
      this._agents = agents ?? [];
      this._phaseState = phaseState ?? null;
      this._loaded = true;
    });
  }
}
