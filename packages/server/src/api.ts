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
import { runAllBotsTurn, createBotSessions, BotSession } from './claude-bot.js';
import { LobbyRunner, LobbyRunnerState } from './lobby-runner.js';
import {
  mountMcpEndpoint,
  closeAllMcpSessions,
  notifyTurnResolved,
  notifyAgent,
  getAgentName,
} from './mcp-http.js';
import { createRelayRouter } from './relay.js';
import { GameRelay, type RelayMessage } from './typed-relay.js';
import { buildGameMerkleTree, type MerkleLeafData } from '@coordination-games/platform';

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
  };
  units?: {
    id: string;
    team: 'A' | 'B';
    unitClass: UnitClass;
    carryingFlag?: boolean;
    alive: boolean;
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
    if (u.alive) {
      const key = `${u.position.q},${u.position.r}`;
      const list = unitsByHex.get(key) ?? [];
      list.push(u);
      unitsByHex.set(key, list);
    }
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
      };
      // Additional units on same hex
      if (unitsHere.length > 1) {
        tile.units = unitsHere.map((u) => ({
          id: u.id,
          team: u.team,
          unitClass: u.unitClass,
          carryingFlag: u.carryingFlag || undefined,
          alive: u.alive,
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

  constructor(port?: number) {
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

    // Mount the MCP Streamable HTTP endpoint
    mountMcpEndpoint(
      this.app,
      // Game resolver: find the GameSession for an agentId
      (agentId: string) => {
        const gameId = this.agentToGame.get(agentId);
        if (!gameId) return null;
        const room = this.games.get(gameId);
        return room?.game ?? null;
      },
      // Lobby resolver: find the LobbyManager for an agentId
      (agentId: string) => {
        const lobbyId = this.agentToLobby.get(agentId);
        if (!lobbyId) return null;
        const lobbyRoom = this.lobbies.get(lobbyId);
        return lobbyRoom?.lobbyManager ?? null;
      },
      // Move callback: check if all moves submitted for early turn resolution
      (gameId: string, agentId: string) => {
        this.onMoveSubmitted(gameId, agentId);
      },
      // Chat callback: push through relay + broadcast state + notify teammates
      (gameId: string, agentId?: string, message?: string) => {
        const room = this.games.get(gameId);
        if (room) {
          // Push chat through the typed relay
          if (agentId && message) {
            const phase = room.game.state.phase;
            const scope = (phase === 'in_progress' || phase === 'pre_game') ? 'team' : 'all';
            room.relay.send(agentId, room.game.state.turn, {
              type: 'messaging',
              data: { body: message },
              scope,
              pluginId: 'basic-chat',
            });
          }
          this.broadcastState(room);
          // Notify all agents in this game so wait_for_update wakes up
          for (const unit of room.game.state.units) {
            notifyAgent(unit.id);
          }
        }
      },
      // Register callback: log when an agent registers
      (agentId: string, name: string) => {
        console.log(`[MCP] Agent ${agentId} registered as "${name}"`);
      },
      // Join lobby callback: wire the agent into the lobby system
      (agentId: string, name: string, lobbyId: string) => {
        const lobbyRoom = this.lobbies.get(lobbyId);
        if (!lobbyRoom) return { success: false, error: 'Lobby not found' };

        // Track the slot
        lobbyRoom.externalSlots.set(agentId, {
          token: '',
          agentId,
          connected: true,
        });

        // Map agent -> lobby for MCP resolver
        this.agentToLobby.set(agentId, lobbyId);

        // Add agent to the lobby manager
        if (lobbyRoom.lobbyManager) {
          lobbyRoom.lobbyManager.addAgent({
            id: agentId,
            handle: name,
            elo: 1000,
          });
        }

        console.log(`[MCP] Agent ${agentId} (${name}) joined lobby ${lobbyId}, spectators: ${lobbyRoom.spectators.size}`);
        lobbyRoom.runner.emitState();
        // Notify other agents already in this lobby
        if (lobbyRoom.lobbyManager) {
          for (const [id] of lobbyRoom.lobbyManager.agents) {
            if (id !== agentId) notifyAgent(id);
          }
        }
        return { success: true };
      },
      // Create lobby callback: create a new lobby and auto-join the agent
      (agentId: string, name: string, teamSize: number) => {
        if (this.activeGameCount() >= this.maxConcurrentGames) {
          return { success: false, error: 'Server busy — a lobby or game is already running.' };
        }
        const size = Math.min(6, Math.max(2, Math.floor(teamSize)));
        const { lobbyId } = this.createLobbyGame(size, 600000);
        const lobbyRoom = this.lobbies.get(lobbyId)!;
        // Auto-join the creator
        lobbyRoom.externalSlots.set(agentId, { token: '', agentId, connected: true });
        this.agentToLobby.set(agentId, lobbyId);
        if (lobbyRoom.lobbyManager) {
          lobbyRoom.lobbyManager.addAgent({ id: agentId, handle: name, elo: 1000 });
        }
        lobbyRoom.runner.emitState();
        console.log(`[MCP] Agent ${agentId} (${name}) created and joined lobby ${lobbyId} (${size}v${size})`);
        return { success: true, lobbyId };
      },
      // Leaderboard resolver
      (limit: number, offset: number) => {
        const players = this.elo.getLeaderboard(limit, offset);
        return players.map((p, i) => ({
          rank: offset + i + 1,
          handle: p.handle,
          elo: p.elo,
          gamesPlayed: p.gamesPlayed,
          wins: p.wins,
        }));
      },
      // Player stats resolver
      (handle: string) => {
        const player = this.elo.getPlayerByHandle(handle);
        if (!player) return null;
        // Get rank by counting players with higher ELO
        const leaderboard = this.elo.getLeaderboard(1000, 0);
        const rank = leaderboard.findIndex(p => p.handle === handle) + 1;
        return {
          handle: player.handle,
          elo: player.elo,
          rank: rank || 0,
          gamesPlayed: player.gamesPlayed,
          wins: player.wins,
        };
      },
      // Lobby chat callback: broadcast state to spectators + notify other agents
      (agentId: string) => {
        const lobbyId = this.agentToLobby.get(agentId);
        if (!lobbyId) return;
        const lobbyRoom = this.lobbies.get(lobbyId);
        if (lobbyRoom) {
          lobbyRoom.runner.emitState();
          // Notify all other agents in this lobby so wait_for_update wakes up
          if (lobbyRoom.lobbyManager) {
            for (const [id] of lobbyRoom.lobbyManager.agents) {
              if (id !== agentId) notifyAgent(id);
            }
          }
        }
      },
      // Relay resolver: find the GameRelay for an agentId
      (agentId: string) => {
        const gameId = this.agentToGame.get(agentId);
        if (!gameId) return null;
        const room = this.games.get(gameId);
        return room?.relay ?? null;
      },
    );
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
      spectatorDelay: 0,  // No delay for beta testing
      turnTimer: null,
      deadlineTimer: null,
      botHandles,
      botMeta: players,
      botSessions: createBotSessions(players),
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

    // Kick off in-process bots (async)
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
   * Run in-process bots for the current turn.
   */
  private async runBots(room: GameRoom): Promise<void> {
    const { game, botHandles } = room;

    // Claude bots with their own timeout
    await Promise.race([
      runAllBotsTurn(game, room.botSessions, game.state.turn, room.relay),
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
      onStateChange: (state) => {
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
    });

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
      spectatorDelay: 0,
      turnTimer: null,
      deadlineTimer: null,
      botHandles,
      botMeta: players,
      botSessions: createBotSessions(players.filter((p) => !p.id.startsWith('ext_'))),
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
    closeAllMcpSessions().catch(() => {});
    this.wss.close();
    this.server.close();
    this.elo.close();
  }
}
