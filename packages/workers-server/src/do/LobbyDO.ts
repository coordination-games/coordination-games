/**
 * LobbyDO — Durable Object for a single lobby.
 *
 * Manages the full lobby lifecycle for a team-based game (CtL):
 *   forming → pre_game → starting → game
 *                                 ↘ failed
 *
 * HTTP routes (sub-path, forwarded from the main Worker):
 *   POST /             — create lobby { lobbyId, gameType, teamSize, noTimeout? }
 *   GET  /state        — lobby state (?playerId=X for player-specific view)
 *   POST /join         — { playerId, handle, elo? }
 *   POST /chat         — { playerId, message, team? }
 *   POST /team/propose — { fromId, toId }
 *   POST /team/accept  — { agentId, teamId }
 *   POST /team/leave   — { agentId }
 *   POST /class        — { agentId, unitClass }
 *   POST /no-timeout   — disable the forming timer
 *   DELETE /           — disband lobby
 *
 * WebSocket:
 *   WS / — spectator WS (no auth, receives lobby state updates)
 *
 * On game creation the DO:
 *   1. Creates a GameRoomDO via env.GAME_ROOM
 *   2. Sends game_start action to the GameRoomDO
 *   3. Writes game_sessions rows to D1
 *   4. Deletes lobby_sessions rows from D1
 *   5. Updates the lobbies row in D1
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { getGame } from '@coordination-games/engine';

// Side-effect imports — register game plugins with the engine registry
import '@coordination-games/game-ctl';
import '@coordination-games/game-oathbreaker';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_SPECTATOR = 'spectator';
const FORMING_TIMEOUT_MS  = 240_000;  // 4 min
const PREGAME_TIMEOUT_MS  = 300_000;  // 5 min

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

type LobbyPhase = 'forming' | 'pre_game' | 'starting' | 'game' | 'failed';
type AlarmType  = 'forming_timeout' | 'pregame_timeout';

interface LobbyMeta {
  lobbyId: string;
  gameType: string;
  teamSize: number;
  /** Minimum players required to start (from plugin.lobby.matchmaking.minPlayers). */
  minPlayersToStart: number;
  /** True if the plugin declares pre-game phases (team formation, class selection, etc.).
   *  False = open queue: game starts as soon as minPlayersToStart join. */
  hasPhases: boolean;
  phase: LobbyPhase;
  createdAt: string;
  formingDeadlineMs: number | null;
  gameId: string | null;
  error: string | null;
  noTimeout: boolean;
}

interface AgentEntry {
  id: string;
  handle: string;
  elo: number;
}

interface TeamEntry {
  id: string;
  members: string[];
  invites: string[];
}

interface ChatMessage {
  from: string;
  message: string;
  timestamp: number;
}

interface PreGamePlayer {
  id: string;
  team: 'A' | 'B';
  unitClass: string | null;
  ready: boolean;
}

interface PreGameState {
  players: PreGamePlayer[];
  chatA: ChatMessage[];
  chatB: ChatMessage[];
  startedAt: number;
  deadlineMs: number;
}

// ---------------------------------------------------------------------------
// LobbyDO
// ---------------------------------------------------------------------------

export class LobbyDO extends DurableObject<Env> {
  private _loaded       = false;
  private _meta: LobbyMeta | null = null;
  private _agents: AgentEntry[]   = [];
  private _agentTeam: Record<string, string> = {};  // agentId → teamId
  private _teams: TeamEntry[]     = [];
  private _teamCounter            = 0;
  private _chat: ChatMessage[]    = [];
  private _preGame: PreGameState | null = null;
  private _alarmType: AlarmType | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // fetch() — HTTP + WS entry point
  // ─────────────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url    = new URL(request.url);
    const method = request.method;
    const path   = url.pathname.replace(/\/$/, '') || '/';

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      await this.ensureLoaded();
      return this.handleWebSocket();
    }

    // Create is allowed before loading (it's the initializer)
    if (method === 'POST' && path === '/') return this.handleCreate(request);

    await this.ensureLoaded();

    if (method === 'GET'    && path === '/state')        return this.handleGetState(url);
    if (method === 'POST'   && path === '/join')         return this.handleJoin(request);
    if (method === 'POST'   && path === '/chat')         return this.handleChat(request);
    if (method === 'POST'   && path === '/team/propose') return this.handleProposeTeam(request);
    if (method === 'POST'   && path === '/team/accept')  return this.handleAcceptTeam(request);
    if (method === 'POST'   && path === '/team/leave')   return this.handleLeaveTeam(request);
    if (method === 'POST'   && path === '/class')        return this.handleChooseClass(request);
    if (method === 'POST'   && path === '/no-timeout')   return this.handleNoTimeout();
    if (method === 'DELETE' && path === '/')             return this.handleDisband();

    return new Response('Not found', { status: 404 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // alarm() — forming/pregame timeout
  // ─────────────────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (!this._meta) return;

    if (this._alarmType === 'forming_timeout') {
      if (this._meta.phase !== 'forming') return;
      if (!this._meta.hasPhases) {
        // Open-queue game: fail if not enough players joined in time
        this._meta.phase = 'failed';
        this._meta.error = `Lobby timed out — need ${this._meta.minPlayersToStart} players, have ${this._agents.length}`;
        this._alarmType  = null;
        await this.saveState();
        await this.updateLobbyPhaseInD1();
        this.broadcastUpdate();
        console.log(`[LobbyDO] ${this._meta.lobbyId} timed out (${this._agents.length}/${this._meta.minPlayersToStart} players)`);
        return;
      }
      // Phased lobby (e.g. CtL): auto-merge and move to pre-game
      console.log(`[LobbyDO] Forming timeout — auto-merging for ${this._meta.lobbyId}`);
      await this.transitionToPreGame();
    } else if (this._alarmType === 'pregame_timeout') {
      if (this._meta.phase !== 'pre_game') return;
      console.log(`[LobbyDO] Pre-game timeout — creating game for ${this._meta.lobbyId}`);
      await this.doCreateGame();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WS lifecycle (hibernatable)
  // ─────────────────────────────────────────────────────────────────────────

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // CF removes closed sockets from getWebSockets() automatically
  }

  async webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): Promise<void> {
    // Spectator WS is receive-only
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Route handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleCreate(request: Request): Promise<Response> {
    if (this._meta) return Response.json({ error: 'Lobby already created' }, { status: 409 });

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { lobbyId, gameType, teamSize, noTimeout } = body ?? {};
    if (!lobbyId || !gameType || typeof teamSize !== 'number') {
      return Response.json({ error: 'lobbyId, gameType, and teamSize are required' }, { status: 400 });
    }

    const plugin = getGame(gameType);
    if (!plugin) {
      return Response.json({ error: `Unknown game type: ${gameType}` }, { status: 400 });
    }
    const matchmaking = plugin.lobby?.matchmaking;
    const hasPhases   = (plugin.lobby?.phases?.length ?? 0) > 0;
    // minPlayersToStart: use the plugin's declared minimum, or fall back to teamSize*2 for team games
    const minPlayersToStart = matchmaking?.minPlayers ?? (hasPhases ? teamSize * 2 : teamSize);

    const deadlineMs = noTimeout ? null : Date.now() + FORMING_TIMEOUT_MS;
    this._meta = {
      lobbyId, gameType, teamSize,
      minPlayersToStart,
      hasPhases,
      phase: 'forming',
      createdAt: new Date().toISOString(),
      formingDeadlineMs: deadlineMs,
      gameId: null,
      error: null,
      noTimeout: !!noTimeout,
    };
    this._alarmType = noTimeout ? null : 'forming_timeout';

    await this.saveState();
    if (!noTimeout) await this.ctx.storage.setAlarm(deadlineMs!);

    console.log(`[LobbyDO] Created ${gameType} lobby ${lobbyId} (teamSize=${teamSize})`);
    return Response.json({ ok: true, lobbyId, gameType, teamSize });
  }

  private async handleGetState(url: URL): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    const playerId = url.searchParams.get('playerId') ?? undefined;
    return Response.json(this.buildState(playerId));
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'forming') {
      return Response.json({ error: `Cannot join lobby in phase: ${this._meta.phase}` }, { status: 409 });
    }

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { playerId, handle, elo } = body ?? {};
    if (!playerId || !handle) {
      return Response.json({ error: 'playerId and handle are required' }, { status: 400 });
    }

    // Idempotent — don't add twice
    if (!this._agents.find(a => a.id === playerId)) {
      this._agents.push({ id: playerId, handle, elo: elo ?? 1000 });
      await this.saveState();
      console.log(`[LobbyDO] ${handle} joined lobby ${this._meta.lobbyId}`);

      // Open-queue games (no pre-game phases) auto-start when minPlayersToStart is reached
      if (!this._meta.hasPhases && this._agents.length >= this._meta.minPlayersToStart) {
        await this.doCreateGame();
        return Response.json({ ok: true, phase: this._meta.phase, ...this.buildState(playerId) });
      }

      this.broadcastUpdate();
    }

    return Response.json({ ok: true, phase: this._meta.phase, ...this.buildState(playerId) });
  }

  private async handleChat(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { playerId, message, team } = body ?? {};
    if (!playerId || !message) {
      return Response.json({ error: 'playerId and message are required' }, { status: 400 });
    }

    const msg: ChatMessage = { from: playerId, message, timestamp: Date.now() };

    if (this._meta.phase === 'pre_game' && this._preGame && team) {
      // Team-scoped chat during pre_game
      const player = this._preGame.players.find(p => p.id === playerId);
      if (!player) return Response.json({ error: 'Player not in pre-game' }, { status: 403 });
      if (player.team === 'A') this._preGame.chatA.push(msg);
      else                      this._preGame.chatB.push(msg);
    } else {
      this._chat.push(msg);
    }

    await this.saveState();
    this.broadcastUpdate();
    return Response.json({ ok: true });
  }

  private async handleProposeTeam(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'forming') {
      return Response.json({ error: 'Team proposals only during forming phase' }, { status: 409 });
    }

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { fromId, toId } = body ?? {};
    if (!fromId || !toId) return Response.json({ error: 'fromId and toId are required' }, { status: 400 });

    // Resolve toId: could be agentId or handle
    let resolvedToId = toId;
    if (!this._agents.find(a => a.id === toId)) {
      const byHandle = this._agents.find(a => a.handle === toId);
      if (byHandle) resolvedToId = byHandle.id;
      else return Response.json({ error: `Agent "${toId}" not found in lobby` }, { status: 404 });
    }

    const result = this.proposeTeamLogic(fromId, resolvedToId);
    if (!result.success) return Response.json({ error: result.error }, { status: 400 });

    await this.saveState();
    await this.checkAndTransitionIfReady();
    this.broadcastUpdate();
    return Response.json({ ok: true, teamId: result.teamId, ...this.buildState(fromId) });
  }

  private async handleAcceptTeam(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'forming') {
      return Response.json({ error: 'Team acceptance only during forming phase' }, { status: 409 });
    }

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { agentId, teamId } = body ?? {};
    if (!agentId || !teamId) return Response.json({ error: 'agentId and teamId are required' }, { status: 400 });

    const team = this._teams.find(t => t.id === teamId);
    if (!team) return Response.json({ error: 'Team not found' }, { status: 404 });
    if (!team.invites.includes(agentId)) return Response.json({ error: 'Not invited to this team' }, { status: 403 });
    if (team.members.length >= this._meta.teamSize) return Response.json({ error: 'Team is full' }, { status: 409 });

    team.invites = team.invites.filter(id => id !== agentId);
    team.members.push(agentId);
    this._agentTeam[agentId] = teamId;

    await this.saveState();
    await this.checkAndTransitionIfReady();
    this.broadcastUpdate();
    return Response.json({ ok: true, ...this.buildState(agentId) });
  }

  private async handleLeaveTeam(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'forming') {
      return Response.json({ error: 'Can only leave teams during forming phase' }, { status: 409 });
    }

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { agentId } = body ?? {};
    if (!agentId) return Response.json({ error: 'agentId is required' }, { status: 400 });

    const teamId = this._agentTeam[agentId];
    if (!teamId) return Response.json({ error: 'Not on a team' }, { status: 400 });

    const team = this._teams.find(t => t.id === teamId);
    if (team) {
      team.members = team.members.filter(id => id !== agentId);
      if (team.members.length === 0) this._teams = this._teams.filter(t => t.id !== teamId);
    }
    delete this._agentTeam[agentId];

    await this.saveState();
    this.broadcastUpdate();
    return Response.json({ ok: true });
  }

  private async handleChooseClass(request: Request): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    if (this._meta.phase !== 'pre_game' || !this._preGame) {
      return Response.json({ error: 'Class selection only during pre-game phase' }, { status: 409 });
    }

    let body: any;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

    const { agentId, unitClass } = body ?? {};
    if (!agentId || !unitClass) return Response.json({ error: 'agentId and unitClass are required' }, { status: 400 });

    const player = this._preGame.players.find(p => p.id === agentId);
    if (!player) return Response.json({ error: 'Player not in pre-game' }, { status: 404 });

    player.unitClass = unitClass;
    player.ready = true;

    await this.saveState();

    // All players chosen → create game immediately (don't wait for alarm)
    const allChosen = this._preGame.players.every(p => p.unitClass !== null);
    if (allChosen) {
      await this.doCreateGame();
    } else {
      this.broadcastUpdate();
    }

    return Response.json({ ok: true, unitClass });
  }

  private async handleNoTimeout(): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    this._meta.noTimeout = true;
    this._meta.formingDeadlineMs = null;
    this._alarmType = null;
    try { await this.ctx.storage.deleteAlarm(); } catch {}
    await this.saveState();
    return Response.json({ ok: true });
  }

  private async handleDisband(): Promise<Response> {
    if (!this._meta) return Response.json({ error: 'Lobby not found' }, { status: 404 });
    this._meta.phase = 'failed';
    this._meta.error = 'Disbanded';
    this._alarmType = null;
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
  // Team formation logic
  // ─────────────────────────────────────────────────────────────────────────

  private proposeTeamLogic(
    fromId: string,
    toId: string,
  ): { success: boolean; teamId?: string; error?: string } {
    const fromTeamId = this._agentTeam[fromId];
    const toTeamId   = this._agentTeam[toId];
    const teamSize   = this._meta!.teamSize;

    if (fromTeamId && toTeamId) {
      if (fromTeamId === toTeamId) return { success: false, error: 'Already on the same team' };
      return { success: false, error: 'Both agents already on different teams — use leave-team first' };
    }

    if (toTeamId && !fromTeamId) {
      const team = this._teams.find(t => t.id === toTeamId)!;
      if (team.members.length >= teamSize) return { success: false, error: 'Team is full' };
      if (!team.invites.includes(fromId)) team.invites.push(fromId);
      return { success: true, teamId: toTeamId };
    }

    if (fromTeamId && !toTeamId) {
      const team = this._teams.find(t => t.id === fromTeamId)!;
      if (team.members.length >= teamSize) return { success: false, error: 'Team is full' };
      if (!team.invites.includes(toId)) team.invites.push(toId);
      return { success: true, teamId: fromTeamId };
    }

    // Neither on a team: create a new team with fromId, invite toId
    const teamId = `team_${++this._teamCounter}`;
    this._teams.push({ id: teamId, members: [fromId], invites: [toId] });
    this._agentTeam[fromId] = teamId;
    return { success: true, teamId };
  }

  private getFullTeams(): TeamEntry[] {
    return this._teams.filter(t => t.members.length >= this._meta!.teamSize);
  }

  private autoMergeTeams(): void {
    const teamSize   = this._meta!.teamSize;
    const freeAgents = this._agents
      .filter(a => !this._agentTeam[a.id])
      .map(a => a.id);

    // Fill incomplete teams with free agents
    let freeIdx = 0;
    for (const team of this._teams) {
      while (team.members.length < teamSize && freeIdx < freeAgents.length) {
        const agentId = freeAgents[freeIdx++];
        team.members.push(agentId);
        this._agentTeam[agentId] = team.id;
      }
    }

    // Form new full teams from remaining free agents
    while (freeIdx + teamSize <= freeAgents.length) {
      const teamId  = `team_${++this._teamCounter}`;
      const members = freeAgents.slice(freeIdx, freeIdx + teamSize);
      freeIdx += teamSize;
      this._teams.push({ id: teamId, members, invites: [] });
      for (const m of members) this._agentTeam[m] = teamId;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase transitions
  // ─────────────────────────────────────────────────────────────────────────

  private async checkAndTransitionIfReady(): Promise<void> {
    if (!this._meta || this._meta.phase !== 'forming') return;
    const full = this.getFullTeams();
    if (full.length >= 2) await this.transitionToPreGame(full.slice(0, 2));
  }

  private async transitionToPreGame(fullTeams?: TeamEntry[]): Promise<void> {
    if (!this._meta) return;

    // On timeout: auto-merge first
    if (!fullTeams) {
      this.autoMergeTeams();
      fullTeams = this.getFullTeams();
    }

    if (fullTeams.length < 2) {
      this._meta.phase = 'failed';
      this._meta.error = 'Not enough agents to form 2 teams';
      this._alarmType  = null;
      try { await this.ctx.storage.deleteAlarm(); } catch {}
      await this.saveState();
      await this.updateLobbyPhaseInD1();
      this.broadcastUpdate();
      console.log(`[LobbyDO] ${this._meta.lobbyId} failed: not enough agents`);
      return;
    }

    const teamA = fullTeams[0].members;
    const teamB = fullTeams[1].members;
    const deadlineMs = Date.now() + PREGAME_TIMEOUT_MS;

    this._preGame = {
      players: [
        ...teamA.map(id => ({ id, team: 'A' as const, unitClass: null, ready: false })),
        ...teamB.map(id => ({ id, team: 'B' as const, unitClass: null, ready: false })),
      ],
      chatA: [],
      chatB: [],
      startedAt: Date.now(),
      deadlineMs,
    };

    this._meta.phase            = 'pre_game';
    this._meta.formingDeadlineMs = null;
    this._alarmType              = 'pregame_timeout';

    try { await this.ctx.storage.deleteAlarm(); } catch {}
    if (!this._meta.noTimeout) await this.ctx.storage.setAlarm(deadlineMs);

    await this.saveState();
    await this.updateLobbyPhaseInD1();
    this.broadcastUpdate();
    console.log(`[LobbyDO] ${this._meta.lobbyId} → pre_game (${teamA.length}v${teamB.length})`);
  }

  private async doCreateGame(): Promise<void> {
    if (!this._meta) return;

    this._meta.phase = 'starting';
    this._alarmType  = null;
    try { await this.ctx.storage.deleteAlarm(); } catch {}
    await this.saveState();

    const plugin = getGame(this._meta.gameType);
    if (!plugin?.createConfig) {
      this._meta.phase = 'failed';
      this._meta.error = `Game plugin "${this._meta.gameType}" does not implement createConfig`;
      await this.saveState();
      await this.updateLobbyPhaseInD1();
      this.broadcastUpdate();
      return;
    }

    // Build player list. For phased lobbies (CtL), team/role come from pre-game state.
    // For open-queue games, just pass the agents — the plugin assigns teams/roles.
    const playerEntries: { id: string; handle: string; team?: string; role?: string }[] =
      this._meta.hasPhases && this._preGame
        ? this._preGame.players.map(p => ({
            id:     p.id,
            handle: this._agents.find(a => a.id === p.id)?.handle ?? p.id,
            team:   p.team,
            role:   p.unitClass ?? undefined,
          }))
        : this._agents.map(a => ({ id: a.id, handle: a.handle }));

    const seed = `lobby_${this._meta.lobbyId}_${Date.now()}`;
    let setup: { config: unknown; players: { id: string; team: string }[] };
    try {
      setup = plugin.createConfig(playerEntries, seed);
    } catch (err: any) {
      this._meta.phase = 'failed';
      this._meta.error = `createConfig failed: ${err.message}`;
      await this.saveState();
      await this.updateLobbyPhaseInD1();
      this.broadcastUpdate();
      return;
    }

    const handleMap: Record<string, string> = {};
    for (const a of this._agents) handleMap[a.id] = a.handle;

    const teamMap: Record<string, string> = {};
    for (const p of setup.players) teamMap[p.id] = p.team;

    const gameId    = crypto.randomUUID();
    const playerIds = setup.players.map(p => p.id);

    try {
      // 1. Create GameRoomDO
      const gameStub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(gameId));
      const createResp = await gameStub.fetch(new Request('https://do/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameType: this._meta.gameType,
          config:   setup.config,
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

      // 3. Write game_sessions rows in D1
      const now  = new Date().toISOString();
      const stmt = this.env.DB.prepare(
        'INSERT OR REPLACE INTO game_sessions (player_id, game_id, game_type, joined_at) VALUES (?, ?, ?, ?)',
      );
      await this.env.DB.batch(playerIds.map(pid => stmt.bind(pid, gameId, this._meta!.gameType, now)));

      // 4. Remove lobby_sessions rows
      const delStmt = this.env.DB.prepare('DELETE FROM lobby_sessions WHERE player_id = ?');
      await this.env.DB.batch(playerIds.map(pid => delStmt.bind(pid)));

      // 5. Finalise lobby metadata
      this._meta.gameId = gameId;
      this._meta.phase  = 'game';
      await this.saveState();
      await this.updateLobbyPhaseInD1();
      this.broadcastUpdate();
      console.log(`[LobbyDO] ${this._meta.gameType} game ${gameId} created from lobby ${this._meta.lobbyId}`);
    } catch (err: any) {
      console.error(`[LobbyDO] Game creation error:`, err);
      this._meta.phase = 'failed';
      this._meta.error = err.message ?? String(err);
      await this.saveState();
      await this.updateLobbyPhaseInD1();
      this.broadcastUpdate();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State builder
  // ─────────────────────────────────────────────────────────────────────────

  private buildState(playerId?: string): object {
    if (!this._meta) return { error: 'Lobby not found' };

    const agents = this._agents.map(a => ({
      id: a.id,
      handle: a.handle,
      elo: a.elo,
      team: this._agentTeam[a.id] ?? null,
      pendingInvites: this._teams
        .filter(t => t.invites.includes(a.id))
        .map(t => t.id),
    }));

    const teams: Record<string, { members: string[]; invites: string[] }> = {};
    for (const t of this._teams) {
      teams[t.id] = { members: [...t.members], invites: [...t.invites] };
    }

    const timeRemainingSeconds = this._meta.noTimeout
      ? -1
      : this._meta.formingDeadlineMs
        ? Math.max(0, Math.round((this._meta.formingDeadlineMs - Date.now()) / 1000))
        : 0;

    const state: any = {
      lobbyId: this._meta.lobbyId,
      gameType: this._meta.gameType,
      phase: this._meta.phase,
      teamSize: this._meta.teamSize,
      agents,
      teams,
      chat: this._chat,
      timeRemainingSeconds,
      gameId: this._meta.gameId,
      error: this._meta.error,
      noTimeout: this._meta.noTimeout,
    };

    if (this._meta.phase === 'pre_game' && this._preGame) {
      const preGameRemaining = this._meta.noTimeout
        ? -1
        : Math.max(0, Math.round((this._preGame.deadlineMs - Date.now()) / 1000));

      state.preGame = {
        players: this._preGame.players,
        timeRemainingSeconds: preGameRemaining,
        chatA: this._preGame.chatA,
        chatB: this._preGame.chatB,
      };

      if (playerId) {
        const player = this._preGame.players.find(p => p.id === playerId);
        if (player) {
          state.myTeam   = player.team;
          state.teamChat = player.team === 'A' ? this._preGame.chatA : this._preGame.chatB;
        }
      }
    }

    return state;
  }

  private broadcastUpdate(): void {
    if (!this._meta) return;
    const msg = JSON.stringify(this.buildState());
    for (const ws of this.ctx.getWebSockets(TAG_SPECTATOR)) {
      try { ws.send(msg); } catch {}
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
      this.ctx.storage.put('meta',         this._meta),
      this.ctx.storage.put('agents',       this._agents),
      this.ctx.storage.put('agentTeam',    this._agentTeam),
      this.ctx.storage.put('teams',        this._teams),
      this.ctx.storage.put('teamCounter',  this._teamCounter),
      this.ctx.storage.put('chat',         this._chat),
      this.ctx.storage.put('preGame',      this._preGame),
      this.ctx.storage.put('alarmType',    this._alarmType),
    ]);
  }

  private async ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this._loaded) return;
      const [meta, agents, agentTeam, teams, teamCounter, chat, preGame, alarmType] = await Promise.all([
        this.ctx.storage.get<LobbyMeta>('meta'),
        this.ctx.storage.get<AgentEntry[]>('agents'),
        this.ctx.storage.get<Record<string, string>>('agentTeam'),
        this.ctx.storage.get<TeamEntry[]>('teams'),
        this.ctx.storage.get<number>('teamCounter'),
        this.ctx.storage.get<ChatMessage[]>('chat'),
        this.ctx.storage.get<PreGameState | null>('preGame'),
        this.ctx.storage.get<AlarmType | null>('alarmType'),
      ]);

      this._meta         = meta        ?? null;
      this._agents       = agents      ?? [];
      this._agentTeam    = agentTeam   ?? {};
      this._teams        = teams       ?? [];
      this._teamCounter  = teamCounter ?? 0;
      this._chat         = chat        ?? [];
      this._preGame      = preGame     ?? null;
      this._alarmType    = alarmType   ?? null;
      this._loaded       = true;
    });
  }
}
