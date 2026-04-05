import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';

import {
  Hex,
  generateMap,
  TileType,
  GameMap,
  getUnitVision,
  hexToString,
  CLASS_VISION,
  LobbyManager as EngineLobbyManager,
  CtlOutcome,
} from '@coordination-games/game-ctl';
import {
  type CtlSession,
  type GameUnit,
  type FlagState,
  type GamePhase,
  type TurnRecord,
  type UnitClass,
  type Direction,
  type GameConfig,
  submitCtlMove,
  allMovesSubmitted,
  resolveCtlTurn,
  getStateForAgent,
  isGameOver,
  createCtlSession,
  getTurnHistory,
  getMapRadiusForTeamSize,
  getTurnLimitForRadius,
  CaptureTheLobsterPlugin,
} from './game-session.js';
import { EloTracker } from '@coordination-games/plugin-elo';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';
import { runAllBotsTurn, createBotSessions, BotSession } from './claude-bot.js';
import { LobbyRunner, LobbyRunnerState } from './lobby-runner.js';
import {
  createBotToken,
  notifyTurnResolved,
  notifyAgent,
  getAgentName,
  getAgentIdFromToken,
  tokenRegistry,
  handleRegistry,
  TOKEN_TTL_MS,
  waitForNextTurn,
  waitForAgentUpdate,
  buildUpdates,
  hasPendingUpdates,
  setAgentLastTurn,
  hasAgentMissedTurn,
  GAME_RULES,
  type GameResolver,
  type LobbyResolver,
  type RelayResolver,
} from './mcp-http.js';
import { createRelayRouter } from './relay.js';
import { GameRelay, type RelayMessage } from './typed-relay.js';
import { buildGameMerkleTree, type MerkleLeafData } from '@coordination-games/engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpectatorTile {
  q: number;
  r: number;
  type: TileType;
  unit?: {
    id: string;
    team: 'A' | 'B';
    unitClass: UnitClass;
    carryingFlag?: boolean;
    alive: boolean;
    respawnTurn?: number;
  };
  units?: {
    id: string;
    team: 'A' | 'B';
    unitClass: UnitClass;
    carryingFlag?: boolean;
    alive: boolean;
    respawnTurn?: number;
  }[];
  flag?: { team: 'A' | 'B' };
}

export interface SpectatorState {
  turn: number;
  maxTurns: number;
  phase: GamePhase;
  tiles: SpectatorTile[];
  units: {
    id: string;
    team: 'A' | 'B';
    unitClass: UnitClass;
    position: Hex;
    alive: boolean;
    carryingFlag: boolean;
    respawnTurn?: number;
  }[];
  kills: { killerId: string; victimId: string; reason: string }[];
  chatA: { from: string; message: string; turn: number }[];
  chatB: { from: string; message: string; turn: number }[];
  flagA: { status: 'at_base' | 'carried'; carrier?: string };
  flagB: { status: 'at_base' | 'carried'; carrier?: string };
  score: { A: number; B: number };
  winner: 'A' | 'B' | null;
  mapRadius: number;
  visibleA: string[];  // hex keys visible to team A
  visibleB: string[];  // hex keys visible to team B
  visibleByUnit: Record<string, string[]>;  // per-unit vision for spectator drill-down
  turnTimeoutMs: number;
  turnStartedAt: number;  // epoch ms
  /** Maps agent IDs to display names (e.g. "agent_1" -> "Pinchy") */
  handles: Record<string, string>;
  /** Relay messages for this turn (spectators see all, agents see scoped) */
  relayMessages?: RelayMessage[];
}

export interface ExternalSlot {
  token: string;
  agentId: string;
  connected: boolean;
}

export interface GameRoom {
  game: CtlSession;
  spectators: Set<WebSocket>;
  stateHistory: SpectatorState[];   // indexed by turn
  spectatorDelay: number;           // turns of delay (default 5)
  turnTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  botHandles: string[];             // handles of bot players in this room
  botMeta: { id: string; unitClass: UnitClass; team: 'A' | 'B' }[];
  botSessions: BotSession[];
  finished: boolean;
  turnInProgress: boolean;
  // External agent slots
  externalSlots: Map<string, ExternalSlot>;  // agentId -> slot info
  // Event-driven turn: resolve callback for early completion
  turnResolve: (() => void) | null;
  turnTimeoutMs: number;
  /** Agent ID -> display name */
  handleMap: Record<string, string>;
  /** Chat from the lobby phase (preserved for spectators) */
  lobbyChat: { from: string; message: string; timestamp: number }[];
  /** Pre-game team chat (preserved for spectators) */
  preGameChatA: { from: string; message: string; timestamp: number }[];
  preGameChatB: { from: string; message: string; timestamp: number }[];
  /** Typed relay for plugin data between agents */
  relay: GameRelay;
}

// ---------------------------------------------------------------------------
// Game result helpers
// ---------------------------------------------------------------------------

function buildGameResultFromSession(
  session: CtlSession,
  gameId: string,
  playerIds: string[],
) {
  const turnHistory = getTurnHistory(session);
  const turns = turnHistory.map((record) => ({
    turnNumber: record.turn,
    moves: [...record.moves.entries()].map(([playerId, path]) => ({
      turnNumber: record.turn,
      playerId,
      moveData: JSON.stringify(path),
    } as MerkleLeafData)),
  }));
  const tree = buildGameMerkleTree(turns);

  return {
    gameId,
    gameType: 'capture-the-lobster',
    players: playerIds,
    outcome: {
      winner: session.state.winner,
      score: { ...session.state.score },
      turnCount: session.state.turn,
    },
    movesRoot: tree.root,
    configHash: '',
    turnCount: turnHistory.length,
    timestamp: Date.now(),
  };
}

function computePayoutsFromSession(
  session: CtlSession,
  playerIds: string[],
): Map<string, number> {
  const outcome: CtlOutcome = {
    winner: session.state.winner,
    score: { ...session.state.score },
    turnCount: session.state.turn,
    playerStats: new Map(),
  };

  for (const unit of session.state.units) {
    outcome.playerStats.set(unit.id, {
      team: unit.team,
      kills: 0,
      deaths: 0,
      flagCarries: 0,
      flagCaptures: 0,
    });
  }

  return CaptureTheLobsterPlugin.computePayouts(outcome, playerIds);
}

// ---------------------------------------------------------------------------
// Bot display names (shared with lobby-runner)
// ---------------------------------------------------------------------------

const BOT_DISPLAY_NAMES = [
  'Pinchy', 'Clawdia', 'Sheldon', 'Snappy',
  'Bubbles', 'Coral', 'Neptune', 'Triton',
  'Marina', 'Squidward', 'Barnacle', 'Anchovy',
];

// ---------------------------------------------------------------------------
// Spectator state builder
// ---------------------------------------------------------------------------

function buildSpectatorState(game: CtlSession, handles: Record<string, string> = {}, relay?: GameRelay): SpectatorState {
  const map = { tiles: new Map(game.state.mapTiles), radius: game.state.mapRadius, bases: game.state.mapBases };
  const { units, flags, turn, phase, config, score } = game.state;

  // Build full tile array (no fog — spectators see everything)
  const tiles: SpectatorTile[] = [];
  const unitsByHex = new Map<string, GameUnit[]>();
  for (const u of units) {
    // Include all units (alive and dead) — dead units shown at spawn with skull
    const key = `${u.position.q},${u.position.r}`;
    const list = unitsByHex.get(key) ?? [];
    list.push(u);
    unitsByHex.set(key, list);
  }

  const flagsByHex = new Map<string, 'A' | 'B'>();
  for (const team of ['A', 'B'] as const) {
    const teamFlags = flags[team];
    for (const f of teamFlags) {
      flagsByHex.set(`${f.position.q},${f.position.r}`, team);
    }
  }

  for (const [key, tileType] of map.tiles) {
    const [qStr, rStr] = key.split(',');
    const q = Number(qStr);
    const r = Number(rStr);
    const tile: SpectatorTile = { q, r, type: tileType as TileType };

    const unitsHere = unitsByHex.get(key);
    if (unitsHere && unitsHere.length > 0) {
      // Primary unit (first one)
      const primary = unitsHere[0];
      tile.unit = {
        id: primary.id,
        team: primary.team,
        unitClass: primary.unitClass,
        carryingFlag: primary.carryingFlag || undefined,
        alive: primary.alive,
        respawnTurn: primary.respawnTurn,
      };
      // Additional units on same hex
      if (unitsHere.length > 1) {
        tile.units = unitsHere.map((u) => ({
          id: u.id,
          team: u.team,
          unitClass: u.unitClass,
          carryingFlag: u.carryingFlag || undefined,
          alive: u.alive,
          respawnTurn: u.respawnTurn,
        }));
      }
    }

    const flagTeam = flagsByHex.get(key);
    if (flagTeam !== undefined) {
      tile.flag = { team: flagTeam };
    }

    tiles.push(tile);
  }

  // Kills from most recent turn
  const history = getTurnHistory(game);
  const lastRecord = history.length > 0 ? history[history.length - 1] : null;
  const kills = lastRecord?.kills ?? [];

  // Build flag status summaries
  function flagStatus(flagArr: FlagState[]): { status: 'at_base' | 'carried'; carrier?: string } {
    // Report 'carried' if any flag in the array is carried
    for (const f of flagArr) {
      if (f.carried && f.carrierId) {
        return { status: 'carried', carrier: f.carrierId };
      }
    }
    return { status: 'at_base' };
  }

  // Compute per-team fog of war
  const walls = new Set<string>();
  const allHexKeys = new Set<string>();
  for (const [key, tileType] of map.tiles) {
    allHexKeys.add(key);
    if (tileType === 'wall') walls.add(key);
  }

  const visibleA = new Set<string>();
  const visibleB = new Set<string>();
  const visibleByUnit: Record<string, string[]> = {};
  for (const u of units) {
    if (!u.alive) continue;
    const unitVision = getUnitVision(
      { id: u.id, position: u.position, unitClass: u.unitClass, team: u.team, alive: u.alive } as any,
      walls,
      allHexKeys,
    );
    visibleByUnit[u.id] = [...unitVision];
    const targetSet = u.team === 'A' ? visibleA : visibleB;
    for (const hex of unitVision) {
      targetSet.add(hex);
    }
  }

  return {
    turn,
    maxTurns: config.turnLimit,
    phase,
    tiles,
    units: units.map((u) => ({
      id: u.id,
      team: u.team,
      unitClass: u.unitClass,
      position: { ...u.position },
      alive: u.alive,
      carryingFlag: u.carryingFlag,
      respawnTurn: u.respawnTurn,
    })),
    kills,
    chatA: relay ? relay.getSpectatorMessages(turn).filter(m => m.type === 'messaging' && m.scope === 'team' && units.some(u => u.id === m.sender && u.team === 'A')).map(m => ({ from: m.sender, message: (m.data as { body?: string })?.body ?? '', turn: m.turn })) : [],
    chatB: relay ? relay.getSpectatorMessages(turn).filter(m => m.type === 'messaging' && m.scope === 'team' && units.some(u => u.id === m.sender && u.team === 'B')).map(m => ({ from: m.sender, message: (m.data as { body?: string })?.body ?? '', turn: m.turn })) : [],
    flagA: flagStatus(flags.A),
    flagB: flagStatus(flags.B),
    score: { A: score.A, B: score.B },
    winner: game.state.winner ?? null,
    mapRadius: map.radius,
    visibleA: [...visibleA],
    visibleB: [...visibleB],
    visibleByUnit,
    turnTimeoutMs: 30000,
    turnStartedAt: Date.now(),
    handles,
  };
}

// ---------------------------------------------------------------------------
// Helper: delayed state for spectators
// ---------------------------------------------------------------------------

function getDelayedState(room: GameRoom): SpectatorState | null {
  const delayedTurn = room.game.state.turn - room.spectatorDelay;
  const idx = Math.max(0, delayedTurn);
  if (room.stateHistory.length === 0) return null;
  if (idx >= room.stateHistory.length) {
    return room.stateHistory[room.stateHistory.length - 1];
  }
  return room.stateHistory[idx];
}

// ---------------------------------------------------------------------------
// Lobby room for spectators
// ---------------------------------------------------------------------------

export interface LobbyRoom {
  runner: LobbyRunner;
  spectators: Set<WebSocket>;
  state: LobbyRunnerState | null;
  // External agent slots for this lobby
  externalSlots: Map<string, ExternalSlot>;
  lobbyManager: EngineLobbyManager | null;
}

// ---------------------------------------------------------------------------
// GameServer
// ---------------------------------------------------------------------------

export class GameServer {
  private app: any;
  private server: http.Server;
  private wss: WebSocketServer;
  readonly elo: EloTracker;

  readonly games: Map<string, GameRoom> = new Map();
  readonly lobbies: Map<string, LobbyRoom> = new Map();
  private maxConcurrentGames: number = 1; // Beta limit — prevents credit drain

  /** Maps external agentId -> gameId for game resolution */
  private agentToGame: Map<string, string> = new Map();
  /** Maps external agentId -> lobbyId for lobby resolution */
  private agentToLobby: Map<string, string> = new Map();

  /** Server URL for bot connections (base URL — bots connect via coga subprocess) */
  private serverUrl: string;

  constructor(port?: number) {
    const effectivePort = port ?? (Number(process.env.PORT) || 3000);
    this.serverUrl = process.env.GAME_SERVER_URL ?? `http://localhost:${effectivePort}`;
    this.app = express();
    this.app.use(express.json());

    // Serve static frontend if built
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const webDistPath = path.resolve(__dirname, '../../web/dist');
    this.app.use(express.static(webDistPath));

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
    this.elo = new EloTracker(path.resolve(__dirname, '../../elo.db'));

    // Ping all WebSocket clients every 30s to keep connections alive through Cloudflare tunnel
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      });
    }, 30000);

    this.setupRoutes();
    this.setupWebSocket();

    // MCP endpoint removed — all game operations go through REST at /api/player/*
    // Bots use GameClient + direct Anthropic API (no MCP, no subprocesses).
    // mcp-http.ts is kept as a utility module for token registry, waiters, etc.
  }

  // ---------------------------------------------------------------------------
  // Event-driven turn: callback when any agent submits a move
  // ---------------------------------------------------------------------------

  private onMoveSubmitted(gameId: string, agentId: string): void {
    const room = this.games.get(gameId);
    if (!room || room.finished) return;

    console.log(`[Turn] Move submitted by ${agentId} for game ${gameId}`);

    // Check if all moves are in (both bots and external agents)
    if (allMovesSubmitted(room.game) && room.turnResolve) {
      console.log(`[Turn] All moves submitted for game ${gameId} — resolving early`);
      room.turnResolve();
      room.turnResolve = null;
    }
  }

  // ---------------------------------------------------------------------------
  // REST routes
  // ---------------------------------------------------------------------------

  private setupRoutes(): void {
    const router = express.Router();

    // GET /framework — coordination framework info (available games, version)
    router.get('/framework', (_req, res) => {
      res.json({
        version: '0.1.0',
        games: ['capture-the-lobster'],
        status: 'active',
      });
    });

    // List active lobbies
    router.get('/lobbies', (_req, res) => {
      const list = Array.from(this.lobbies.entries()).map(([id, room]) => ({
        lobbyId: id,
        phase: room.state?.phase ?? 'forming',
        agents: room.state?.agents ?? [],
        teams: room.state?.teams ?? {},
        chat: room.state?.chat ?? [],
        preGame: room.state?.preGame ?? null,
        gameId: room.state?.gameId ?? null,
        spectators: room.spectators.size,
        externalSlots: Array.from(room.externalSlots.values()).map((s) => ({
          agentId: s.agentId,
          connected: s.connected,
        })),
      }));
      res.json(list);
    });

    // Get lobby state
    router.get('/lobbies/:id', (req, res) => {
      const room = this.lobbies.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Lobby not found' });
      // Always compute fresh state for accurate timer
      const freshState = room.runner.getState();
      res.json({
        ...freshState,
        externalSlots: Array.from(room.externalSlots.values()).map((s) => ({
          agentId: s.agentId,
          connected: s.connected,
        })),
      });
    });

    // Start a lobby game (empty, no bots auto-spawned)
    router.post('/lobbies/start', (req, res) => {
      if (this.activeGameCount() >= this.maxConcurrentGames) {
        return res.status(429).json({ error: 'Server busy — a lobby or game is already running. Wait for it to finish.' });
      }
      const teamSize = Math.min(6, Math.max(2, Math.floor((req.body?.teamSize as number) || 2)));
      const timeoutMs = (req.body?.timeoutMs as number) || 600000;
      const { lobbyId } = this.createLobbyGame(teamSize, timeoutMs);
      res.status(201).json({ lobbyId });
    });

    // Create a lobby (empty waiting room)
    router.post('/lobbies/create', (req, res) => {
      if (this.activeGameCount() >= this.maxConcurrentGames) {
        return res.status(429).json({ error: 'Server busy — a lobby or game is already running. Wait for it to finish.' });
      }
      const teamSize = Math.min(6, Math.max(2, Math.floor((req.body?.teamSize as number) || 2)));
      const timeoutMs = (req.body?.timeoutMs as number) || 600000;
      const { lobbyId } = this.createLobbyGame(teamSize, timeoutMs);
      res.status(201).json({ lobbyId, teamSize });
    });

    // Fill remaining lobby slots with bots (requires admin password since bots use API credits)
    router.post('/lobbies/:id/fill-bots', (req, res) => {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (adminPassword && req.body?.password !== adminPassword) {
        return res.status(401).json({ error: 'Admin password required to add bots (they use API credits).' });
      }
      const lobbyRoom = this.lobbies.get(req.params.id);
      if (!lobbyRoom) {
        return res.status(404).json({ error: 'Lobby not found' });
      }
      if (lobbyRoom.state?.phase && lobbyRoom.state.phase !== 'forming') {
        return res.status(400).json({ error: 'Lobby is no longer in forming phase' });
      }
      const totalSlots = (lobbyRoom.runner as any).teamSize * 2;
      const currentAgents = lobbyRoom.runner.lobby.agents.size;
      const slotsToFill = totalSlots - currentAgents;
      if (slotsToFill <= 0) {
        return res.status(400).json({ error: 'Lobby is already full' });
      }
      const added: { agentId: string; handle: string }[] = [];
      for (let i = 0; i < slotsToFill; i++) {
        added.push(lobbyRoom.runner.addBot());
      }
      res.status(201).json({ added, filledSlots: added.length });
    });

    // Disable lobby timeout (keep lobby open indefinitely)
    router.post('/lobbies/:id/no-timeout', (req, res) => {
      const lobbyRoom = this.lobbies.get(req.params.id);
      if (!lobbyRoom) {
        return res.status(404).json({ error: 'Lobby not found' });
      }
      lobbyRoom.runner.disableTimeout();
      res.json({ ok: true });
    });

    // Close/disband a lobby
    router.delete('/lobbies/:id', (req, res) => {
      const lobbyRoom = this.lobbies.get(req.params.id);
      if (!lobbyRoom) {
        return res.status(404).json({ error: 'Lobby not found' });
      }
      lobbyRoom.runner.stop();
      this.lobbies.delete(req.params.id);
      // Clean up agent->lobby mappings
      for (const [agentId, lobbyId] of this.agentToLobby.entries()) {
        if (lobbyId === req.params.id) this.agentToLobby.delete(agentId);
      }
      console.log(`[Lobby] ${req.params.id} disbanded`);
      res.json({ ok: true });
    });

    // (Removed: /api/register — registration now happens via the MCP register tool)

    // List active games
    router.get('/games', (_req, res) => {
      const list = Array.from(this.games.entries()).map(([id, room]) => ({
        id,
        turn: room.game.state.turn,
        maxTurns: room.game.state.config.turnLimit,
        phase: room.game.state.phase,
        winner: room.game.state.winner,
        teams: {
          A: room.game.state.units.filter((u) => u.team === 'A').map((u) => u.id),
          B: room.game.state.units.filter((u) => u.team === 'B').map((u) => u.id),
        },
        spectators: room.spectators.size,
        externalAgents: room.externalSlots.size,
      }));
      res.json(list);
    });

    // Game details
    router.get('/games/:id', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const state = getDelayedState(room);
      if (!state) return res.status(200).json({ phase: 'pre_game' });
      res.json({ ...state, lobbyChat: room.lobbyChat, preGameChatA: room.preGameChatA, preGameChatB: room.preGameChatB });
    });

    // Current spectator state (delayed)
    router.get('/games/:id/state', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const state = getDelayedState(room);
      if (!state) return res.status(200).json({ phase: 'pre_game' });
      res.json(state);
    });

    // Send a relay message (for external agents via REST — internal bots use relay directly)
    router.post('/games/:id/relay', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const { sender, type, data, scope, pluginId } = req.body;
      if (!sender || !type || !scope) {
        return res.status(400).json({ error: 'sender, type, and scope are required' });
      }

      const msg = room.relay.send(sender, room.game.state.turn, {
        type,
        data: data ?? {},
        scope,
        pluginId: pluginId ?? 'unknown',
      });

      // Also push through game session chat if it's a messaging type
      if (type === 'messaging' && data?.body) {
      }

      // Broadcast state update to spectators
      this.broadcastState(room);

      // Notify other agents
      for (const unit of room.game.state.units) {
        if (unit.id !== sender) notifyAgent(unit.id);
      }

      res.json({ ok: true, index: msg.index });
    });

    // Create a bot game (requires admin password since bots use API credits)
    router.post('/games/start', (req, res) => {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (adminPassword && req.body?.password !== adminPassword) {
        return res.status(401).json({ error: 'Admin password required to start bot games (they use API credits).' });
      }
      if (this.activeGameCount() >= this.maxConcurrentGames) {
        return res.status(429).json({ error: 'Server busy — a lobby or game is already running. Wait for it to finish.' });
      }
      const teamSize = (req.body?.teamSize as number) || 4;
      const { gameId } = this.createBotGame(teamSize);
      res.status(201).json({ gameId });
    });

    // Leaderboard
    router.get('/leaderboard', (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const players = this.elo.getLeaderboard(limit, offset);
      res.json(players);
    });

    // Replay data
    router.get('/replays/:id', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      if (room.game.state.phase !== 'finished') {
        return res.status(400).json({ error: 'Game is still in progress' });
      }

      res.json({
        gameId: room.game.gameId,
        turns: room.stateHistory,
        winner: room.game.state.winner,
        score: room.game.state.score,
        mapRadius: room.game.state.mapRadius,
      });
    });

    // -----------------------------------------------------------------------
    // Game bundle & result endpoints (for Merkle verification tooling)
    // -----------------------------------------------------------------------

    // GET /games/:id/bundle — full game bundle for independent verification
    router.get('/games/:id/bundle', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const game = room.game;
      const turnHistory = getTurnHistory(game);

      // Serialize turn history with moves for Merkle tree construction
      const turns = turnHistory.map((turn: TurnRecord, idx: number) => {
        const moves: { player: string; data: string; signature: string }[] = [];
        for (const [unitId, directions] of turn.moves.entries()) {
          moves.push({
            player: unitId,
            data: JSON.stringify(directions),
            signature: (turn as any).signatures?.[unitId] || '0x',
          });
        }
        // Sort by player for deterministic ordering
        moves.sort((a, b) => a.player.localeCompare(b.player));

        return {
          turnNumber: idx + 1,
          moves,
          result: room.stateHistory[idx + 1] || null,
        };
      });

      res.json({
        gameId: game.gameId,
        config: {
          mapRadius: game.state.mapRadius,
          teamSize: game.state.config.teamSize,
          turnLimit: game.state.config.turnLimit,
        },
        turns,
        outcome: {
          winner: game.state.winner,
          score: game.state.score,
          phase: game.state.phase,
        },
      });
    });

    // GET /games/:id/result — on-chain GameResult with Merkle root
    router.get('/games/:id/result', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      if (room.game.state.phase !== 'finished') {
        return res.status(400).json({ error: 'Game is still in progress' });
      }

      try {
        const playerIds = room.game.state.units.map((u) => u.id);
        const result = buildGameResultFromSession(room.game, req.params.id, playerIds);
        const payouts = computePayoutsFromSession(room.game, playerIds);
        res.json({
          ...result,
          payouts: Object.fromEntries(payouts),
        });
      } catch (err: any) {
        const game = room.game;
        res.json({
          gameId: req.params.id,
          gameType: 'capture-the-lobster',
          players: game.state.units.map((u) => u.id),
          outcome: { winner: game.state.winner, score: game.state.score },
          movesRoot: null,
          configHash: null,
          turnCount: game.state.turn,
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
    });

    this.app.use('/api', router);

    // Mount player-facing REST endpoints (replaces MCP tools)
    this.mountPlayerRoutes();

    // Mount on-chain relay routes (only if env vars configured)
    const relayRouter = createRelayRouter();
    if (relayRouter) {
      this.app.use('/api/relay', relayRouter);
    }

    // SPA catch-all: serve index.html for any non-API, non-MCP route
    const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
    const indexPath = path.resolve(__dirname2, '../../web/dist/index.html');
    this.app.get('*', (_req: any, res: any) => {
      // Don't serve index.html for /mcp requests
      if (_req.path === '/mcp') return res.status(404).send('Not found');
      res.sendFile(indexPath);
    });
  }

  // ---------------------------------------------------------------------------
  // Player-facing REST API (replaces MCP tools for agents/CLI)
  // ---------------------------------------------------------------------------

  private mountPlayerRoutes(): void {
    const router = express.Router();

    // Resolver helpers (same logic as MCP callbacks)
    const resolveGame: GameResolver = (agentId: string) => {
      const gameId = this.agentToGame.get(agentId);
      if (!gameId) return null;
      const room = this.games.get(gameId);
      return room?.game ?? null;
    };

    const resolveLobby: LobbyResolver = (agentId: string) => {
      const lobbyId = this.agentToLobby.get(agentId);
      if (!lobbyId) return null;
      const lobbyRoom = this.lobbies.get(lobbyId);
      return lobbyRoom?.lobbyManager ?? null;
    };

    const resolveRelay: RelayResolver = (agentId: string) => {
      const gameId = this.agentToGame.get(agentId);
      if (!gameId) return null;
      const room = this.games.get(gameId);
      return room?.relay ?? null;
    };

    const VALID_DIRECTIONS: Direction[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];

    // Auth middleware: validates Bearer token, attaches agentId to req
    const requirePlayerAuth = (req: any, res: any, next: any) => {
      const authHeader = req.headers['authorization'] as string | undefined;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'auth_required', message: 'Missing Authorization: Bearer <token> header. Authenticate via POST /api/player/auth/challenge + /auth/verify.' });
      }
      const token = authHeader.slice(7);
      const agentId = getAgentIdFromToken(token);
      if (!agentId) {
        return res.status(401).json({ error: 'auth_required', message: 'Invalid or expired token. Re-authenticate via POST /api/player/auth/challenge + /auth/verify.' });
      }
      req.agentId = agentId;
      req.agentName = getAgentName(agentId);
      next();
    };

    // ------------------------------------------------------------------
    // Challenge nonce registry (nonce -> { message, expiresAt })
    // ------------------------------------------------------------------
    const challengeRegistry = new Map<string, { message: string; expiresAt: number }>();

    // Periodically clean expired challenges (every 5 min)
    setInterval(() => {
      const now = Date.now();
      for (const [nonce, entry] of challengeRegistry) {
        if (now > entry.expiresAt) challengeRegistry.delete(nonce);
      }
    }, 5 * 60 * 1000);

    // ------------------------------------------------------------------
    // 1. POST /auth/challenge — Issue a challenge nonce for wallet auth
    // ------------------------------------------------------------------
    router.post('/auth/challenge', (_req, res) => {
      const nonce = crypto.randomBytes(32).toString('hex');
      const message = `Sign this message to authenticate with Coordination Games.\nNonce: ${nonce}`;
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min
      challengeRegistry.set(nonce, { message, expiresAt });
      res.json({ nonce, message, expiresAt: new Date(expiresAt).toISOString() });
    });

    // ------------------------------------------------------------------
    // 2. POST /auth/verify — Verify a signed challenge with real sig check
    // ------------------------------------------------------------------
    router.post('/auth/verify', async (req, res) => {
      try {
        const { nonce, signature, address, name } = req.body ?? {};
        if (!nonce || !signature || !address || !name) {
          return res.status(400).json({ error: 'nonce, signature, address, and name are all required' });
        }

        // Validate the challenge nonce
        const challenge = challengeRegistry.get(nonce);
        if (!challenge || Date.now() > challenge.expiresAt) {
          challengeRegistry.delete(nonce);
          return res.status(401).json({ error: 'Invalid or expired challenge nonce' });
        }
        challengeRegistry.delete(nonce); // consume the nonce (one-time use)

        // Recover the signer address from the signature
        const { ethers } = await import('ethers');
        const recoveredAddress = ethers.verifyMessage(challenge.message, signature);

        if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
          return res.status(401).json({ error: 'Signature verification failed — recovered address does not match' });
        }

        // If on-chain mode is enabled, verify ERC-8004 name ownership
        if (process.env.RPC_URL && process.env.REGISTRY_ADDRESS && process.env.ERC8004_ADDRESS) {
          try {
            const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

            // Check name -> agentId in CoordinationRegistry
            const registryAbi = ['function nameToAgent(bytes32) view returns (uint256)'];
            const registry = new ethers.Contract(process.env.REGISTRY_ADDRESS, registryAbi, provider);
            const nameKey = ethers.keccak256(ethers.toUtf8Bytes(name.toLowerCase()));
            const agentId = await registry.nameToAgent(nameKey);

            if (agentId === 0n) {
              return res.status(401).json({ error: `Name "${name}" is not registered on-chain` });
            }

            // Check agentId -> owner in ERC-8004
            const erc8004Abi = ['function ownerOf(uint256) view returns (address)'];
            const erc8004 = new ethers.Contract(process.env.ERC8004_ADDRESS, erc8004Abi, provider);
            const owner = await erc8004.ownerOf(agentId);

            if (owner.toLowerCase() !== address.toLowerCase()) {
              return res.status(401).json({ error: `Address ${address} does not own name "${name}"` });
            }

            console.log(`[REST] On-chain verified: "${name}" owned by ${address} (agentId: ${agentId})`);
          } catch (chainErr: any) {
            console.error(`[REST] On-chain verification failed:`, chainErr.message);
            return res.status(500).json({ error: 'On-chain verification failed: ' + chainErr.message });
          }
        }

        // Name validated (signature valid, on-chain check passed or skipped in dev mode)
        // Reuse agentId if this name was seen before (enables reconnection)
        const trimmed = name.trim();
        const existingAgentId = handleRegistry.get(trimmed);
        const resolvedAgentId = existingAgentId ?? `ext_${crypto.randomBytes(4).toString('hex')}`;

        if (!existingAgentId) {
          handleRegistry.set(trimmed, resolvedAgentId);
        }

        const token = crypto.randomBytes(5).toString('hex');
        const expiresAt = Date.now() + TOKEN_TTL_MS;
        tokenRegistry.set(token, { agentId: resolvedAgentId, name: trimmed, expiresAt });

        console.log(`[REST] Auth verified for "${trimmed}" (agentId: ${resolvedAgentId}, address: ${address})${existingAgentId ? ' (reconnected)' : ''}`);
        res.json({
          token,
          agentId: resolvedAgentId,
          name: trimmed,
          expiresAt: new Date(expiresAt).toISOString(),
          reconnected: !!existingAgentId,
        });
      } catch (err: any) {
        console.error(`[REST] Auth verify error:`, err);
        res.status(500).json({ error: 'Internal server error during auth verification' });
      }
    });

    // ------------------------------------------------------------------
    // 4. GET /guide — Dynamic playbook
    // ------------------------------------------------------------------
    router.get('/guide', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;

      let playerState = '';
      const game = resolveGame(agentId);
      const lobby = resolveLobby(agentId);

      if (game) {
        playerState = `\n## Your Status\n- **Phase:** ${game.state.phase}\n- **Turn:** ${game.state.turn}\n`;
        const unit = game.state.units.find((u: any) => u.id === agentId);
        if (unit) {
          playerState += `- **Team:** ${unit.team}\n- **Class:** ${unit.unitClass}\n- **Alive:** ${unit.alive}\n`;
        }
      } else if (lobby) {
        playerState += `\n## Your Status\n- **Phase:** ${lobby.phase}\n- **Lobby:** active\n`;
      } else {
        playerState += `\n## Your Status\n- Not in a game or lobby. Use join_lobby or create_lobby to find a game.\n`;
      }

      const phase = game?.state.phase ?? lobby?.phase ?? 'none';
      let availableTools = '\n## Available Endpoints\n';
      availableTools += '- `GET /guide` -- this playbook\n';
      availableTools += '- `POST /auth/challenge` + `POST /auth/verify` -- wallet auth (handled by CLI)\n';

      if (!game && !lobby) {
        availableTools += '- `POST /lobby/join` / `POST /lobby/create` -- find a game\n';
      } else if (lobby && lobby.phase === 'forming') {
        availableTools += '- `POST /team/propose` / `POST /team/accept` / `POST /team/leave` -- form teams\n';
        availableTools += '- `POST /chat` -- talk to everyone in the lobby\n';
        availableTools += '- `GET /wait` -- wait for changes\n';
      } else if (lobby && lobby.phase === 'pre_game') {
        availableTools += '- `POST /class` -- pick your class\n';
        availableTools += '- `POST /chat` -- team chat\n';
        availableTools += '- `GET /wait` -- wait for changes\n';
      } else if (game && game.state.phase === 'in_progress') {
        availableTools += '- `GET /wait` -- YOUR MAIN LOOP\n';
        availableTools += '- `POST /move` -- submit a move\n';
        availableTools += '- `POST /chat` -- team-only chat\n';
        availableTools += '- `GET /state` -- bootstrap/recovery only\n';
      }

      const pluginInfo = `\n## Required Plugins\n` +
        `This game requires: **${(CaptureTheLobsterPlugin.requiredPlugins ?? []).join(', ') || 'none'}**\n` +
        `Recommended: **${(CaptureTheLobsterPlugin.recommendedPlugins ?? []).join(', ') || 'none'}**\n`;

      res.json({ guide: GAME_RULES + pluginInfo + playerState + availableTools });
    });

    // ------------------------------------------------------------------
    // 5. GET /state — Get current state (fog-filtered)
    // ------------------------------------------------------------------
    router.get('/state', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;

      const game = resolveGame(agentId);
      if (game) {
        const state = getStateForAgent(game, agentId);
        const relay = resolveRelay(agentId);
        const relayMessages = relay?.receive(agentId) ?? [];
        if (game.state.phase === 'finished') {
          return res.json({ phase: 'finished', gameOver: true, winner: game.state.winner, ...state, relayMessages });
        }
        return res.json({ phase: 'game', ...state, relayMessages });
      }

      const lobby = resolveLobby(agentId);
      if (lobby) {
        if (lobby.phase === 'forming') {
          return res.json({ phase: 'forming', ...lobby.getLobbyState(agentId) });
        }
        if (lobby.phase === 'pre_game') {
          const teamState = lobby.getTeamState(agentId);
          return res.json({ phase: 'pre_game', ...teamState });
        }
        return res.json({ phase: lobby.phase });
      }

      return res.status(404).json({ error: 'No active lobby or game. Join a lobby first.' });
    });

    // ------------------------------------------------------------------
    // 6. GET /wait — Long-polling wait for updates
    // ------------------------------------------------------------------
    router.get('/wait', requirePlayerAuth, async (req: any, res: any) => {
      const agentId = req.agentId as string;

      const game = resolveGame(agentId);
      const lobby = resolveLobby(agentId);

      // === Game phase ===
      if (game) {
        if (game.state.phase === 'finished') {
          const state = getStateForAgent(game, agentId);
          return res.json({ reason: 'game_over', gameOver: true, winner: game.state.winner, ...state });
        }

        // If the turn advanced since agent last got full state, return full state
        if (hasAgentMissedTurn(agentId, game.state.turn)) {
          const state = getStateForAgent(game, agentId);
          setAgentLastTurn(agentId, game.state.turn);
          buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'turn_changed', moveSubmitted: game.hasSubmitted(agentId), ...state });
        }

        // Pending updates? Return immediately
        if (hasPendingUpdates(agentId, resolveGame, resolveLobby, resolveRelay)) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'update', ...updates });
        }

        // No move yet: return full state
        if (!game.hasSubmitted(agentId)) {
          const state = getStateForAgent(game, agentId);
          setAgentLastTurn(agentId, game.state.turn);
          return res.json({ reason: 'new_turn', moveSubmitted: false, ...state });
        }

        // Move submitted — block until turn resolution, chat, or timeout
        const prevTurn = game.state.turn;
        await Promise.race([
          waitForNextTurn(game.gameId, 25000),
          waitForAgentUpdate(agentId, 25000),
        ]);

        const updatedGame = resolveGame(agentId);
        if (!updatedGame) return res.json({ reason: 'game_ended' });

        if (updatedGame.state.phase === 'finished') {
          const state = getStateForAgent(updatedGame, agentId);
          return res.json({ reason: 'game_over', gameOver: true, winner: updatedGame.state.winner, ...state });
        }

        if (updatedGame.state.turn > prevTurn) {
          const state = getStateForAgent(updatedGame, agentId);
          setAgentLastTurn(agentId, updatedGame.state.turn);
          return res.json({ reason: 'turn_changed', ...state });
        }

        const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
        return res.json({ reason: 'update', ...updates });
      }

      // === Lobby phase ===
      if (lobby) {
        if (hasPendingUpdates(agentId, resolveGame, resolveLobby, resolveRelay)) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'update', ...updates });
        }

        const prevPhase = lobby.phase;
        await waitForAgentUpdate(agentId, 25000);

        // After waking, check if game started
        const newGame = resolveGame(agentId);
        if (newGame) {
          const state = getStateForAgent(newGame, agentId);
          return res.json({ reason: 'game_started', phase: 'game', ...state });
        }

        const updatedLobby = resolveLobby(agentId);
        if (!updatedLobby) return res.json({ reason: 'lobby_ended' });

        if (updatedLobby.phase !== prevPhase) {
          if (updatedLobby.phase === 'forming') {
            return res.json({ reason: 'phase_changed', phase: 'forming', ...updatedLobby.getLobbyState(agentId) });
          }
          if (updatedLobby.phase === 'pre_game') {
            const teamState = updatedLobby.getTeamState(agentId);
            return res.json({ reason: 'phase_changed', phase: 'pre_game', ...teamState });
          }
          return res.json({ reason: 'phase_changed', phase: updatedLobby.phase });
        }

        const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
        return res.json({ reason: 'update', ...updates });
      }

      return res.status(404).json({ error: 'No active lobby or game. Join a lobby first.' });
    });

    // ------------------------------------------------------------------
    // 7. POST /move — Submit a move
    // ------------------------------------------------------------------
    router.post('/move', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const { path, action, target, class: unitClass } = req.body ?? {};

      // Lobby phase actions via generic move
      if (action) {
        const lobby = resolveLobby(agentId);
        if (!lobby) return res.status(400).json({ error: 'No lobby available for this action.' });

        switch (action) {
          case 'propose-team': {
            if (!target) return res.status(400).json({ error: 'propose-team requires "target" (agentId).' });
            if (lobby.phase !== 'forming') return res.status(400).json({ error: 'Team proposals only during forming phase.' });
            const result = lobby.proposeTeam(agentId, target);
            if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed.' });
            const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
            return res.json({ success: true, teamId: result.teamId, ...updates });
          }
          case 'accept-team': {
            if (!target) return res.status(400).json({ error: 'accept-team requires "target" (teamId).' });
            if (lobby.phase !== 'forming') return res.status(400).json({ error: 'Team acceptance only during forming phase.' });
            const result = lobby.acceptTeam(agentId, target);
            if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed.' });
            const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
            return res.json({ success: true, ...updates });
          }
          case 'leave-team': {
            if (lobby.phase !== 'forming') return res.status(400).json({ error: 'Can only leave teams during forming phase.' });
            const result = lobby.leaveTeam(agentId);
            if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed.' });
            const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
            return res.json({ success: true, ...updates });
          }
          case 'choose-class': {
            const cls = unitClass ?? target;
            if (!cls || !['rogue', 'knight', 'mage'].includes(cls)) {
              return res.status(400).json({ error: 'choose-class requires "class" (rogue, knight, or mage).' });
            }
            if (lobby.phase !== 'pre_game') return res.status(400).json({ error: 'Class selection only during pre-game phase.' });
            const result = lobby.chooseClass(agentId, cls as UnitClass);
            if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed.' });
            const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
            return res.json({ success: true, class: cls, ...updates });
          }
          default:
            return res.status(400).json({ error: `Unknown action "${action}". Valid: propose-team, accept-team, leave-team, choose-class` });
        }
      }

      // Gameplay move (direction path)
      const game = resolveGame(agentId);
      if (!game) return res.status(400).json({ error: 'No game in progress.' });
      if (game.state.phase !== 'in_progress') return res.status(400).json({ error: `Cannot submit moves -- game phase is: ${game.state.phase}` });

      const movePath = path ?? [];
      if (!Array.isArray(movePath)) return res.status(400).json({ error: 'path must be an array of direction strings' });
      for (const dir of movePath) {
        if (!VALID_DIRECTIONS.includes(dir as Direction)) {
          return res.status(400).json({ error: `Invalid direction "${dir}". Valid: ${VALID_DIRECTIONS.join(', ')}` });
        }
      }

      const directions = movePath as Direction[];
      const result = submitCtlMove(game, agentId, directions);
      if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to submit move.' });
      this.onMoveSubmitted(game.gameId, agentId);
      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, path: directions, ...updates });
    });

    // (No dedicated /chat endpoint — chat goes through /tool as basic-chat:chat)

    // ------------------------------------------------------------------
    // 9. POST /lobby/join — Join a lobby
    // ------------------------------------------------------------------
    router.post('/lobby/join', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const agentName = req.agentName as string;
      const { lobbyId } = req.body ?? {};
      if (!lobbyId) return res.status(400).json({ error: 'lobbyId is required' });

      const lobbyRoom = this.lobbies.get(lobbyId);
      if (!lobbyRoom) return res.status(404).json({ error: 'Lobby not found' });

      // Track the slot
      lobbyRoom.externalSlots.set(agentId, { token: '', agentId, connected: true });
      this.agentToLobby.set(agentId, lobbyId);

      // Add agent to the lobby manager
      if (lobbyRoom.lobbyManager) {
        lobbyRoom.lobbyManager.addAgent({ id: agentId, handle: agentName, elo: 1000 });
      }

      console.log(`[REST] Agent ${agentId} (${agentName}) joined lobby ${lobbyId}`);
      lobbyRoom.runner.emitState();

      // Notify other agents
      if (lobbyRoom.lobbyManager) {
        for (const [id] of lobbyRoom.lobbyManager.agents) {
          if (id !== agentId) notifyAgent(id);
        }
      }

      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, agentId, lobbyId, ...updates });
    });

    // ------------------------------------------------------------------
    // 10. POST /lobby/create — Create a lobby
    // ------------------------------------------------------------------
    router.post('/lobby/create', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const agentName = req.agentName as string;

      if (this.activeGameCount() >= this.maxConcurrentGames) {
        return res.status(429).json({ error: 'Server busy -- a lobby or game is already running.' });
      }

      const teamSize = Math.min(6, Math.max(2, Math.floor((req.body?.teamSize as number) || 2)));
      const { lobbyId } = this.createLobbyGame(teamSize, 600000);
      const lobbyRoom = this.lobbies.get(lobbyId)!;

      // Auto-join the creator
      lobbyRoom.externalSlots.set(agentId, { token: '', agentId, connected: true });
      this.agentToLobby.set(agentId, lobbyId);
      if (lobbyRoom.lobbyManager) {
        lobbyRoom.lobbyManager.addAgent({ id: agentId, handle: agentName, elo: 1000 });
      }
      lobbyRoom.runner.emitState();

      console.log(`[REST] Agent ${agentId} (${agentName}) created and joined lobby ${lobbyId} (${teamSize}v${teamSize})`);

      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, lobbyId, teamSize, ...updates });
    });

    // ------------------------------------------------------------------
    // 11. POST /team/propose — Propose team
    // ------------------------------------------------------------------
    router.post('/team/propose', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const { agentId: targetAgentId } = req.body ?? {};
      if (!targetAgentId) return res.status(400).json({ error: 'agentId (target) is required' });

      const lobby = resolveLobby(agentId);
      if (!lobby) return res.status(400).json({ error: 'No lobby available.' });
      if (lobby.phase !== 'forming') return res.status(400).json({ error: 'Team proposals only during forming phase.' });

      const result = lobby.proposeTeam(agentId, targetAgentId);
      if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to propose team.' });

      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({
        success: true,
        teamId: result.teamId,
        message: `Invited ${targetAgentId} to ${result.teamId}. They need to call accept_team.`,
        ...updates,
      });
    });

    // ------------------------------------------------------------------
    // 12. POST /team/accept — Accept team invite
    // ------------------------------------------------------------------
    router.post('/team/accept', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const { teamId } = req.body ?? {};
      if (!teamId) return res.status(400).json({ error: 'teamId is required' });

      const lobby = resolveLobby(agentId);
      if (!lobby) return res.status(400).json({ error: 'No lobby available.' });
      if (lobby.phase !== 'forming') return res.status(400).json({ error: 'Team acceptance only during forming phase.' });

      const result = lobby.acceptTeam(agentId, teamId);
      if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to accept team.' });

      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, ...updates });
    });

    // ------------------------------------------------------------------
    // 13. POST /team/leave — Leave team
    // ------------------------------------------------------------------
    router.post('/team/leave', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;

      const lobby = resolveLobby(agentId);
      if (!lobby) return res.status(400).json({ error: 'No lobby available.' });
      if (lobby.phase !== 'forming') return res.status(400).json({ error: 'Can only leave teams during forming phase.' });

      const result = lobby.leaveTeam(agentId);
      if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to leave team.' });

      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, message: 'You left your team.', ...updates });
    });

    // ------------------------------------------------------------------
    // 14. POST /class — Choose class
    // ------------------------------------------------------------------
    router.post('/class', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const { class: cls } = req.body ?? {};
      if (!cls || !['rogue', 'knight', 'mage'].includes(cls)) {
        return res.status(400).json({ error: 'class is required: "rogue", "knight", or "mage"' });
      }

      const lobby = resolveLobby(agentId);
      if (!lobby) return res.status(400).json({ error: 'No lobby available.' });
      if (lobby.phase !== 'pre_game') return res.status(400).json({ error: 'Class selection only during pre-game phase.' });

      const result = lobby.chooseClass(agentId, cls as UnitClass);
      if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to choose class.' });

      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, class: cls, ...updates });
    });

    // ------------------------------------------------------------------
    // 8. POST /tool — Generic plugin tool invocation
    // Calls plugin.handleCall(), sends relay data if returned, returns updates.
    // This is THE way plugins produce data — no special cases.
    // ------------------------------------------------------------------
    router.post('/tool', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const { pluginId, tool: toolName, args } = req.body ?? {};
      if (!pluginId || !toolName) {
        return res.status(400).json({ error: 'pluginId and tool are required' });
      }

      // Look up the plugin — for now, hardcoded registry. TODO: dynamic plugin loader.
      const pluginRegistry: Record<string, any> = {
        'basic-chat': BasicChatPlugin,
      };
      const plugin = pluginRegistry[pluginId];
      if (!plugin || !plugin.handleCall) {
        return res.status(404).json({ error: `Plugin "${pluginId}" not found or has no handleCall` });
      }

      // Check the tool exists on this plugin
      const toolDef = (plugin.tools ?? []).find((t: any) => t.name === toolName);
      if (!toolDef) {
        return res.status(404).json({ error: `Plugin "${pluginId}" has no tool "${toolName}"` });
      }

      // Call the plugin's handler
      const callerInfo = { id: agentId, handle: getAgentName(agentId) };
      const result = plugin.handleCall(toolName, args, callerInfo);

      // If the plugin returned relay data, send it through the relay
      if (result && (result as any).relay) {
        const relayData = (result as any).relay;
        let scope = relayData.scope ?? 'all';

        // Resolve 'auto' scope based on current phase
        if (scope === 'auto') {
          const game = resolveGame(agentId);
          const lobby = resolveLobby(agentId);
          if (game && (game.state.phase === 'in_progress' || game.state.phase === 'pre_game')) {
            scope = 'team';
          } else if (lobby && lobby.phase === 'pre_game') {
            scope = 'team';
          } else {
            scope = 'all';
          }
        }

        // Send through relay (game phase) or lobby chat (lobby phase)
        const game = resolveGame(agentId);
        const lobby = resolveLobby(agentId);

        if (game) {
          const gameId = this.agentToGame.get(agentId)!;
          const room = this.games.get(gameId);
          if (room) {
            room.relay.send(agentId, game.state.turn, {
              type: relayData.type,
              data: relayData.data,
              scope,
              pluginId: relayData.pluginId ?? pluginId,
            });
            this.broadcastState(room);
            for (const unit of game.state.units) {
              if (unit.id !== agentId) notifyAgent(unit.id);
            }
          }
        } else if (lobby) {
          // Lobby phase: use lobby's built-in chat for messaging type
          if (relayData.type === 'messaging' && relayData.data?.body) {
            if (lobby.phase === 'forming') {
              lobby.lobbyChat(agentId, relayData.data.body);
            } else if (lobby.phase === 'pre_game') {
              lobby.teamChat(agentId, relayData.data.body);
            }
            const lobbyId = this.agentToLobby.get(agentId);
            if (lobbyId) {
              const lobbyRoom = this.lobbies.get(lobbyId);
              if (lobbyRoom) {
                lobbyRoom.runner.emitState();
                for (const [id] of lobby.agents) {
                  if (id !== agentId) notifyAgent(id);
                }
              }
            }
          }
        }
      }

      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, ...updates });
    });

    // ------------------------------------------------------------------
    // 15. GET /leaderboard — Leaderboard
    // ------------------------------------------------------------------
    router.get('/leaderboard', requirePlayerAuth, (req: any, res: any) => {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const players = this.elo.getLeaderboard(limit, offset);
      res.json(players.map((p: any, i: number) => ({
        rank: offset + i + 1,
        handle: p.handle,
        elo: p.elo,
        gamesPlayed: p.gamesPlayed,
        wins: p.wins,
      })));
    });

    // ------------------------------------------------------------------
    // 16. GET /stats — Player's own stats
    // ------------------------------------------------------------------
    router.get('/stats', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const name = getAgentName(agentId);

      const player = this.elo.getPlayerByHandle(name);
      if (!player) return res.json({ message: 'No games played yet. Your ELO starts at 1200.' });

      const leaderboard = this.elo.getLeaderboard(1000, 0);
      const rank = leaderboard.findIndex((p: any) => p.handle === name) + 1;

      res.json({
        handle: player.handle,
        elo: player.elo,
        rank: rank || 0,
        gamesPlayed: player.gamesPlayed,
        wins: player.wins,
      });
    });

    this.app.use('/api/player', router);
    console.log('[REST] Player-facing REST API mounted at /api/player');
  }

  // ---------------------------------------------------------------------------
  // WebSocket upgrade handling
  // ---------------------------------------------------------------------------

  private setupWebSocket(): void {
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`);

      // Game WebSocket: /ws/game/:id
      const gameMatch = url.pathname.match(/^\/ws\/game\/(.+)$/);
      if (gameMatch) {
        const gameId = gameMatch[1];
        const room = this.games.get(gameId);
        if (!room) {
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(request, socket, head, (ws) => {
          room.spectators.add(ws);

          // Send current (delayed) state
          const state = getDelayedState(room);
          if (state) {
            ws.send(JSON.stringify({ type: 'state_update', data: state }));
          }

          ws.on('close', () => {
            room.spectators.delete(ws);
          });

          ws.on('error', () => {
            room.spectators.delete(ws);
          });
        });
        return;
      }

      // Lobby WebSocket: /ws/lobby/:id
      const lobbyMatch = url.pathname.match(/^\/ws\/lobby\/(.+)$/);
      if (lobbyMatch) {
        const lobbyId = lobbyMatch[1];
        const lobbyRoom = this.lobbies.get(lobbyId);
        if (!lobbyRoom) {
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(request, socket, head, (ws) => {
          lobbyRoom.spectators.add(ws);

          // Send current state (fresh for accurate timer)
          ws.send(JSON.stringify({ type: 'lobby_update', data: lobbyRoom.runner.getState() }));

          ws.on('close', () => {
            lobbyRoom.spectators.delete(ws);
          });

          ws.on('error', () => {
            lobbyRoom.spectators.delete(ws);
          });
        });
        return;
      }

      socket.destroy();
    });
  }

  // ---------------------------------------------------------------------------
  // Broadcast to spectators
  // ---------------------------------------------------------------------------

  private broadcastState(room: GameRoom): void {
    const state = getDelayedState(room);
    if (!state) return;

    // Include delayed relay messages for spectators (they see everything, with delay)
    const delayedTurn = room.game.state.turn - room.spectatorDelay;
    const relayMessages = room.relay.getSpectatorMessages(Math.max(0, delayedTurn));
    const stateWithRelay = { ...state, relayMessages };

    const msg = JSON.stringify({ type: 'state_update', data: stateWithRelay });
    for (const ws of room.spectators) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Create a bot game
  // ---------------------------------------------------------------------------

  /** Count active games + lobbies (anything consuming bot API calls) */

  activeGameCount(): number {
    let count = 0;
    for (const [, room] of this.games) {
      if (!room.finished) count++;
    }
    // Count active lobbies (but not failed/finished ones)
    for (const [, room] of this.lobbies) {
      if (!room.state || room.state.phase === 'failed') continue;
      // If lobby's game is finished, don't count it
      if (room.state.gameId) {
        const gameRoom = this.games.get(room.state.gameId);
        if (gameRoom?.finished) continue;
      }
      count++;
    }
    return count;
  }

  createBotGame(teamSize: number = 4): { gameId: string; game: CtlSession } {
    const gameId = crypto.randomUUID();
    const classes: UnitClass[] = ['rogue', 'knight', 'mage'];

    const players: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[] = [];
    const botHandles: string[] = [];
    const handleMap: Record<string, string> = {};

    for (let i = 0; i < teamSize; i++) {
      const handleA = `bot_${i * 2 + 1}`;
      const handleB = `bot_${i * 2 + 2}`;
      botHandles.push(handleA, handleB);

      handleMap[handleA] = BOT_DISPLAY_NAMES[(i * 2) % BOT_DISPLAY_NAMES.length];
      handleMap[handleB] = BOT_DISPLAY_NAMES[(i * 2 + 1) % BOT_DISPLAY_NAMES.length];

      players.push({
        id: handleA,
        team: 'A',
        unitClass: classes[i % classes.length],
      });
      players.push({
        id: handleB,
        team: 'B',
        unitClass: classes[i % classes.length],
      });
    }

    const radius = getMapRadiusForTeamSize(teamSize);
    const gameMap = generateMap({ radius, teamSize });
    const game = createCtlSession(gameId, gameMap, players, {
      teamSize,
      turnLimit: getTurnLimitForRadius(radius),
    });

    // Take initial snapshot
    const relay = new GameRelay(players.map(p => ({ id: p.id, team: p.team })));
    const initialState = buildSpectatorState(game, handleMap, relay);

    const room: GameRoom = {
      game,
      spectators: new Set(),
      stateHistory: [initialState],
      spectatorDelay: 2,  // 2-turn delay for spectators
      turnTimer: null,
      deadlineTimer: null,
      botHandles,
      botMeta: players,
      botSessions: createBotSessions(
        players.map(p => ({ id: p.id, handle: handleMap[p.id] ?? p.id, team: p.team })),
        this.serverUrl,
        (id, handle) => createBotToken(id, handle),
        [BasicChatPlugin],
      ),
      finished: false,
      turnInProgress: false,
      externalSlots: new Map(),
      turnResolve: null,
      turnTimeoutMs: 30000,
      handleMap,
      lobbyChat: [],
      preGameChatA: [],
      preGameChatB: [],
      relay,
    };

    this.games.set(gameId, room);

    // Start the event-driven turn loop
    this.startNextTurn(gameId);

    return { gameId, game };
  }

  // ---------------------------------------------------------------------------
  // Event-driven turn loop
  // ---------------------------------------------------------------------------

  /**
   * Start a new turn: kick off bots, set deadline timer, wait for all moves
   * or deadline, then resolve and start next turn.
   */
  private startNextTurn(gameId: string): void {
    const room = this.games.get(gameId);
    if (!room || room.finished) return;

    const { game } = room;

    // Check if game is over
    if (isGameOver(game)) {
      this.finishGame(room);
      return;
    }

    room.turnInProgress = true;

    console.log(`[Turn] Starting turn ${game.state.turn} for game ${gameId}`);

    // Create a promise that resolves when all moves are submitted
    const allMovesPromise = new Promise<void>((resolve) => {
      room.turnResolve = resolve;
    });

    // Kick off bots via coga subprocess (async)
    const botPromise = this.runBots(room);

    // Set deadline timer
    const deadlinePromise = new Promise<void>((resolve) => {
      room.deadlineTimer = setTimeout(() => {
        console.log(`[Turn] Deadline hit for turn ${game.state.turn} in game ${gameId}`);
        resolve();
      }, room.turnTimeoutMs);
    });

    // Wait for either: all moves submitted, or deadline
    Promise.race([
      // All moves submitted (bots + external agents)
      botPromise.then(() => {
        // After bots finish, check if all moves are in
        if (allMovesSubmitted(game)) {
          // Clear the resolve so it doesn't fire again
          room.turnResolve = null;
          return;
        }
        // If not all in, wait for external agents or deadline
        return allMovesPromise;
      }),
      deadlinePromise,
    ]).then(() => {
      this.resolveTurnAndContinue(gameId);
    }).catch((err) => {
      console.error(`[Turn] Error in turn loop for ${gameId}:`, err);
      room.turnInProgress = false;
    });
  }

  /**
   * Run bots for the current turn via the MCP HTTP endpoint.
   */
  private async runBots(room: GameRoom): Promise<void> {
    const { game, botHandles } = room;

    // Build set of alive bot IDs
    const aliveBotIds = new Set<string>();
    for (const botId of botHandles) {
      const unit = game.state.units.find((u: { id: string }) => u.id === botId);
      if (unit?.alive) aliveBotIds.add(botId);
    }

    // Claude bots use GameClient + Anthropic API directly
    await Promise.race([
      runAllBotsTurn(room.botSessions, game.state.turn, aliveBotIds),
      new Promise<void>((resolve) => setTimeout(resolve, room.turnTimeoutMs - 2000)),
    ]);

    // Submit empty moves for bots that didn't submit
    for (const botId of botHandles) {
      if (!game.hasSubmitted(botId)) {
        const unit = game.state.units.find((u) => u.id === botId);
        if (unit?.alive) submitCtlMove(game, botId, []);
      }
    }

    // After bot moves, check if all moves are now in
    if (allMovesSubmitted(game) && room.turnResolve) {
      room.turnResolve();
      room.turnResolve = null;
    }
  }

  /**
   * Resolve the current turn and start the next one.
   */
  private resolveTurnAndContinue(gameId: string): void {
    const room = this.games.get(gameId);
    if (!room || room.finished) return;

    const { game } = room;

    // Clear timers
    if (room.deadlineTimer) {
      clearTimeout(room.deadlineTimer);
      room.deadlineTimer = null;
    }
    room.turnResolve = null;

    // Force empty moves for any agent (bot or external) that hasn't submitted
    const allPlayerIds = game.state.units.map((u) => u.id);
    for (const playerId of allPlayerIds) {
      if (!game.hasSubmitted(playerId)) {
        const unit = game.state.units.find((u) => u.id === playerId);
        if (unit?.alive) submitCtlMove(game, playerId, []);
      }
    }

    // Resolve the turn
    resolveCtlTurn(game);

    // Notify any external agents waiting via wait_for_update
    notifyTurnResolved(gameId);

    // Snapshot current state
    const state = buildSpectatorState(game, room.handleMap, room.relay);
    room.stateHistory.push(state);

    // Broadcast to spectators
    this.broadcastState(room);

    room.turnInProgress = false;

    // Check if game is over
    if (isGameOver(game)) {
      this.finishGame(room);
      return;
    }

    // Small delay before starting next turn (gives spectators time to see state)
    const nextTurnDelay = 1000;
    room.turnTimer = setTimeout(() => {
      this.startNextTurn(gameId);
    }, nextTurnDelay);
  }

  /**
   * Handle game over: clean up, broadcast final state.
   */
  private finishGame(room: GameRoom): void {
    if (room.finished) return;
    room.finished = true;

    // Clear timers
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    if (room.deadlineTimer) { clearTimeout(room.deadlineTimer); room.deadlineTimer = null; }
    room.turnResolve = null;
    room.turnInProgress = false;

    // Final broadcast
    const finalState = buildSpectatorState(room.game, room.handleMap, room.relay);
    room.stateHistory.push(finalState);
    const msg = JSON.stringify({ type: 'game_over', data: finalState });
    for (const ws of room.spectators) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }

    // Wake up any external agents waiting on wait_for_update
    notifyTurnResolved(room.game.gameId);

    // Record ELO for all human/bot players
    try {
      const players = room.game.state.units.map((u) => {
        const handle = room.handleMap[u.id] ?? getAgentName(u.id);
        const dbPlayer = this.elo.getOrCreatePlayer(handle);
        return { id: dbPlayer.id, team: u.team as 'A' | 'B', unitClass: u.unitClass };
      });
      this.elo.recordMatch(
        room.game.gameId,
        (room.game.state as any).mapSeed ?? room.game.gameId,
        room.game.state.turn,
        room.game.state.winner as 'A' | 'B' | null,
        players,
      );
    } catch (err) {
      console.error('[ELO] Failed to record match:', err);
    }

    console.log(`[Game] Game ${room.game.gameId} finished. Winner: ${room.game.state.winner ?? 'draw'}`);

    // Build game result with Merkle root for future on-chain anchoring
    try {
      const playerIds = room.game.state.units.map((u) => u.id);
      const result = buildGameResultFromSession(room.game, room.game.state.turn.toString(), playerIds);
      const payouts = computePayoutsFromSession(room.game, playerIds);
      console.log(`[Coordination] Game result built. Merkle root: ${result.movesRoot.slice(0, 16)}... Turns: ${result.turnCount}`);
      const payoutSummary = [...payouts.entries()].map(([id, delta]) => `${id}:${delta > 0 ? '+' : ''}${delta}`).join(', ');
      console.log(`[Coordination] Payouts: ${payoutSummary}`);
    } catch (err) {
      console.error('[Coordination] Failed to build game result:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Broadcast lobby state to spectators
  // ---------------------------------------------------------------------------

  private broadcastLobbyState(lobbyRoom: LobbyRoom): void {
    if (lobbyRoom.spectators.size === 0) return;
    const state = lobbyRoom.runner.getState();
    console.log(`[Lobby] Broadcasting to ${lobbyRoom.spectators.size} spectators, phase=${state.phase}, agents=${state.agents.length}`);
    const msg = JSON.stringify({ type: 'lobby_update', data: state });
    for (const ws of lobbyRoom.spectators) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Create a lobby game with Claude bots (and optional external slots)
  // ---------------------------------------------------------------------------

  createLobbyGame(
    teamSize: number = 2,
    timeoutMs: number = 600000,
  ): { lobbyId: string } {
    // Clean up failed/finished lobbies before creating a new one
    for (const [id, room] of this.lobbies) {
      if (room.state && room.state.phase === 'failed') {
        this.lobbies.delete(id);
      }
    }
    const runner = new LobbyRunner(teamSize, timeoutMs, {
      onStateChange: (state: LobbyRunnerState) => {
        console.log(`[Lobby] onStateChange: lobbyId=${state.lobbyId}, phase=${state.phase}, agents=${state.agents.length}`);
        const lobbyRoom = this.lobbies.get(state.lobbyId);
        if (lobbyRoom) {
          lobbyRoom.state = state;
          console.log(`[Lobby] Found room, spectators=${lobbyRoom.spectators.size}`);
          this.broadcastLobbyState(lobbyRoom);
          // Notify all agents in this lobby about state changes (phase transitions, new agents, etc.)
          if (lobbyRoom.lobbyManager) {
            for (const [id] of lobbyRoom.lobbyManager.agents) {
              notifyAgent(id);
            }
          }
        } else {
          console.log(`[Lobby] WARNING: lobby room not found for ${state.lobbyId}`);
        }
      },
      onGameCreated: (gameId, teamPlayers, handles) => {
        // Grab lobby chat before transitioning to game
        const lobbyRoom = this.lobbies.get(runner.lobby.lobbyId);
        const lobbyChat = lobbyRoom?.state?.chat ?? [];
        const preGameChatA = runner.lobby.preGameChat?.A ?? [];
        const preGameChatB = runner.lobby.preGameChat?.B ?? [];
        this.createGameFromLobby(gameId, teamPlayers, handles, lobbyChat, preGameChatA, preGameChatB);
      },
    }, this.serverUrl);

    const lobbyId = runner.lobby.lobbyId;
    const lobbyRoom: LobbyRoom = {
      runner,
      spectators: new Set(),
      state: null,
      externalSlots: new Map(),
      lobbyManager: runner.lobby,
    };
    this.lobbies.set(lobbyId, lobbyRoom);

    // Start the lobby runner (async, runs in background)
    runner.run().catch((err) => {
      console.error(`Lobby ${lobbyId} runner error:`, err);
    });

    return { lobbyId };
  }

  // ---------------------------------------------------------------------------
  // Create a game room from a completed lobby
  // ---------------------------------------------------------------------------

  private createGameFromLobby(
    gameId: string,
    teamPlayers: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[],
    handles: Record<string, string> = {},
    lobbyChat: { from: string; message: string; timestamp: number }[] = [],
    preGameChatA: { from: string; message: string; timestamp: number }[] = [],
    preGameChatB: { from: string; message: string; timestamp: number }[] = [],
  ): void {
    const players = teamPlayers;
    const botHandles: string[] = [];
    const externalSlots = new Map<string, ExternalSlot>();
    const handleMap: Record<string, string> = { ...handles };

    // Separate bot handles from external agent handles
    for (const p of players) {
      if (p.id.startsWith('ext_')) {
        // External agent — track their game
        this.agentToGame.set(p.id, gameId);
        externalSlots.set(p.id, {
          token: '',
          agentId: p.id,
          connected: true,
        });
      } else {
        botHandles.push(p.id);
      }
    }

    const teamSize = Math.max(
      players.filter(p => p.team === 'A').length,
      players.filter(p => p.team === 'B').length,
    );
    const radius = getMapRadiusForTeamSize(teamSize);
    const gameMap = generateMap({ radius, teamSize });
    const game = createCtlSession(gameId, gameMap, players, {
      teamSize,
      turnLimit: getTurnLimitForRadius(radius),
    });

    const relay = new GameRelay(players.map(p => ({ id: p.id, team: p.team })));
    const initialState = buildSpectatorState(game, handleMap, relay);

    const room: GameRoom = {
      game,
      spectators: new Set(),
      stateHistory: [initialState],
      spectatorDelay: 2,  // 2-turn delay for spectators
      turnTimer: null,
      deadlineTimer: null,
      botHandles,
      botMeta: players,
      botSessions: createBotSessions(
        players.filter((p) => !p.id.startsWith('ext_')).map(p => ({
          id: p.id, handle: handleMap[p.id] ?? p.id, team: p.team,
        })),
        this.serverUrl,
        (id, handle) => createBotToken(id, handle),
        [BasicChatPlugin],
      ),
      finished: false,
      turnInProgress: false,
      externalSlots,
      turnResolve: null,
      turnTimeoutMs: 30000,
      handleMap,
      lobbyChat,
      preGameChatA,
      preGameChatB,
      relay,
    };

    this.games.set(gameId, room);

    // Notify external agents that the game has started (wakes wait_for_update)
    for (const p of players) {
      if (p.id.startsWith('ext_')) {
        notifyAgent(p.id);
      }
    }

    // Start the event-driven turn loop
    this.startNextTurn(gameId);

    console.log(`Game ${gameId} created from lobby with ${players.length} players (${externalSlots.size} external)`);
  }

  // ---------------------------------------------------------------------------
  // Listen
  // ---------------------------------------------------------------------------

  listen(port: number = 3000): void {
    this.server.listen(port, () => {
      console.log(`Capture the Lobster server listening on port ${port}`);
    });
  }

  // Expose the http server for testing
  getHttpServer(): http.Server {
    return this.server;
  }

  // Graceful shutdown
  close(): void {
    for (const [, room] of this.games) {
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.deadlineTimer) clearTimeout(room.deadlineTimer);
      for (const ws of room.spectators) ws.close();
    }
    for (const [, lobbyRoom] of this.lobbies) {
      lobbyRoom.runner.abort();
      for (const ws of lobbyRoom.spectators) ws.close();
    }
    // MCP sessions removed — auth is via REST now
    this.wss.close();
    this.server.close();
    this.elo.close();
  }
}
