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
  GamePhaseKind,
  LobbyPhase,
  PhaseActionResult,
  PhaseResult,
  RelayScope,
} from '@coordination-games/engine';
import { getGame, validateChatScope } from '@coordination-games/engine';
import type { ChainRelay } from '../chain/types.js';
import type { Env } from '../env.js';
import type { SpectatorViewer } from '../plugins/capabilities.js';
import { DOStorageRelayClient } from '../plugins/relay-client.js';
import {
  type BuildSpectatorPayloadCtx,
  buildSpectatorPayload,
  type SpectatorPayload,
} from '../plugins/spectator-payload.js';

// Side-effect imports — register game plugins with the engine registry
import '@coordination-games/game-ctl';
import '@coordination-games/game-oathbreaker';
// Phase 4.2 + 5.1: importing basic-chat (a) self-registers the chat relay
// schema in the engine's relay-registry so `DOStorageRelayClient.publish`
// accepts chat envelopes, and (b) gives us `CHAT_RELAY_TYPE` so this DO
// can dispatch by relay type without spelling the literal string.
import { CHAT_RELAY_TYPE } from '@coordination-games/plugin-chat';

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
  accumulatedMetadata: Record<string, unknown>;
  /**
   * Unified `GamePhaseKind` per Phase 4.6:
   *   - 'lobby'       : pre-game lobby (was 'running' / 'starting')
   *   - 'in_progress' : game has been spawned (was 'game')
   *   - 'finished'    : terminal — either game over or lobby errored
   *                     (`error != null` distinguishes the two; was 'failed')
   */
  phase: GamePhaseKind;
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
  private _phaseState: unknown = null;
  private _relayClient: DOStorageRelayClient | null = null;

  /**
   * Lazy chain-relay accessor for the pre-game credit balance check.
   * Imported dynamically so DO cold-start doesn't pay viem's module cost
   * when no one ever joins (mirrors `GameRoomDO.lazyCreateRelay`). In dev
   * mode (`env.RPC_URL` unset) this yields `MockRelay`, whose `getBalance`
   * returns `MOCK_CREDIT_BALANCE` so local bots / tests don't need real
   * credits. In on-chain mode it yields `OnChainRelay`, which reads the
   * live `CoordinationCredits.balances` mapping.
   */
  private _chainRelayPromise: Promise<ChainRelay> | null = null;
  private async getChainRelay(): Promise<ChainRelay> {
    if (!this._chainRelayPromise) {
      this._chainRelayPromise = import('../chain/index.js').then((m) => m.createRelay(this.env));
    }
    return this._chainRelayPromise;
  }

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
    if (!this._meta || this._meta.phase !== 'lobby') return;

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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.failLobby(`Phase timeout error: ${msg}`);
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

    const body = (await this.parseJson(request)) as
      | Response
      | { lobbyId?: string; gameType?: string; noTimeout?: boolean };
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
    let phaseState: unknown;
    try {
      // @ts-expect-error TS18048: 'firstPhase' is possibly 'undefined'. — TODO(2.3-followup)
      phaseState = firstPhase.init([], {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Phase init failed: ${msg}` }, { status: 500 });
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
      phase: 'lobby',
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
    const url = new URL(request.url);
    const rawSince = url.searchParams.get('sinceIdx');
    const sinceIdx = rawSince === null ? undefined : Number(rawSince);
    return Response.json(await this.buildLobbySpectatorPayload(playerId, sinceIdx));
  }

  /** X-Player-Id header. Absent = spectator/system. Never read from body or URL. */
  private headerPlayerId(request: Request): string | null {
    const h = request.headers.get('X-Player-Id');
    return h && h.length > 0 ? h : null;
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'lobby') {
      return Response.json(
        { error: `Cannot join lobby in phase: ${this._meta.phase}` },
        { status: 409 },
      );
    }

    const body = (await this.parseJson(request)) as Response | { handle?: string; elo?: number };
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
      return Response.json({ ok: true, ...(await this.buildLobbySpectatorPayload(playerId)) });
    }

    // Pre-game credit balance check. MVP: read-only "can this player afford
    // the entry cost right now?" — no committed-stake ledger. Single-lobby
    // invariant (`player_sessions` PRIMARY KEY = player_id, so a player can
    // only be routed to one lobby/game at a time) keeps a live-balance check
    // sufficient pre-launch. See `wiki/architecture/credit-economics.md`.
    const gatePlugin = getGame(this._meta.gameType);
    if (gatePlugin) {
      const balanceError = await this.checkBalanceOrError(playerId, gatePlugin.entryCost);
      if (balanceError) return balanceError;
    }

    // Re-check membership after the balance check — Durable Object requests
    // interleave across every `await`, so two concurrent joins for the same
    // player can both pass the first check, both complete the RPC, then both
    // push, producing a duplicate agent row. The first-past-the-await wins
    // (it already pushed); the second returns the same idempotent response
    // the pre-check branch would have.
    if (this._agents.find((a) => a.id === playerId)) {
      return Response.json({ ok: true, ...(await this.buildLobbySpectatorPayload(playerId)) });
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.failLobby(`Phase handleJoin error: ${msg}`);
        return Response.json({ error: 'Lobby failed during join' }, { status: 500 });
      }
    }

    await this.saveState();
    await this.broadcastUpdate();

    console.log(`[LobbyDO] ${handle} joined lobby ${this._meta.lobbyId}`);
    return Response.json({ ok: true, ...(await this.buildLobbySpectatorPayload(playerId)) });
  }

  private async handleAction(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'lobby') {
      return Response.json(
        { error: `Cannot perform actions in phase: ${this._meta.phase}` },
        { status: 409 },
      );
    }

    const body = (await this.parseJson(request)) as Response | { type?: string; payload?: unknown };
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: `Phase action error: ${msg}` }, { status: 500 });
    }

    if (result.error) {
      return Response.json({ error: result.error.message }, { status: result.error.status ?? 400 });
    }

    await this.processActionResult(result);
    await this.saveState();
    await this.broadcastUpdate();

    return Response.json({ ok: true, ...(await this.buildLobbySpectatorPayload(playerId)) });
  }

  private async handleTool(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });

    const body = (await this.parseJson(request)) as
      | Response
      | {
          relay?: {
            type?: string;
            pluginId?: string;
            data?: unknown;
            scope?: string;
          };
        };
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

    if (relay.type === CHAT_RELAY_TYPE) {
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
    this._meta.phase = 'finished';
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
      // Phase 7.1 — spectator WS receives the same unified payload that
      // HTTP `/state` returns. Initial connect → full snapshot (no
      // `sinceIdx`); subsequent broadcasts emit deltas.
      server.send(JSON.stringify(await this.buildLobbySpectatorPayload(null)));
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.failLobby(`Phase init error: ${msg}`);
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

    // Brief transient between 'lobby' and 'in_progress'. The unified
    // GamePhaseKind has no separate 'starting' value; we keep phase at
    // 'lobby' here and rely on the existing handleAction/handleJoin guard
    // chain — once `gameId` is set below the phase flips to 'in_progress'.
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.failLobby(`createConfig failed: ${msg}`);
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
        const err = (await createResp.json()) as { error?: string };
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
      this._meta.phase = 'in_progress';
      await this.saveState();
      await this.updateLobbyPhaseInD1();
      await this.broadcastUpdate();
      console.log(
        `[LobbyDO] ${this._meta.gameType} game ${gameId} created from lobby ${this._meta.lobbyId}`,
      );
    } catch (err) {
      console.error(`[LobbyDO] Game creation error:`, err);
      await this.failLobby(err instanceof Error ? err.message : String(err));
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State builder
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Unified spectator payload (HTTP + WS share this builder). `viewerPlayerId`
   * discriminates the viewer: `null` → spectator (public view); non-null →
   * authenticated player (fog-filtered view, auth-only `currentPhase` +
   * `gameOver` fields populated on the envelope so CLI dispatchers can
   * read the callable tool surface without a second endpoint).
   *
   * Relay filtering runs through `DOStorageRelayClient.visibleTo(viewer)`;
   * the lobby phase's `getView` receives the same playerId so per-player
   * phase views stay fog-filtered.
   *
   * `sinceIdx` is clamped to `[0, relayTip]` server-side.
   */
  private async buildLobbySpectatorPayload(
    viewerPlayerId: string | null,
    sinceIdx?: number,
  ): Promise<SpectatorPayload> {
    if (!this._meta) {
      return {
        type: 'spectator_pending',
        meta: {
          gameId: this.ctx.id.name ?? '__unknown__',
          gameType: '__unknown__',
          handles: {},
          progressCounter: null,
          finished: false,
          sinceIdx: 0,
          lastUpdate: Date.now(),
        },
      };
    }
    const plugin = getGame(this._meta.gameType);
    const phases = plugin?.lobby?.phases ?? [];
    const currentPhase = phases[this._meta.currentPhaseIndex];
    const handles: Record<string, string> = {};
    for (const a of this._agents) handles[a.id] = a.handle;

    const viewer: SpectatorViewer =
      viewerPlayerId === null
        ? { kind: 'spectator' }
        : { kind: 'player', playerId: viewerPlayerId };

    // Lobby-shaped "state" — same field bundle the frontend already
    // consumes (agents, currentPhase.view, gameId, etc.). `relay` is omitted
    // because the unified payload exposes it at the top level. Phase view
    // is fog-filtered when the viewer is a player.
    const state = {
      lobbyId: this._meta.lobbyId,
      gameType: this._meta.gameType,
      agents: this._agents.map((a) => ({ id: a.id, handle: a.handle, elo: a.elo })),
      currentPhase: currentPhase
        ? {
            id: currentPhase.id,
            name: currentPhase.name,
            view: currentPhase.getView(this._phaseState, viewerPlayerId ?? undefined),
          }
        : null,
      phase: this._meta.phase,
      deadlineMs: this._meta.deadlineMs,
      gameId: this._meta.gameId,
      error: this._meta.error,
      noTimeout: this._meta.noTimeout,
    };

    const relayClient = this.getRelayClient();
    const relayTip = await relayClient.getTip();
    const ctx: BuildSpectatorPayloadCtx = {
      gameId: this._meta.lobbyId,
      gameType: this._meta.gameType,
      handles,
      // Lobbies don't go through a spectator-delay window — there's no
      // public snapshot index to clamp to. We mirror the lobby's lifecycle
      // phase as a coarse "is something visible yet?" signal: whatever
      // phase the lobby is in, the state above is always public-safe.
      finished: this._meta.phase === 'finished',
      publicSnapshotIndex: 0,
      state,
      viewer,
      relay: relayClient,
      relayTip,
      sinceIdx,
    };
    // Auth-only: advertise the callable tool surface + a stable `gameOver`
    // alias so CLI callers can dispatch without a second hop.
    if (viewerPlayerId !== null) {
      if (currentPhase) {
        ctx.currentPhase = {
          id: currentPhase.id,
          name: currentPhase.name,
          tools: currentPhase.tools ?? [],
        };
      }
      ctx.gameOver = this._meta.phase === 'finished';
    }
    return buildSpectatorPayload(ctx);
  }

  /**
   * Phase 7.1 — broadcast the unified spectator payload to every
   * spectator WS. Sends a delta from `_lastBroadcastRelayIdx`; freshly
   * connecting spectators get a full snapshot through `handleWebSocket`.
   */
  private _lastBroadcastRelayIdx = 0;
  private async broadcastUpdate(): Promise<void> {
    if (!this._meta) return;
    const conns = this.ctx.getWebSockets(TAG_SPECTATOR);
    if (conns.length === 0) {
      const tip = await this.getRelayClient().getTip();
      this._lastBroadcastRelayIdx = tip;
      return;
    }
    const payload = await this.buildLobbySpectatorPayload(null, this._lastBroadcastRelayIdx);
    const json = JSON.stringify(payload);
    for (const ws of conns) {
      try {
        ws.send(json);
      } catch {}
    }
    this._lastBroadcastRelayIdx = payload.meta.sinceIdx;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Pre-game credit balance check. Returns `null` on success, or a 402
   * Response describing the shortfall. `entryCost` is the plugin-declared
   * value in RAW credit units (6-dec `bigint`, matching
   * `CoordinationCredits` storage) — compared directly to the relay's
   * `getBalance` result with no scaling.
   *
   * Balance source: `ChainRelay.getBalance(agentId)`. On-chain mode reads
   * the live `CoordinationCredits.balances(uint256)` value — the same
   * number that `GameAnchor.settleGame` will debit at game end. In dev/test
   * mode (`env.RPC_URL` unset), `MockRelay` returns `MOCK_CREDIT_BALANCE`,
   * trivially satisfying the check for local bots and tests.
   *
   * `entryCost: 0n` (tests, free games) short-circuits to success without
   * hitting the relay.
   *
   * On-chain mode requires an on-chain agent id to query `balances`. If the
   * player has no `chain_agent_id` in D1 they cannot settle either — we
   * reject upfront so the lobby doesn't fill with unsettleable entries.
   *
   * Errors from the relay itself (RPC flake) bubble up as 503 — we fail
   * closed; letting the join through on an RPC error would bypass the gate.
   */
  private async checkBalanceOrError(playerId: string, entryCost: bigint): Promise<Response | null> {
    if (entryCost <= 0n) return null;
    const required = entryCost;

    // On-chain mode: translate D1 UUID → chain_agent_id. MockRelay ignores
    // the arg, so only pay the D1 cost when we actually have an RPC config.
    let agentIdForRelay = playerId;
    if (this.env.RPC_URL) {
      const row = await this.env.DB.prepare('SELECT chain_agent_id FROM players WHERE id = ?')
        .bind(playerId)
        .first<{ chain_agent_id: number | null }>();
      if (!row?.chain_agent_id) {
        return Response.json(
          {
            error: 'Insufficient credits',
            required: required.toString(),
            available: '0',
            agentId: playerId,
          },
          { status: 402 },
        );
      }
      agentIdForRelay = String(row.chain_agent_id);
    }

    let creditsStr: string;
    try {
      const relay = await this.getChainRelay();
      const { credits } = await relay.getBalance(agentIdForRelay);
      creditsStr = credits;
    } catch (err) {
      console.error(
        `[LobbyDO] getBalance failed for player ${playerId} (agent ${agentIdForRelay}):`,
        err,
      );
      return Response.json({ error: 'Balance lookup failed', agentId: playerId }, { status: 503 });
    }

    const available = BigInt(creditsStr);
    if (available < required) {
      // Return raw 6-decimal credit units as strings (same shape as the
      // on-chain balance wire format). The CLI / web UI formats via
      // formatCreditsDisplay; no Number(bigint) truncation on the server.
      return Response.json(
        {
          error: 'Insufficient credits',
          required: required.toString(),
          available: available.toString(),
          agentId: agentIdForRelay,
        },
        { status: 402 },
      );
    }
    return null;
  }

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
    this._meta.phase = 'finished';
    this._meta.error = error;
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {}
    await this.saveState();
    await this.updateLobbyPhaseInD1();
    await this.broadcastUpdate();
    console.log(`[LobbyDO] ${this._meta.lobbyId} failed: ${error}`);
  }

  private async parseJson(request: Request): Promise<unknown | Response> {
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
        this.ctx.storage.get<unknown>('phaseState'),
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
