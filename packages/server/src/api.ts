import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';

import {
  Hex,
  TileType,
  getUnitVision,
  hexToString,
  CLASS_VISION,
  LobbyManager as EngineLobbyManager,
} from '@coordination-games/game-ctl';
import {
  type CtlGameRoom,
  type GameUnit,
  type FlagState,
  type GamePhase,
  type TurnRecord,
  type UnitClass,
  type Direction,
  type GameConfig,
  type CtlAction,
  createCtlGameRoom,
  getMapRadiusForTeamSize,
  getTurnLimitForRadius,
  CaptureTheLobsterPlugin,
} from './game-session.js';
import type { CtlConfig } from '@coordination-games/game-ctl';
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
  OATHBREAKER_RULES,
  type GameResolver,
  type LobbyResolver,
  type RelayResolver,
} from './mcp-http.js';
import { createRelayRouter } from './relay.js';
import { GameRelay, type RelayMessage } from './typed-relay.js';
import { GameRoom, buildActionMerkleTree, type MerkleLeafData } from '@coordination-games/engine';
import {
  OathbreakerPlugin,
  type OathConfig,
  type OathState,
  type OathAction,
  type OathOutcome,
  DEFAULT_OATH_CONFIG,
} from '@coordination-games/game-oathbreaker';

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

export interface GameRoomData {
  gameType: string;                              // 'capture-the-lobster' | 'oathbreaker' | ...
  plugin: any;                                   // The CoordinationGame plugin (for getVisibleState etc.)
  game: GameRoom<any, any, any, any>;            // Engine game room
  spectators: Set<WebSocket>;
  finished: boolean;
  externalSlots: Map<string, ExternalSlot>;
  handleMap: Record<string, string>;
  relay: GameRelay;
  botSessions: BotSession[];
  /** Chat from the lobby phase (preserved for spectators) */
  lobbyChat: { from: string; message: string; timestamp: number }[];
  /** Pre-game team chat (preserved for spectators) */
  preGameChatA: { from: string; message: string; timestamp: number }[];
  preGameChatB: { from: string; message: string; timestamp: number }[];
  // Legacy CtL fields (will be removed when bot scheduling is genericized)
  stateHistory?: SpectatorState[];               // indexed by turn (CtL only)
  spectatorDelay?: number;                       // turns of delay (CtL only)
  botHandles?: string[];                         // handles of bot players in this room
  botMeta?: { id: string; unitClass: UnitClass; team: 'A' | 'B' }[];
  turnTimeoutMs?: number;
}

// Type alias for OATHBREAKER GameRoom (convenience, used in casts)
export type OathGameRoom = GameRoom<OathConfig, OathState, OathAction, OathOutcome>;

// ---------------------------------------------------------------------------
// Game result helpers
// ---------------------------------------------------------------------------

function buildGameResultFromRoom(
  room: CtlGameRoom,
  gameId: string,
  playerIds: string[],
) {
  const leaves: MerkleLeafData[] = room.actionLog.map((entry, index) => ({
    actionIndex: index,
    playerId: entry.playerId,
    actionData: JSON.stringify(entry.action),
  }));
  const tree = buildActionMerkleTree(leaves);

  return {
    gameId,
    gameType: 'capture-the-lobster',
    players: playerIds,
    outcome: {
      winner: room.state.winner,
      score: { ...room.state.score },
      turnCount: room.state.turn,
    },
    actionsRoot: tree.root,
    configHash: '',
    actionCount: room.actionLog.length,
    timestamp: Date.now(),
  };
}

/** Check if a player has submitted a move for the current turn (reads from game state). */
function hasSubmitted(game: CtlGameRoom, agentId: string): boolean {
  const submissions = new Map(game.state.moveSubmissions);
  return submissions.has(agentId);
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

function buildSpectatorState(
  state: any,
  prevState: any | null,
  handles: Record<string, string> = {},
  relay?: GameRelay,
): SpectatorState {
  const map = { tiles: new Map<string, string>(state.mapTiles), radius: state.mapRadius, bases: state.mapBases };
  const { units, flags, turn, phase, config, score } = state;

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

  // Kills — inferred by comparing alive status with previous state
  const kills: { killerId: string; victimId: string; reason: string }[] = [];
  if (prevState) {
    for (const unit of units) {
      const prevUnit = prevState.units.find((u: any) => u.id === unit.id);
      if (prevUnit && prevUnit.alive && !unit.alive) {
        kills.push({ killerId: 'unknown', victimId: unit.id, reason: 'combat' });
      }
    }
  }

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
    winner: state.winner ?? null,
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
// Helper: build spectator view for any game type (with delay)
// ---------------------------------------------------------------------------

/**
 * Get the spectator view for a game room, using the plugin's spectator delay.
 * For CtL: builds the SpectatorState format from the delayed raw state (via stateHistory cache).
 * For OATHBREAKER (and other games): uses engine's getSpectatorView directly.
 */
function getSpectatorViewForRoom(room: GameRoomData): any {
  if (room.gameType === 'capture-the-lobster') {
    // CtL uses pre-built SpectatorState cache (indexed by progress)
    if (!room.stateHistory || room.stateHistory.length === 0) return null;
    const delay = room.plugin.spectatorDelay ?? 0;
    const idx = Math.max(0, room.stateHistory.length - 1 - delay);
    return room.stateHistory[idx];
  }
  // Generic path: use engine's built-in delayed spectator view
  const delay = room.plugin.spectatorDelay ?? 0;
  return room.game.getSpectatorView(delay);
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
// OATHBREAKER waiting room (pre-game player collection)
// ---------------------------------------------------------------------------

export interface OathWaitingRoom {
  id: string;
  gameType: 'oathbreaker';
  targetPlayers: number;
  players: { id: string; handle: string }[];
  spectators: Set<WebSocket>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// GameServer
// ---------------------------------------------------------------------------

export class GameServer {
  private app: any;
  private server: http.Server;
  private wss: WebSocketServer;
  readonly elo: EloTracker;

  readonly games: Map<string, GameRoomData> = new Map();
  readonly lobbies: Map<string, LobbyRoom> = new Map();
  readonly waitingRooms: Map<string, OathWaitingRoom> = new Map();
  private maxConcurrentGames: number = 1; // Beta limit — prevents credit drain

  /** Maps external agentId -> gameId for game resolution */
  private agentToGame: Map<string, string> = new Map();
  /** Maps external agentId -> lobbyId for lobby resolution */
  private agentToLobby: Map<string, string> = new Map();
  /** Maps external agentId -> waiting room ID */
  private agentToWaitingRoom: Map<string, string> = new Map();

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
  // Event-driven turn: no longer needed — GameRoom handles it via handleAction
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // REST routes
  // ---------------------------------------------------------------------------

  private setupRoutes(): void {
    const router = express.Router();

    // GET /framework — coordination framework info (available games, version)
    router.get('/framework', (_req, res) => {
      res.json({
        version: '0.1.0',
        games: ['capture-the-lobster', 'oathbreaker'],
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
      const gameType = req.body?.gameType ?? 'capture-the-lobster';
      if (gameType === 'oathbreaker') {
        const playerCount = Math.min(20, Math.max(4, Math.floor((req.body?.playerCount as number) || 4)));
        const roomId = this.createOathbreakerWaitingRoom(playerCount, []);
        console.log(`[REST] Created OATHBREAKER waiting room ${roomId} (${playerCount} players) via /lobbies/create`);
        return res.status(201).json({ gameId: roomId, gameType: 'oathbreaker', playerCount, phase: 'waiting' });
      }
      const teamSize = Math.min(6, Math.max(2, Math.floor((req.body?.teamSize as number) || 2)));
      const timeoutMs = (req.body?.timeoutMs as number) || 600000;
      const { lobbyId } = this.createLobbyGame(teamSize, timeoutMs);
      res.status(201).json({ lobbyId, teamSize });
    });

    // Fill remaining lobby/waiting-room slots with bots (requires admin password since bots use API credits)
    router.post('/lobbies/:id/fill-bots', (req, res) => {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (adminPassword && req.body?.password !== adminPassword) {
        return res.status(401).json({ error: 'Admin password required to add bots (they use API credits).' });
      }

      // Try CtL lobby first
      const lobbyRoom = this.lobbies.get(req.params.id);
      if (lobbyRoom) {
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
        return res.status(201).json({ added, filledSlots: added.length });
      }

      // Try OATHBREAKER waiting room
      const waitingRoom = this.waitingRooms.get(req.params.id);
      if (waitingRoom) {
        const currentCount = waitingRoom.players.length;
        const slotsToFill = waitingRoom.targetPlayers - currentCount;
        if (slotsToFill <= 0) {
          return res.status(400).json({ error: 'Waiting room is already full' });
        }
        const botNames = ['Pinchy', 'Clawdia', 'Sheldon', 'Snappy', 'Bubbles', 'Coral', 'Neptune', 'Triton', 'Marina', 'Squidward', 'Barnacle', 'Anchovy'];
        const added: { agentId: string; handle: string }[] = [];
        for (let i = 0; i < slotsToFill; i++) {
          const handle = botNames[(currentCount + i) % botNames.length];
          const agentId = `bot_oath_${currentCount + i}`;
          this.joinOathbreakerWaitingRoom(req.params.id, agentId, handle);
          added.push({ agentId, handle });
        }
        return res.status(201).json({ added, filledSlots: added.length });
      }

      return res.status(404).json({ error: 'Lobby not found' });
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
      const list = Array.from(this.games.entries()).map(([id, room]) => {
        if (room.gameType === 'oathbreaker') {
          const oathState = room.game.state as OathState;
          return {
            id,
            gameType: 'oathbreaker',
            round: oathState.round,
            maxRounds: oathState.config.maxRounds,
            phase: oathState.phase,
            players: oathState.players.map(p => p.id),
            spectators: room.spectators.size,
            externalAgents: room.externalSlots.size,
          };
        }
        return {
          id,
          gameType: 'capture-the-lobster',
          turn: room.game.state.turn,
          maxTurns: room.game.state.config.turnLimit,
          phase: room.game.state.phase,
          winner: room.game.state.winner,
          teams: {
            A: room.game.state.units.filter((u: any) => u.team === 'A').map((u: any) => u.id),
            B: room.game.state.units.filter((u: any) => u.team === 'B').map((u: any) => u.id),
          },
          spectators: room.spectators.size,
          externalAgents: room.externalSlots.size,
        };
      });

      // Include waiting rooms as games with phase 'waiting'
      for (const [id, wr] of this.waitingRooms) {
        list.push({
          id,
          gameType: 'oathbreaker',
          round: 0,
          maxRounds: DEFAULT_OATH_CONFIG.maxRounds,
          phase: 'waiting',
          players: wr.players.map(p => p.id),
          spectators: wr.spectators.size,
          externalAgents: wr.players.length,
        });
      }

      res.json(list);
    });

    // Game details (also checks waiting rooms)
    router.get('/games/:id', (req, res) => {
      // Check waiting rooms first
      const waitingRoom = this.waitingRooms.get(req.params.id);
      if (waitingRoom) {
        return res.json({
          gameType: 'oathbreaker',
          targetPlayers: waitingRoom.targetPlayers,
          phase: 'waiting',
          round: 0,
          maxRounds: DEFAULT_OATH_CONFIG.maxRounds,
          players: waitingRoom.players.map(p => ({ id: p.id, handle: p.handle })),
        });
      }

      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const state = getSpectatorViewForRoom(room);
      if (!state) return res.status(200).json({ phase: 'pre_game' });
      const extra = room.gameType === 'oathbreaker'
        ? { gameType: 'oathbreaker' }
        : { lobbyChat: room.lobbyChat, preGameChatA: room.preGameChatA, preGameChatB: room.preGameChatB };
      res.json({ ...extra, ...state as any });
    });

    // Current spectator state (delayed)
    router.get('/games/:id/state', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const state = getSpectatorViewForRoom(room);
      if (!state) return res.status(200).json({ phase: 'pre_game' });
      const extra = room.gameType === 'oathbreaker' ? { gameType: 'oathbreaker' } : {};
      res.json({ ...extra, ...state as any });
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
      this.broadcastSpectatorState(room);

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
      const actionLog = game.actionLog;

      // Serialize action log for Merkle tree construction
      const actions = actionLog.map((entry, idx) => ({
        actionIndex: idx,
        playerId: entry.playerId,
        action: entry.action,
      }));

      res.json({
        gameId: game.gameId,
        config: {
          mapRadius: game.state.mapRadius,
          teamSize: game.state.config.teamSize,
          turnLimit: game.state.config.turnLimit,
        },
        actions,
        stateHistory: room.stateHistory,
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
        const result = buildGameResultFromRoom(room.game, req.params.id, playerIds);
        const payouts = room.game.computePayouts(playerIds);
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
    const resolveGame = (agentId: string): CtlGameRoom | null => {
      const gameId = this.agentToGame.get(agentId);
      if (!gameId) return null;
      const room = this.games.get(gameId);
      if (!room || room.gameType !== 'capture-the-lobster') return null;
      return room.game as CtlGameRoom;
    };

    const resolveOathGame = (agentId: string): OathGameRoom | null => {
      const gameId = this.agentToGame.get(agentId);
      if (!gameId) return null;
      const room = this.games.get(gameId);
      if (!room || room.gameType !== 'oathbreaker') return null;
      return room.game as OathGameRoom;
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

    const resolveWaitingRoom = (agentId: string): OathWaitingRoom | null => {
      const roomId = this.agentToWaitingRoom.get(agentId);
      if (!roomId) return null;
      return this.waitingRooms.get(roomId) ?? null;
    };

    /** Get the handle map for an agent (from their game room, or from global registry as fallback) */
    const getHandlesForAgent = (agentId: string): Record<string, string> => {
      const gameId = this.agentToGame.get(agentId);
      if (gameId) {
        const room = this.games.get(gameId);
        if (room) return room.handleMap;
      }
      // In lobby phase, build handles from lobby agents + global registry
      const lobbyId = this.agentToLobby.get(agentId);
      if (lobbyId) {
        const lobbyRoom = this.lobbies.get(lobbyId);
        if (lobbyRoom?.lobbyManager) {
          const handles: Record<string, string> = {};
          for (const [id, agent] of lobbyRoom.lobbyManager.agents) {
            handles[id] = agent.handle;
          }
          return handles;
        }
      }
      return {};
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

      const game = resolveGame(agentId);
      const oathGame = resolveOathGame(agentId);
      const lobby = resolveLobby(agentId);
      const phase = game?.state.phase ?? oathGame?.state.phase ?? lobby?.phase ?? 'none';

      // Determine which game's guide to show:
      // 1. Explicit ?game= query param takes priority
      // 2. Auto-detect from player's current game
      // 3. Default to capture-the-lobster
      const requestedGame = (req.query.game as string)?.toLowerCase();
      const detectedGame = oathGame ? 'oathbreaker' : 'capture-the-lobster';
      const gameType = requestedGame || detectedGame;

      // --- OATHBREAKER guide ---
      if (gameType === 'oathbreaker') {
        let playerState = '\n## Your Status\n';
        if (oathGame) {
          const oathState = oathGame.state as any;
          const player = oathState.players?.find((p: any) => p.id === agentId);
          playerState += `- **Phase:** ${oathState.phase}\n- **Round:** ${oathState.round}/${oathState.config?.maxRounds ?? '?'}\n`;
          if (player) {
            playerState += `- **Balance:** ${player.balance}\n- **Oaths Kept:** ${player.oathsKept}\n- **Oaths Broken:** ${player.oathsBroken}\n`;
          }
        } else {
          playerState += `- Not in an OATHBREAKER game.\n`;
        }

        let cliRef = '\n## CLI Reference\n';
        cliRef += '| Command | Description |\n';
        cliRef += '|---------|-------------|\n';
        cliRef += '| `coga status` | Your address, name, credits |\n';
        cliRef += '| `coga guide` | This guide |\n';
        cliRef += '| `coga guide oathbreaker` | OATHBREAKER rules |\n';
        cliRef += '| `coga guide capture-the-lobster` | CtL rules |\n';
        cliRef += '| `coga state` | Get current game state |\n';
        cliRef += '| `coga move \'{"amount": 20}\'` | Propose a pledge |\n';
        cliRef += '| `coga move \'{"decision": "C"}\'` | Submit C/D decision |\n';
        cliRef += '| `coga wait` | Wait for the next update |\n';
        cliRef += '| `coga tool basic-chat chat message="..." scope="all"` | Chat |\n';

        return res.json({ guide: OATHBREAKER_RULES + playerState + cliRef });
      }

      // --- Capture the Lobster guide (default) ---

      // --- Player Status ---
      let playerState = '\n## Your Status\n';
      if (game) {
        playerState += `- **Phase:** ${game.state.phase}\n- **Turn:** ${game.state.turn}\n`;
        const unit = game.state.units.find((u: any) => u.id === agentId);
        if (unit) {
          playerState += `- **Team:** ${unit.team}\n- **Class:** ${unit.unitClass}\n- **Alive:** ${unit.alive}\n`;
        }
      } else if (lobby) {
        playerState += `- **Phase:** ${lobby.phase}\n- **Lobby:** active\n`;
      } else {
        playerState += `- Not in a game or lobby.\n`;
      }

      // --- Actions vs Moves ---
      let actions = '\n## How coga move Works\n\n';
      actions += 'The `coga move` command sends two different types of data depending on context:\n\n';
      actions += '- **Lobby actions** (universal, same for all games): `{"action":"propose-team","target":"..."}` — structured objects that operate on the lobby (form teams, pick classes)\n';
      actions += '- **Game moves** (game-specific): the raw move data for whatever game you\'re playing. Each game defines its own move format.\n\n';
      actions += 'For **Capture the Lobster**, game moves are a plain JSON array of directions: `["N","NE"]`\n\n';

      actions += '## Actions Available Now\n';

      if (!game && !lobby) {
        actions += 'You are not in a game or lobby.\n\n';
        actions += '```\n';
        actions += 'coga lobbies                   # list open lobbies\n';
        actions += 'coga create-lobby -s 2         # create a 2v2 lobby\n';
        actions += 'coga join <lobbyId>            # join a lobby\n';
        actions += '```\n';
        actions += '\nMCP equivalents: `list_lobbies()`, `create_lobby(teamSize)`, `join_lobby(lobbyId)`\n';
      } else if (lobby && lobby.phase === 'forming') {
        actions += '### Lobby — Team Formation\n\n';
        actions += 'The `target` field is always a **display name** (handle) for propose-team, or a **teamId** for accept-team.\n\n';
        actions += '```\n';
        actions += '# Invite someone to your team (use their display name)\n';
        actions += 'coga move \'{"action":"propose-team","target":"Sheldon"}\'\n\n';
        actions += '# Accept a team invite (use the teamId from your pendingInvites)\n';
        actions += 'coga move \'{"action":"accept-team","target":"team_1"}\'\n\n';
        actions += '# Leave your current team\n';
        actions += 'coga move \'{"action":"leave-team"}\'\n\n';
        actions += '# Chat (visible to everyone in lobby)\n';
        actions += 'coga tool basic-chat chat message="hello everyone" scope="all"\n\n';
        actions += '# Chat (team only)\n';
        actions += 'coga tool basic-chat chat message="strategy talk" scope="team"\n\n';
        actions += '# Wait for the next update (blocks until something happens)\n';
        actions += 'coga wait\n';
        actions += '```\n';
        actions += '\nMCP equivalents: `propose_team(name)`, `accept_team(teamId)`, `leave_team()`, `chat(message, scope)`, `wait_for_update()`\n';
        actions += '\n**IMPORTANT:** After each action, call `coga wait` to see what changed. Check `pendingInvites` in the response for team invitations you can accept.\n';
      } else if (lobby && lobby.phase === 'pre_game') {
        actions += '### Pre-Game — Class Selection\n\n';
        actions += '```\n';
        actions += '# Pick your class\n';
        actions += 'coga move \'{"action":"choose-class","class":"rogue"}\'\n';
        actions += 'coga move \'{"action":"choose-class","class":"knight"}\'\n';
        actions += 'coga move \'{"action":"choose-class","class":"mage"}\'\n\n';
        actions += '# Team chat (discuss strategy before picking)\n';
        actions += 'coga tool basic-chat chat message="I will go rogue" scope="team"\n\n';
        actions += '# Wait for updates\n';
        actions += 'coga wait\n';
        actions += '```\n';
        actions += '\nMCP equivalents: `choose_class(unitClass)`, `chat(message, "team")`, `wait_for_update()`\n';
      } else if (game && game.state.phase === 'in_progress') {
        actions += '### Gameplay\n\n';
        actions += 'Your main loop: `wait` → read state → `move` → repeat.\n\n';
        actions += '```\n';
        actions += '# Wait for the next turn (returns full board state)\n';
        actions += 'coga wait\n\n';
        actions += '# Submit your move (direction array, up to your speed)\n';
        actions += 'coga move \'["N","NE"]\'\n';
        actions += 'coga move \'["S"]\'\n';
        actions += 'coga move \'[]\'\t\t\t# stay put\n\n';
        actions += '# Team chat (share enemy positions, coordinate)\n';
        actions += 'coga tool basic-chat chat message="enemy rogue at 2,3" scope="team"\n\n';
        actions += '# Get state (use only for recovery/bootstrap, wait gives you state every turn)\n';
        actions += 'coga state\n';
        actions += '```\n';
        actions += '\nMCP equivalents: `wait_for_update()`, `submit_move(path)`, `chat(message, "team")`, `get_state()`\n';
        actions += '\nDirections: **N, NE, SE, S, SW, NW** (flat-top hex grid, no E/W)\n';
      }

      // --- Plugins ---
      let plugins = '\n## Plugins\n';
      plugins += `Required: **${(CaptureTheLobsterPlugin.requiredPlugins ?? []).join(', ') || 'none'}**\n`;
      plugins += `Recommended: **${(CaptureTheLobsterPlugin.recommendedPlugins ?? []).join(', ') || 'none'}**\n`;

      plugins += '\n### basic-chat\n';
      plugins += 'Team and lobby communication. Messages are routed through the typed relay.\n';
      plugins += '| Tool | MCP | Description |\n';
      plugins += '|------|-----|-------------|\n';
      plugins += '| `chat` | Yes | Send a message. Scope: "team", "all", or an agentId for DM |\n';
      plugins += '\nCLI: `coga tool basic-chat chat message="your message" scope="team"`\n';

      plugins += '\n### elo\n';
      plugins += 'ELO ratings and match history. Updated automatically after games.\n';
      plugins += '| Tool | MCP | Description |\n';
      plugins += '|------|-----|-------------|\n';
      plugins += '| `get_leaderboard` | No | Top players by ELO rating |\n';
      plugins += '| `get_my_stats` | No | Your ELO rating and recent matches |\n';
      plugins += '\nCLI: `coga tool elo get_leaderboard` / `coga tool elo get_my_stats`\n';

      // --- General CLI Reference ---
      let cliRef = '\n## CLI Reference\n';
      cliRef += 'The `coga` CLI is how you interact with the game from the command line.\n\n';
      cliRef += '| Command | Description |\n';
      cliRef += '|---------|-------------|\n';
      cliRef += '| `coga status` | Your address, name, credits, registration status |\n';
      cliRef += '| `coga guide` | This guide (auto-detects your game) |\n';
      cliRef += '| `coga guide oathbreaker` | OATHBREAKER rules |\n';
      cliRef += '| `coga guide capture-the-lobster` | CtL rules |\n';
      cliRef += '| `coga lobbies` | List active lobbies |\n';
      cliRef += '| `coga create-lobby -s <n>` | Create a lobby (team size 2-6) |\n';
      cliRef += '| `coga join <lobbyId>` | Join a lobby |\n';
      cliRef += '| `coga state` | Get current game/lobby state |\n';
      cliRef += '| `coga move <json>` | Submit an action (move or lobby action) |\n';
      cliRef += '| `coga wait` | Wait for the next update |\n';
      cliRef += '| `coga tool <plugin> <tool> [args]` | Call any plugin tool |\n';
      cliRef += '| `coga verify <gameId>` | Verify game integrity on-chain |\n';
      cliRef += '| `coga serve --stdio` | Start MCP server (for AI agents) |\n';

      res.json({ guide: GAME_RULES + plugins + playerState + actions + cliRef });
    });

    // ------------------------------------------------------------------
    // 5. GET /state — Get current state (fog-filtered)
    // ------------------------------------------------------------------
    router.get('/state', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;

      // OATHBREAKER game
      const oathGame = resolveOathGame(agentId);
      if (oathGame) {
        const state = oathGame.getVisibleState(agentId);
        const relay = resolveRelay(agentId);
        const relayMessages = relay?.receive(agentId) ?? [];
        const gameId = this.agentToGame.get(agentId);
        const room = gameId ? this.games.get(gameId) : undefined;
        const handles = room?.handleMap ?? {};
        if ((oathGame.state as OathState).phase === 'finished') {
          return res.json({ phase: 'finished', gameType: 'oathbreaker', gameOver: true, ...(state as any), relayMessages, handles });
        }
        return res.json({ phase: 'game', gameType: 'oathbreaker', ...(state as any), relayMessages, handles });
      }

      // CtL game
      const game = resolveGame(agentId);
      if (game) {
        const state = game.getVisibleState(agentId);
        const relay = resolveRelay(agentId);
        const relayMessages = relay?.receive(agentId) ?? [];
        const gameId = this.agentToGame.get(agentId);
        const room = gameId ? this.games.get(gameId) : undefined;
        const handles = room?.handleMap ?? {};
        if (game.state.phase === 'finished') {
          return res.json({ phase: 'finished', gameOver: true, winner: game.state.winner, ...(state as any), relayMessages, handles });
        }
        return res.json({ phase: 'game', ...(state as any), relayMessages, handles });
      }

      // OATHBREAKER waiting room
      const waitingRoom = resolveWaitingRoom(agentId);
      if (waitingRoom) {
        return res.json({
          phase: 'waiting',
          gameType: 'oathbreaker',
          gameId: waitingRoom.id,
          targetPlayers: waitingRoom.targetPlayers,
          currentPlayers: waitingRoom.players.length,
          players: waitingRoom.players.map(p => ({ id: p.id, handle: p.handle })),
        });
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

      const oathGame = resolveOathGame(agentId);
      const game = resolveGame(agentId);
      const lobby = resolveLobby(agentId);

      // === OATHBREAKER game phase ===
      if (oathGame) {
        const handles = getHandlesForAgent(agentId);
        const oathState = oathGame.state as OathState;

        if (oathState.phase === 'finished') {
          const state = oathGame.getVisibleState(agentId) as any;
          return res.json({ reason: 'game_over', gameType: 'oathbreaker', gameOver: true, ...state, handles });
        }

        if (hasAgentMissedTurn(agentId, oathState.round)) {
          const state = oathGame.getVisibleState(agentId) as any;
          setAgentLastTurn(agentId, oathState.round);
          return res.json({ reason: 'round_changed', gameType: 'oathbreaker', ...state, handles });
        }

        // Pending relay updates? Return immediately
        if (hasPendingUpdates(agentId, resolveGame, resolveLobby, resolveRelay)) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'update', gameType: 'oathbreaker', ...updates, handles });
        }

        // Return current state (OATHBREAKER is async — agents can act at any time)
        const state = oathGame.getVisibleState(agentId) as any;
        if (state) {
          // Block until state changes or timeout
          const prevRound = oathState.round;
          await Promise.race([
            waitForNextTurn(oathGame.gameId, 25000),
            waitForAgentUpdate(agentId, 25000),
          ]);

          const updatedOath = resolveOathGame(agentId);
          if (!updatedOath) return res.json({ reason: 'game_ended', gameType: 'oathbreaker' });

          const updatedState = updatedOath.state as OathState;
          if (updatedState.phase === 'finished') {
            const s = updatedOath.getVisibleState(agentId) as any;
            return res.json({ reason: 'game_over', gameType: 'oathbreaker', gameOver: true, ...s, handles });
          }

          const s = updatedOath.getVisibleState(agentId) as any;
          if (updatedState.round > prevRound) {
            setAgentLastTurn(agentId, updatedState.round);
            return res.json({ reason: 'round_changed', gameType: 'oathbreaker', ...s, handles });
          }
          return res.json({ reason: 'update', gameType: 'oathbreaker', ...s, handles });
        }
      }

      // === CtL Game phase ===
      if (game) {
        const handles = getHandlesForAgent(agentId);

        if (game.state.phase === 'finished') {
          const state = game.getVisibleState(agentId) as any;
          return res.json({ reason: 'game_over', gameOver: true, winner: game.state.winner, ...state, handles });
        }

        // If the turn advanced since agent last got full state, return full state
        if (hasAgentMissedTurn(agentId, game.state.turn)) {
          const state = game.getVisibleState(agentId) as any;
          setAgentLastTurn(agentId, game.state.turn);
          buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'turn_changed', moveSubmitted: hasSubmitted(game, agentId), ...state, handles });
        }

        // Pending updates? Return immediately
        if (hasPendingUpdates(agentId, resolveGame, resolveLobby, resolveRelay)) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'update', ...updates, handles });
        }

        // No move yet: return full state
        if (!hasSubmitted(game, agentId)) {
          const state = game.getVisibleState(agentId) as any;
          setAgentLastTurn(agentId, game.state.turn);
          return res.json({ reason: 'new_turn', moveSubmitted: false, ...state, handles });
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
          const state = updatedGame.getVisibleState(agentId) as any;
          return res.json({ reason: 'game_over', gameOver: true, winner: updatedGame.state.winner, ...state, handles });
        }

        if (updatedGame.state.turn > prevTurn) {
          const state = updatedGame.getVisibleState(agentId) as any;
          setAgentLastTurn(agentId, updatedGame.state.turn);
          return res.json({ reason: 'turn_changed', ...state, handles });
        }

        const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
        return res.json({ reason: 'update', ...updates, handles });
      }

      // === Lobby phase ===
      if (lobby) {
        if (hasPendingUpdates(agentId, resolveGame, resolveLobby, resolveRelay)) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'update', ...updates });
        }

        const prevPhase = lobby.phase;
        await waitForAgentUpdate(agentId, 25000);

        // After waking, check if game started (CtL or OATHBREAKER)
        const newOathGame = resolveOathGame(agentId);
        if (newOathGame) {
          const state = newOathGame.getVisibleState(agentId) as any;
          const gameHandles = getHandlesForAgent(agentId);
          return res.json({ reason: 'game_started', phase: 'game', gameType: 'oathbreaker', ...state, handles: gameHandles });
        }
        const newGame = resolveGame(agentId);
        if (newGame) {
          const state = newGame.getVisibleState(agentId) as any;
          const gameHandles = getHandlesForAgent(agentId);
          return res.json({ reason: 'game_started', phase: 'game', ...state, handles: gameHandles });
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

      // === OATHBREAKER waiting room ===
      const waitingRoom = resolveWaitingRoom(agentId);
      if (waitingRoom) {
        // Long-poll: wait until game starts or more players join
        await waitForAgentUpdate(agentId, 25000);

        // After waking, check if game started (waiting room promoted to game)
        const newOathGame = resolveOathGame(agentId);
        if (newOathGame) {
          const state = newOathGame.getVisibleState(agentId) as any;
          const gameHandles = getHandlesForAgent(agentId);
          return res.json({ reason: 'game_started', phase: 'game', gameType: 'oathbreaker', ...state, handles: gameHandles });
        }

        // Still in waiting room — return current state
        const updatedRoom = resolveWaitingRoom(agentId);
        if (!updatedRoom) return res.json({ reason: 'waiting_room_closed' });
        return res.json({
          reason: 'update',
          phase: 'waiting',
          gameType: 'oathbreaker',
          gameId: updatedRoom.id,
          targetPlayers: updatedRoom.targetPlayers,
          currentPlayers: updatedRoom.players.length,
          players: updatedRoom.players.map(p => ({ id: p.id, handle: p.handle })),
        });
      }

      return res.status(404).json({ error: 'No active lobby or game. Join a lobby first.' });
    });

    // ------------------------------------------------------------------
    // 7. POST /move — Submit a move
    // ------------------------------------------------------------------
    router.post('/move', requirePlayerAuth, async (req: any, res: any) => {
      const agentId = req.agentId as string;
      const { path, action, target, class: unitClass } = req.body ?? {};

      // Lobby phase actions via generic move
      if (action) {
        const lobby = resolveLobby(agentId);
        if (!lobby) return res.status(400).json({ error: 'No lobby available for this action.' });

        switch (action) {
          case 'propose-team': {
            // Accept name or agentId as target
            let resolvedTarget = target;
            if (resolvedTarget && handleRegistry.has(resolvedTarget)) {
              resolvedTarget = handleRegistry.get(resolvedTarget)!;
            }
            if (!resolvedTarget) return res.status(400).json({ error: 'propose-team requires "target" (name or agentId).' });
            if (lobby.phase !== 'forming') return res.status(400).json({ error: 'Team proposals only during forming phase.' });
            const result = lobby.proposeTeam(agentId, resolvedTarget);
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

      // OATHBREAKER game actions
      const oathGame = resolveOathGame(agentId);
      if (oathGame) {
        const { amount, decision } = req.body ?? {};
        const oathState = oathGame.state as OathState;

        if (oathState.phase !== 'playing') {
          return res.status(400).json({ error: `Cannot submit actions -- game phase is: ${oathState.phase}` });
        }

        // Determine action type from body fields
        if (amount !== undefined) {
          // propose_pledge
          const oathAction: OathAction = { type: 'propose_pledge', amount: Number(amount) };
          const result = await oathGame.handleAction(agentId, oathAction);
          if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to propose pledge.' });
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ success: true, action: 'propose_pledge', amount: Number(amount), ...updates });
        }

        if (decision !== undefined) {
          // submit_decision
          if (decision !== 'C' && decision !== 'D') {
            return res.status(400).json({ error: 'decision must be "C" (cooperate) or "D" (defect)' });
          }
          const oathAction: OathAction = { type: 'submit_decision', decision };
          const result = await oathGame.handleAction(agentId, oathAction);
          if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to submit decision.' });
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ success: true, action: 'submit_decision', decision, ...updates });
        }

        return res.status(400).json({ error: 'OATHBREAKER requires "amount" (propose_pledge) or "decision" (submit_decision, "C" or "D")' });
      }

      // CtL gameplay move (direction path)
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
      const actionResult = await game.handleAction(agentId, { type: 'move', agentId, path: directions });
      if (!actionResult.success) return res.status(400).json({ error: actionResult.error ?? 'Failed to submit move.' });
      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, path: directions, ...updates });
    });

    // (No dedicated /chat endpoint — chat goes through /tool as basic-chat:chat)

    // ------------------------------------------------------------------
    // 9. POST /lobby/join — Join a lobby or OATHBREAKER waiting room
    // ------------------------------------------------------------------
    router.post('/lobby/join', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const agentName = req.agentName as string;
      const lobbyId = req.body?.lobbyId ?? req.body?.gameId;
      if (!lobbyId) return res.status(400).json({ error: 'lobbyId is required' });

      // Try CtL lobby first
      const lobbyRoom = this.lobbies.get(lobbyId);
      if (lobbyRoom) {
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
      }

      // Try OATHBREAKER waiting room
      const waitingRoom = this.waitingRooms.get(lobbyId);
      if (waitingRoom) {
        const result = this.joinOathbreakerWaitingRoom(lobbyId, agentId, agentName);
        if (!result.success) return res.status(400).json({ error: result.error });

        console.log(`[REST] Agent ${agentId} (${agentName}) joined OATHBREAKER waiting room ${lobbyId}`);

        // If the waiting room promoted to a game, resolve game state
        if (result.gameStarted) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ success: true, agentId, gameId: result.gameId, gameType: 'oathbreaker', phase: 'playing', ...updates });
        }

        return res.json({ success: true, agentId, gameId: lobbyId, gameType: 'oathbreaker', phase: 'waiting' });
      }

      return res.status(404).json({ error: 'Lobby not found' });
    });

    // ------------------------------------------------------------------
    // 10. POST /lobby/create — Create a lobby
    // ------------------------------------------------------------------
    router.post('/lobby/create', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const agentName = req.agentName as string;
      const gameType = req.body?.gameType ?? 'capture-the-lobster';

      if (this.activeGameCount() >= this.maxConcurrentGames) {
        return res.status(429).json({ error: 'Server busy -- a lobby or game is already running.' });
      }

      if (gameType === 'oathbreaker') {
        // OATHBREAKER lobby — FFA, no teams, configurable player count
        const playerCount = Math.min(20, Math.max(4, Math.floor((req.body?.playerCount as number) || 4)));
        const roomId = this.createOathbreakerWaitingRoom(playerCount, [{ id: agentId, handle: agentName }]);

        console.log(`[REST] Agent ${agentId} (${agentName}) created OATHBREAKER waiting room ${roomId} (${playerCount} players)`);

        return res.json({ success: true, gameId: roomId, gameType: 'oathbreaker', playerCount, phase: 'waiting' });
      }

      // Default: CtL lobby
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
      const { agentId: targetAgentId, name: targetName } = req.body ?? {};

      // Resolve target: accept either agentId or name
      let resolvedTarget = targetAgentId;
      if (!resolvedTarget && targetName) {
        resolvedTarget = handleRegistry.get(targetName);
        if (!resolvedTarget) return res.status(404).json({ error: `Agent "${targetName}" not found` });
      }
      if (!resolvedTarget) return res.status(400).json({ error: 'name or agentId (target) is required' });

      const lobby = resolveLobby(agentId);
      if (!lobby) return res.status(400).json({ error: 'No lobby available.' });
      if (lobby.phase !== 'forming') return res.status(400).json({ error: 'Team proposals only during forming phase.' });

      const result = lobby.proposeTeam(agentId, resolvedTarget);
      if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to propose team.' });

      const targetDisplay = getAgentName(resolvedTarget);
      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({
        success: true,
        teamId: result.teamId,
        message: `Invited ${targetDisplay} to ${result.teamId}. They need to call accept_team.`,
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

      // If the plugin returned relay data, send it through the typed relay.
      // The plugin decides scope — the server just routes. No interpretation.
      if (result && (result as any).relay) {
        const relayData = (result as any).relay;
        const scope = relayData.scope ?? 'all';

        const oathGame = resolveOathGame(agentId);
        const game = resolveGame(agentId);
        const lobby = resolveLobby(agentId);

        if (oathGame) {
          // OATHBREAKER relay
          const gameId = this.agentToGame.get(agentId)!;
          const oathRoom = this.games.get(gameId);
          if (oathRoom) {
            const oathState = oathGame.state as OathState;
            oathRoom.relay.send(agentId, oathState.round, {
              type: relayData.type,
              data: relayData.data,
              scope,
              pluginId: relayData.pluginId ?? pluginId,
            });
            for (const player of oathState.players) {
              if (player.id !== agentId) notifyAgent(player.id);
            }
          }
        } else if (game) {
          const gameId = this.agentToGame.get(agentId)!;
          const room = this.games.get(gameId);
          if (room) {
            room.relay.send(agentId, game.state.turn, {
              type: relayData.type,
              data: relayData.data,
              scope,
              pluginId: relayData.pluginId ?? pluginId,
            });
            this.broadcastSpectatorState(room);
            for (const unit of game.state.units) {
              if (unit.id !== agentId) notifyAgent(unit.id);
            }
          }
        } else if (lobby) {
          // Lobby phase: route through lobby's message system
          if (relayData.type === 'messaging' && relayData.data?.body) {
            if (scope === 'team' && lobby.phase === 'pre_game') {
              lobby.teamChat(agentId, relayData.data.body);
            } else {
              // 'all' or lobby forming phase — public chat
              lobby.lobbyChat(agentId, relayData.data.body);
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
        if (room) {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            room.spectators.add(ws);

            // Send current state (uses delayed view for CtL, immediate for OATHBREAKER)
            const state = getSpectatorViewForRoom(room);
            if (state) {
              const extra = room.gameType === 'oathbreaker' ? { gameType: 'oathbreaker' } : {};
              ws.send(JSON.stringify({ type: 'state_update', data: { ...extra, ...state as any } }));
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

        // Check waiting rooms (OATHBREAKER pre-game)
        const waitingRoom = this.waitingRooms.get(gameId);
        if (waitingRoom) {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            waitingRoom.spectators.add(ws);

            // Send current waiting room state
            ws.send(JSON.stringify({
              type: 'state_update',
              data: {
                gameType: 'oathbreaker',
                phase: 'waiting',
                targetPlayers: waitingRoom.targetPlayers,
                players: waitingRoom.players.map(p => ({ id: p.id, handle: p.handle })),
              },
            }));

            ws.on('close', () => {
              waitingRoom.spectators.delete(ws);
            });

            ws.on('error', () => {
              waitingRoom.spectators.delete(ws);
            });
          });
          return;
        }

        socket.destroy();
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
  // Broadcast spectator state (unified for all game types)
  // ---------------------------------------------------------------------------

  private broadcastSpectatorState(room: GameRoomData): void {
    const state = getSpectatorViewForRoom(room);
    if (!state) return;

    // Include relay messages for spectators (delayed for CtL, immediate for others)
    const delay = room.plugin.spectatorDelay ?? 0;
    const currentProgress = room.gameType === 'capture-the-lobster'
      ? room.game.state.turn
      : (room.game.state as any).round ?? 0;
    const delayedProgress = Math.max(0, currentProgress - delay);
    const relayMessages = room.relay.getSpectatorMessages(delayedProgress);

    const extra = room.gameType === 'oathbreaker' ? { gameType: 'oathbreaker' } : {};
    const stateWithRelay = { ...extra, ...state as any, relayMessages };

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
    // Count active waiting rooms
    count += this.waitingRooms.size;
    return count;
  }

  createBotGame(teamSize: number = 4): { gameId: string; game: CtlGameRoom } {
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
    const turnLimit = getTurnLimitForRadius(radius);
    const ctlConfig: CtlConfig = {
      mapSeed: gameId,
      mapRadius: radius,
      teamSize,
      turnLimit,
      turnTimerSeconds: 30,
      players: players.map(p => ({ id: p.id, team: p.team, unitClass: p.unitClass })),
    };
    const game = createCtlGameRoom(gameId, ctlConfig);

    // Take initial snapshot
    const relay = new GameRelay(players.map(p => ({ id: p.id, team: p.team })));
    const initialState = buildSpectatorState(game.state, null, handleMap, relay);

    const room: GameRoomData = {
      gameType: 'capture-the-lobster',
      plugin: CaptureTheLobsterPlugin,
      game,
      spectators: new Set(),
      finished: false,
      externalSlots: new Map(),
      handleMap,
      relay,
      botSessions: createBotSessions(
        players.map(p => ({ id: p.id, handle: handleMap[p.id] ?? p.id, team: p.team })),
        this.serverUrl,
        (id, handle) => createBotToken(id, handle),
        [BasicChatPlugin],
      ),
      lobbyChat: [],
      preGameChatA: [],
      preGameChatB: [],
      // Legacy CtL fields
      stateHistory: [initialState],
      spectatorDelay: 2,
      botHandles,
      botMeta: players,
      turnTimeoutMs: 30000,
    };

    this.games.set(gameId, room);

    // Wire callbacks and start the game
    this.wireCallbacks(gameId, room);
    game.handleAction(null, { type: 'game_start' });

    return { gameId, game };
  }

  // ---------------------------------------------------------------------------
  // OATHBREAKER waiting room + game creation
  // ---------------------------------------------------------------------------

  /**
   * Create an OATHBREAKER waiting room.
   * Players collect here before the game is created. When enough players join,
   * the waiting room promotes to a real game with game_start fired immediately.
   */
  createOathbreakerWaitingRoom(
    targetPlayers: number,
    initialPlayers: { id: string; handle: string }[],
  ): string {
    const roomId = crypto.randomUUID();

    const waitingRoom: OathWaitingRoom = {
      id: roomId,
      gameType: 'oathbreaker',
      targetPlayers,
      players: [...initialPlayers],
      spectators: new Set(),
      createdAt: Date.now(),
    };

    this.waitingRooms.set(roomId, waitingRoom);

    for (const p of initialPlayers) {
      this.agentToWaitingRoom.set(p.id, roomId);
    }

    console.log(`[OATHBREAKER] Waiting room ${roomId} created (${initialPlayers.length}/${targetPlayers} players)`);

    // Check if we already have enough players
    if (initialPlayers.length >= targetPlayers) {
      this.promoteWaitingRoom(roomId);
    }

    return roomId;
  }

  /**
   * Join an OATHBREAKER waiting room.
   */
  joinOathbreakerWaitingRoom(
    roomId: string,
    agentId: string,
    handle: string,
  ): { success: boolean; error?: string; gameStarted?: boolean; gameId?: string } {
    const waitingRoom = this.waitingRooms.get(roomId);
    if (!waitingRoom) return { success: false, error: 'Waiting room not found' };

    // Check if already in the room
    if (waitingRoom.players.some(p => p.id === agentId)) {
      return { success: false, error: 'Already in this waiting room' };
    }

    // Check if room is full
    if (waitingRoom.players.length >= waitingRoom.targetPlayers) {
      return { success: false, error: 'Waiting room is full' };
    }

    waitingRoom.players.push({ id: agentId, handle });
    this.agentToWaitingRoom.set(agentId, roomId);

    // Notify existing players that someone joined
    for (const p of waitingRoom.players) {
      if (p.id !== agentId) notifyAgent(p.id);
    }

    // Broadcast to spectators
    this.broadcastWaitingRoomState(waitingRoom);

    console.log(`[OATHBREAKER] ${handle} (${agentId}) joined waiting room ${roomId} (${waitingRoom.players.length}/${waitingRoom.targetPlayers})`);

    // Check if we have enough players to start
    if (waitingRoom.players.length >= waitingRoom.targetPlayers) {
      const gameId = this.promoteWaitingRoom(roomId);
      return { success: true, gameStarted: true, gameId };
    }

    return { success: true };
  }

  /**
   * Promote a waiting room to a real OATHBREAKER game.
   * Creates the GameRoom, fires game_start, cleans up the waiting room.
   */
  private promoteWaitingRoom(roomId: string): string {
    const waitingRoom = this.waitingRooms.get(roomId)!;
    const players = waitingRoom.players;
    const gameId = roomId; // Reuse the ID so spectator WebSocket connections carry over

    const handleMap: Record<string, string> = {};
    for (const p of players) {
      handleMap[p.id] = p.handle;
      // Move agent mapping from waiting room to game
      this.agentToWaitingRoom.delete(p.id);
      this.agentToGame.set(p.id, gameId);
    }

    const oathConfig: OathConfig = {
      ...DEFAULT_OATH_CONFIG,
      playerIds: players.map(p => p.id),
      seed: gameId,
    };

    const game = GameRoom.create(OathbreakerPlugin, oathConfig, gameId) as OathGameRoom;
    const relay = new GameRelay(players.map(p => ({ id: p.id, team: 'FFA' })));

    const room: GameRoomData = {
      gameType: 'oathbreaker',
      plugin: OathbreakerPlugin,
      game,
      spectators: waitingRoom.spectators, // Transfer spectators from waiting room
      finished: false,
      externalSlots: new Map(players.map(p => [p.id, { token: '', agentId: p.id, connected: true }])),
      handleMap,
      relay,
      botSessions: [],
      lobbyChat: [],
      preGameChatA: [],
      preGameChatB: [],
    };

    this.games.set(gameId, room);

    // Remove the waiting room
    this.waitingRooms.delete(roomId);

    // Wire callbacks and start immediately
    this.wireCallbacks(gameId, room);
    game.handleAction(null, { type: 'game_start' });

    // Notify all players that the game has started
    for (const p of players) {
      notifyAgent(p.id);
    }

    console.log(`[OATHBREAKER] Waiting room ${roomId} promoted to game ${gameId} with ${players.length} players`);
    return gameId;
  }

  /**
   * Broadcast waiting room state to WebSocket spectators.
   */
  private broadcastWaitingRoomState(waitingRoom: OathWaitingRoom): void {
    const data = {
      type: 'state_update',
      data: {
        gameType: 'oathbreaker',
        phase: 'waiting',
        targetPlayers: waitingRoom.targetPlayers,
        players: waitingRoom.players.map(p => ({ id: p.id, handle: p.handle })),
      },
    };
    const msg = JSON.stringify(data);
    for (const ws of waitingRoom.spectators) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Unified GameRoom callback wiring (all game types)
  // ---------------------------------------------------------------------------

  /**
   * Wire onStateChange and onGameOver callbacks for any GameRoom.
   * The GameRoom handles deadline timers and turn resolution internally.
   * The server just needs to broadcast state changes, schedule bots, and handle game over.
   */
  private wireCallbacks(gameId: string, room: GameRoomData): void {
    const { game } = room;

    game.onStateChange = () => {
      // Notify waiting agents
      notifyTurnResolved(gameId);

      // For CtL: snapshot spectator state into cache (frontend expects SpectatorState format)
      if (room.gameType === 'capture-the-lobster' && room.stateHistory) {
        const history = game.getStateHistory();
        const prevState = history.length >= 2 ? history[history.length - 2] : null;
        const spectatorState = buildSpectatorState(game.state, prevState, room.handleMap, room.relay);
        room.stateHistory.push(spectatorState);
      }

      // Broadcast spectator view (with delay from plugin)
      this.broadcastSpectatorState(room);

      // Notify all external agents
      for (const [agentId] of room.externalSlots) {
        notifyAgent(agentId);
      }

      // Run bots if the plugin defines getPlayersNeedingAction
      this.runBotsGeneric(room, gameId);
    };

    game.onGameOver = () => {
      this.finishGameGeneric(gameId, room);
    };
  }

  /**
   * Run bots generically — uses plugin.getPlayersNeedingAction to determine which bots need to act.
   */
  private runBotsGeneric(room: GameRoomData, gameId: string): void {
    if (room.botSessions.length === 0) return;
    if (room.finished || room.game.isOver()) return;
    if (!room.plugin.getPlayersNeedingAction) return;

    const needsAction = new Set<string>(room.plugin.getPlayersNeedingAction(room.game.state));
    const activeBots = room.botSessions.filter(bot => needsAction.has(bot.id));
    if (activeBots.length === 0) return;

    // Run bots with timeout
    const timeoutMs = (room.turnTimeoutMs ?? 30000) - 2000;
    const turn = room.game.progressCounter;

    Promise.race([
      runAllBotsTurn(activeBots, turn, needsAction),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(5000, timeoutMs))),
    ]).catch(err => console.error(`[Bots] Error in game ${gameId}:`, err));
  }

  /**
   * Handle game over generically — works for all game types.
   * Broadcasts final state, records ELO (if applicable), builds game result.
   */
  private finishGameGeneric(gameId: string, room: GameRoomData): void {
    if (room.finished) return;
    room.finished = true;

    // For CtL: build final spectator state snapshot
    if (room.gameType === 'capture-the-lobster' && room.stateHistory) {
      const history = room.game.getStateHistory();
      const prevState = history.length >= 2 ? history[history.length - 2] : null;
      const finalState = buildSpectatorState(room.game.state, prevState, room.handleMap, room.relay);
      room.stateHistory.push(finalState);
    }

    // Final spectator broadcast (no delay — show the ending)
    const spectatorView = room.gameType === 'capture-the-lobster'
      ? room.stateHistory?.[room.stateHistory.length - 1]
      : room.game.getVisibleState(null);
    if (spectatorView) {
      const extra = room.gameType === 'oathbreaker' ? { gameType: 'oathbreaker' } : {};
      const msg = JSON.stringify({ type: 'game_over', data: { ...extra, ...spectatorView as any } });
      for (const ws of room.spectators) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }
    }

    // Wake up any external agents waiting on wait_for_update
    notifyTurnResolved(gameId);

    // Notify all external agents
    for (const [agentId] of room.externalSlots) {
      notifyAgent(agentId);
    }

    // Record ELO (CtL-specific — uses team/unitClass from units)
    if (room.gameType === 'capture-the-lobster') {
      try {
        const players = room.game.state.units.map((u: any) => {
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
    }

    console.log(`[Game] Game ${gameId} (${room.gameType}) finished.`);

    // Build game result with Merkle root for on-chain anchoring (if applicable)
    if (room.gameType === 'capture-the-lobster') {
      try {
        const playerIds = room.game.state.units.map((u: any) => u.id);
        const result = buildGameResultFromRoom(room.game, gameId, playerIds);
        const payouts = room.game.computePayouts(playerIds);
        console.log(`[Coordination] Game result built. Actions root: ${result.actionsRoot.slice(0, 16)}... Actions: ${result.actionCount}`);
        const payoutSummary = [...payouts.entries()].map(([id, delta]) => `${id}:${delta > 0 ? '+' : ''}${delta}`).join(', ');
        console.log(`[Coordination] Payouts: ${payoutSummary}`);
      } catch (err) {
        console.error('[Coordination] Failed to build game result:', err);
      }
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
    const turnLimit = getTurnLimitForRadius(radius);
    const ctlConfig: CtlConfig = {
      mapSeed: gameId,
      mapRadius: radius,
      teamSize,
      turnLimit,
      turnTimerSeconds: 30,
      players: players.map(p => ({ id: p.id, team: p.team, unitClass: p.unitClass })),
    };
    const game = createCtlGameRoom(gameId, ctlConfig);

    const relay = new GameRelay(players.map(p => ({ id: p.id, team: p.team })));
    const initialState = buildSpectatorState(game.state, null, handleMap, relay);

    const room: GameRoomData = {
      gameType: 'capture-the-lobster',
      plugin: CaptureTheLobsterPlugin,
      game,
      spectators: new Set(),
      finished: false,
      externalSlots,
      handleMap,
      relay,
      botSessions: createBotSessions(
        players.filter((p) => !p.id.startsWith('ext_')).map(p => ({
          id: p.id, handle: handleMap[p.id] ?? p.id, team: p.team,
        })),
        this.serverUrl,
        (id, handle) => createBotToken(id, handle),
        [BasicChatPlugin],
      ),
      lobbyChat,
      preGameChatA,
      preGameChatB,
      // Legacy CtL fields
      stateHistory: [initialState],
      spectatorDelay: 2,
      botHandles,
      botMeta: players,
      turnTimeoutMs: 30000,
    };

    this.games.set(gameId, room);

    // Wire callbacks and start the game
    this.wireCallbacks(gameId, room);

    // Notify external agents that the game has started (wakes wait_for_update)
    for (const p of players) {
      if (p.id.startsWith('ext_')) {
        notifyAgent(p.id);
      }
    }

    // Start the game (triggers first deadline)
    game.handleAction(null, { type: 'game_start' });

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
      room.game.cancelTimer();
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
