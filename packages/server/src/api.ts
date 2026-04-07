import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';

import {
  LobbyManager as EngineLobbyManager,
} from '@coordination-games/game-ctl';
import {
  type UnitClass,
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
  type GameResolver,
  type LobbyResolver,
  type RelayResolver,
} from './mcp-http.js';
import { createRelayRouter } from './relay.js';
import { GameRelay } from './typed-relay.js';
import { GameRoom, buildActionMerkleTree, type MerkleLeafData, getRegisteredGames, getGame } from '@coordination-games/engine';
import { DEFAULT_OATH_CONFIG } from '@coordination-games/game-oathbreaker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  botHandles?: string[];                         // handles of bot players in this room
  turnTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Game result helpers
// ---------------------------------------------------------------------------

function buildGameResultFromRoom(
  room: GameRoom<any, any, any, any>,
  gameId: string,
  gameType: string,
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
    gameType,
    players: playerIds,
    outcome: room.getOutcome(),
    actionsRoot: tree.root,
    configHash: '',
    actionCount: room.actionLog.length,
    timestamp: Date.now(),
  };
}

/** Check if a player has submitted their action for the current progress point. Uses plugin's getPlayersNeedingAction. */
function hasSubmitted(game: GameRoom<any, any, any, any>, plugin: any, agentId: string): boolean {
  if (!plugin.getPlayersNeedingAction) return false;
  const needsAction = plugin.getPlayersNeedingAction(game.state) as string[];
  return !needsAction.includes(agentId);
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
// Waiting room (pre-game player collection, generic for FFA games)
// ---------------------------------------------------------------------------

export interface WaitingRoom {
  id: string;
  gameType: string;
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
  readonly waitingRooms: Map<string, WaitingRoom> = new Map();
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
        games: getRegisteredGames(),
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

    // Create a lobby (generic — routes to waiting room or lobby runner based on plugin config)
    router.post('/lobbies/create', (req, res) => {
      if (this.activeGameCount() >= this.maxConcurrentGames) {
        return res.status(429).json({ error: 'Server busy — a lobby or game is already running. Wait for it to finish.' });
      }
      const gameType = req.body?.gameType ?? 'capture-the-lobster';
      const plugin = getGame(gameType);
      if (!plugin) return res.status(400).json({ error: `Unknown game type: ${gameType}` });

      const lobbyConfig = plugin.lobby;
      if (!lobbyConfig || lobbyConfig.matchmaking.numTeams === 0) {
        // FFA game — use waiting room pattern
        const maxPlayers = lobbyConfig?.matchmaking.maxPlayers ?? 20;
        const minPlayers = lobbyConfig?.matchmaking.minPlayers ?? 4;
        const playerCount = Math.min(maxPlayers, Math.max(minPlayers, Math.floor((req.body?.playerCount as number) || minPlayers)));
        const roomId = this.createWaitingRoom(gameType, playerCount, []);
        console.log(`[REST] Created ${gameType} waiting room ${roomId} (${playerCount} players) via /lobbies/create`);
        return res.status(201).json({ gameId: roomId, gameType, playerCount, phase: 'waiting' });
      } else {
        // Team game — use lobby runner
        const teamSize = Math.min(6, Math.max(2, Math.floor((req.body?.teamSize as number) || lobbyConfig.matchmaking.teamSize)));
        const timeoutMs = (req.body?.timeoutMs as number) || 600000;
        const { lobbyId } = this.createLobbyGame(teamSize, timeoutMs);
        return res.status(201).json({ lobbyId, teamSize });
      }
    });

    // Fill remaining lobby/waiting-room slots with bots (requires admin password since bots use API credits)
    router.post('/lobbies/:id/fill-bots', (req, res) => {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (adminPassword && req.body?.password !== adminPassword) {
        return res.status(401).json({ error: 'Admin password required to add bots (they use API credits).' });
      }

      // Try lobby first
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

      // Try waiting room (any game type)
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
          const agentId = `bot_${waitingRoom.gameType.substring(0, 4)}_${currentCount + i}`;
          this.joinWaitingRoom(req.params.id, agentId, handle);
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

    // List active games (generic — uses plugin.getSummary when available)
    router.get('/games', (_req, res) => {
      const list: any[] = Array.from(this.games.entries()).map(([id, room]) => ({
        id,
        gameType: room.gameType,
        ...(room.plugin.getSummary ? room.plugin.getSummary(room.game.state) : {}),
        spectators: room.spectators.size,
        externalAgents: room.externalSlots.size,
      }));

      // Include waiting rooms as games with phase 'waiting'
      for (const [id, wr] of this.waitingRooms) {
        const plugin = getGame(wr.gameType);
        list.push({
          id,
          gameType: wr.gameType,
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
          gameType: waitingRoom.gameType,
          targetPlayers: waitingRoom.targetPlayers,
          phase: 'waiting',
          players: waitingRoom.players.map(p => ({ id: p.id, handle: p.handle })),
        });
      }

      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const state = this.getSpectatorViewForRoom(room);
      if (!state) return res.status(200).json({ phase: 'pre_game' });
      const extra: Record<string, any> = { gameType: room.gameType };
      if (room.lobbyChat?.length) extra.lobbyChat = room.lobbyChat;
      if (room.preGameChatA?.length) extra.preGameChatA = room.preGameChatA;
      if (room.preGameChatB?.length) extra.preGameChatB = room.preGameChatB;
      res.json({ ...extra, ...state as any });
    });

    // Current spectator state (delayed)
    router.get('/games/:id/state', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const state = this.getSpectatorViewForRoom(room);
      if (!state) return res.status(200).json({ phase: 'pre_game' });
      const extra = { gameType: room.gameType };
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

      const msg = room.relay.send(sender, room.game.progressCounter, {
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
      for (const playerId of room.game.playerIds) {
        if (playerId !== sender) notifyAgent(playerId);
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

      if (!room.game.isOver()) {
        return res.status(400).json({ error: 'Game is still in progress' });
      }

      // Build spectator views for each progress snapshot
      const allMessages = room.relay.getAllMessages();
      const history = room.game.getStateHistory();
      const turns = history.map((state, i) => {
        const prevState = i > 0 ? history[i - 1] : null;
        const messagesUpTo = allMessages.filter(m => m.turn <= i);
        return room.plugin.buildSpectatorView(state, prevState, { handles: room.handleMap, relayMessages: messagesUpTo });
      });
      const outcome = room.game.isOver() ? room.game.getOutcome() : null;
      res.json({
        gameId: room.game.gameId,
        gameType: room.gameType,
        turns,
        outcome,
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
        gameType: room.gameType,
        actions,
        stateHistory: room.game.getStateHistory(),
        outcome: room.game.isOver() ? room.game.getOutcome() : null,
      });
    });

    // GET /games/:id/result — on-chain GameResult with Merkle root
    router.get('/games/:id/result', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      if (!room.game.isOver()) {
        return res.status(400).json({ error: 'Game is still in progress' });
      }

      try {
        const playerIds = [...room.game.playerIds];
        const result = buildGameResultFromRoom(room.game, req.params.id, room.gameType, playerIds);
        const payouts = room.game.computePayouts(playerIds);
        res.json({
          ...result,
          payouts: Object.fromEntries(payouts),
        });
      } catch (err: any) {
        res.json({
          gameId: req.params.id,
          gameType: room.gameType,
          players: [...room.game.playerIds],
          outcome: room.game.isOver() ? room.game.getOutcome() : null,
          movesRoot: null,
          configHash: null,
          actionCount: room.game.actionLog.length,
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
    const resolveGameRoom = (agentId: string): { room: GameRoomData; game: GameRoom<any, any, any, any> } | null => {
      const gameId = this.agentToGame.get(agentId);
      if (!gameId) return null;
      const room = this.games.get(gameId);
      if (!room) return null;
      return { room, game: room.game };
    };

    // Generic game resolver for buildUpdates/hasPendingUpdates
    const resolveGame: GameResolver = (agentId: string): GameRoom<any, any, any, any> | null => {
      const result = resolveGameRoom(agentId);
      return result?.game ?? null;
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

    const resolveWaitingRoom = (agentId: string): WaitingRoom | null => {
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
    // 4. GET /guide — Dynamic playbook (generic, reads from game plugin)
    // ------------------------------------------------------------------
    router.get('/guide', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;

      const resolvedGuide = resolveGameRoom(agentId);
      const lobby = resolveLobby(agentId);

      // Determine which game's guide to show:
      // 1. Explicit ?game= query param takes priority
      // 2. Auto-detect from player's current game
      // 3. Default to capture-the-lobster
      const requestedGame = (req.query.game as string)?.toLowerCase();
      const detectedGame = resolvedGuide?.room.gameType ?? 'capture-the-lobster';
      const gameType = requestedGame || detectedGame;

      // Look up the game plugin from the registry
      const plugin = getGame(gameType);
      if (!plugin) {
        return res.status(404).json({ error: `Unknown game type: ${gameType}` });
      }

      // Game rules from the plugin
      let guide = plugin.guide ?? `# ${gameType}\nNo guide available.`;

      // Player-specific status from the plugin
      if (plugin.getPlayerStatus && resolvedGuide) {
        guide += plugin.getPlayerStatus(resolvedGuide.game.state, agentId);
      } else if (lobby) {
        guide += `\n## Your Status\n- **Phase:** ${lobby.phase}\n- **Lobby:** active\n`;
      } else {
        guide += `\n## Your Status\n- Not in a game or lobby.\n`;
      }

      // Generic CLI reference (same for all games)
      let cliRef = '\n## CLI Reference\n';
      cliRef += 'The `coga` CLI is how you interact with the game from the command line.\n\n';
      cliRef += '| Command | Description |\n';
      cliRef += '|---------|-------------|\n';
      cliRef += '| `coga status` | Your address, name, credits, registration status |\n';
      cliRef += '| `coga guide` | This guide (auto-detects your game) |\n';
      const gameTypes = getRegisteredGames();
      for (const gt of gameTypes) {
        cliRef += `| \`coga guide ${gt}\` | ${gt} rules |\n`;
      }
      cliRef += '| `coga lobbies` | List active lobbies |\n';
      cliRef += '| `coga create-lobby -s <n>` | Create a lobby (team size 2-6) |\n';
      cliRef += '| `coga join <lobbyId>` | Join a lobby |\n';
      cliRef += '| `coga state` | Get current game/lobby state |\n';
      cliRef += '| `coga move <json>` | Submit an action (move or lobby action) |\n';
      cliRef += '| `coga wait` | Wait for the next update |\n';
      cliRef += '| `coga tool <plugin> <tool> [args]` | Call any plugin tool |\n';
      cliRef += '| `coga verify <gameId>` | Verify game integrity on-chain |\n';
      cliRef += '| `coga serve --stdio` | Start MCP server (for AI agents) |\n';

      guide += cliRef;

      res.json({ guide });
    });

    // ------------------------------------------------------------------
    // 5. GET /state — Get current state (fog-filtered)
    // ------------------------------------------------------------------
    router.get('/state', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;

      // Active game (any type)
      const resolved = resolveGameRoom(agentId);
      if (resolved) {
        const { room, game } = resolved;
        const state = game.getVisibleState(agentId);
        const relay = resolveRelay(agentId);
        const relayMessages = relay?.receive(agentId) ?? [];
        const handles = room.handleMap ?? {};
        const gameTypeExtra = room.gameType !== 'capture-the-lobster' ? { gameType: room.gameType } : {};
        if (game.isOver()) {
          return res.json({ phase: 'finished', gameOver: true, ...gameTypeExtra, ...(state as any), relayMessages, handles });
        }
        return res.json({ phase: 'game', ...gameTypeExtra, ...(state as any), relayMessages, handles });
      }

      // Waiting room (FFA games)
      const waitingRoom = resolveWaitingRoom(agentId);
      if (waitingRoom) {
        return res.json({
          phase: 'waiting',
          gameType: waitingRoom.gameType,
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

      const resolved = resolveGameRoom(agentId);
      const lobby = resolveLobby(agentId);

      // === Active game (any type) ===
      if (resolved) {
        const { room, game } = resolved;
        const handles = getHandlesForAgent(agentId);
        const gameTypeExtra = { gameType: room.gameType };

        if (game.isOver()) {
          const state = game.getVisibleState(agentId) as any;
          return res.json({ reason: 'game_over', gameOver: true, ...gameTypeExtra, ...state, handles });
        }

        // If progress advanced since agent last polled, return full state
        if (hasAgentMissedTurn(agentId, game.progressCounter)) {
          const state = game.getVisibleState(agentId) as any;
          setAgentLastTurn(agentId, game.progressCounter);
          buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'turn_changed', moveSubmitted: hasSubmitted(game, room.plugin, agentId), ...gameTypeExtra, ...state, handles });
        }

        // Pending relay updates? Return immediately
        if (hasPendingUpdates(agentId, resolveGame, resolveLobby, resolveRelay)) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'update', ...gameTypeExtra, ...updates, handles });
        }

        // Agent hasn't acted yet: return full state
        if (!hasSubmitted(game, room.plugin, agentId)) {
          const state = game.getVisibleState(agentId) as any;
          setAgentLastTurn(agentId, game.progressCounter);
          return res.json({ reason: 'new_turn', moveSubmitted: false, ...gameTypeExtra, ...state, handles });
        }

        // Action submitted — block until progress advances, relay update, or timeout
        const prevProgress = game.progressCounter;
        await Promise.race([
          waitForNextTurn(game.gameId, 25000),
          waitForAgentUpdate(agentId, 25000),
        ]);

        const updatedResolved = resolveGameRoom(agentId);
        if (!updatedResolved) return res.json({ reason: 'game_ended', ...gameTypeExtra });

        const { room: updatedRoom, game: updatedGame } = updatedResolved;

        if (updatedGame.isOver()) {
          const state = updatedGame.getVisibleState(agentId) as any;
          return res.json({ reason: 'game_over', gameOver: true, ...gameTypeExtra, ...state, handles });
        }

        if (updatedGame.progressCounter > prevProgress) {
          const state = updatedGame.getVisibleState(agentId) as any;
          setAgentLastTurn(agentId, updatedGame.progressCounter);
          return res.json({ reason: 'turn_changed', ...gameTypeExtra, ...state, handles });
        }

        const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
        return res.json({ reason: 'update', ...gameTypeExtra, ...updates, handles });
      }

      // === Lobby phase ===
      if (lobby) {
        if (hasPendingUpdates(agentId, resolveGame, resolveLobby, resolveRelay)) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ reason: 'update', ...updates });
        }

        const prevPhase = lobby.phase;
        await waitForAgentUpdate(agentId, 25000);

        // After waking, check if game started (any type)
        const newGameResolved = resolveGameRoom(agentId);
        if (newGameResolved) {
          const { room: newRoom, game: newGame } = newGameResolved;
          const state = newGame.getVisibleState(agentId) as any;
          const gameHandles = getHandlesForAgent(agentId);
          return res.json({ reason: 'game_started', phase: 'game', gameType: newRoom.gameType, ...state, handles: gameHandles });
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

      // === Waiting room (FFA games) ===
      const waitingRoom = resolveWaitingRoom(agentId);
      if (waitingRoom) {
        // Long-poll: wait until game starts or more players join
        await waitForAgentUpdate(agentId, 25000);

        // After waking, check if game started (waiting room promoted to game)
        const newGameResolved = resolveGameRoom(agentId);
        if (newGameResolved) {
          const { room: newRoom, game: newGame } = newGameResolved;
          const state = newGame.getVisibleState(agentId) as any;
          const gameHandles = getHandlesForAgent(agentId);
          return res.json({ reason: 'game_started', phase: 'game', gameType: newRoom.gameType, ...state, handles: gameHandles });
        }

        // Still in waiting room — return current state
        const updatedRoom = resolveWaitingRoom(agentId);
        if (!updatedRoom) return res.json({ reason: 'waiting_room_closed' });
        return res.json({
          reason: 'update',
          phase: 'waiting',
          gameType: updatedRoom.gameType,
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

      // Generic game action passthrough — requires `type` field
      const resolved = resolveGameRoom(agentId);
      if (!resolved) return res.status(400).json({ error: 'No game in progress.' });
      const { game: gameInstance } = resolved;

      if (!req.body?.type) {
        return res.status(400).json({ error: 'Game actions require a "type" field. Send a full typed action (e.g. { type: "move", path: [...] }).' });
      }

      const gameAction = { ...req.body };
      // Inject agentId for action types that reference the acting player
      if (gameAction.agentId !== undefined) {
        gameAction.agentId = agentId;
      }
      const result = await gameInstance.handleAction(agentId, gameAction);
      if (!result.success) return res.status(400).json({ error: result.error ?? 'Failed to submit action.' });
      const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
      return res.json({ success: true, ...updates });
    });

    // (No dedicated /chat endpoint — chat goes through /tool as basic-chat:chat)

    // ------------------------------------------------------------------
    // 9. POST /lobby/join — Join a lobby or waiting room
    // ------------------------------------------------------------------
    router.post('/lobby/join', requirePlayerAuth, (req: any, res: any) => {
      const agentId = req.agentId as string;
      const agentName = req.agentName as string;
      const lobbyId = req.body?.lobbyId ?? req.body?.gameId;
      if (!lobbyId) return res.status(400).json({ error: 'lobbyId is required' });

      // Try lobby first
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

      // Try waiting room (any game type)
      const waitingRoom = this.waitingRooms.get(lobbyId);
      if (waitingRoom) {
        const result = this.joinWaitingRoom(lobbyId, agentId, agentName);
        if (!result.success) return res.status(400).json({ error: result.error });

        console.log(`[REST] Agent ${agentId} (${agentName}) joined ${waitingRoom.gameType} waiting room ${lobbyId}`);

        // If the waiting room promoted to a game, resolve game state
        if (result.gameStarted) {
          const updates = buildUpdates(agentId, resolveGame, resolveLobby, resolveRelay);
          return res.json({ success: true, agentId, gameId: result.gameId, gameType: waitingRoom.gameType, phase: 'playing', ...updates });
        }

        return res.json({ success: true, agentId, gameId: lobbyId, gameType: waitingRoom.gameType, phase: 'waiting' });
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

      const plugin = getGame(gameType);
      if (!plugin) return res.status(400).json({ error: `Unknown game type: ${gameType}` });

      const lobbyConfig = plugin.lobby;
      if (!lobbyConfig || lobbyConfig.matchmaking.numTeams === 0) {
        // FFA game — use waiting room pattern, auto-join the creator
        const maxPlayers = lobbyConfig?.matchmaking.maxPlayers ?? 20;
        const minPlayers = lobbyConfig?.matchmaking.minPlayers ?? 4;
        const playerCount = Math.min(maxPlayers, Math.max(minPlayers, Math.floor((req.body?.playerCount as number) || minPlayers)));
        const roomId = this.createWaitingRoom(gameType, playerCount, [{ id: agentId, handle: agentName }]);

        console.log(`[REST] Agent ${agentId} (${agentName}) created ${gameType} waiting room ${roomId} (${playerCount} players)`);

        return res.json({ success: true, gameId: roomId, gameType, playerCount, phase: 'waiting' });
      }

      // Team game — use lobby runner
      const teamSize = Math.min(6, Math.max(2, Math.floor((req.body?.teamSize as number) || lobbyConfig.matchmaking.teamSize)));
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

        const resolvedForRelay = resolveGameRoom(agentId);
        const lobby = resolveLobby(agentId);

        if (resolvedForRelay) {
          const { room: relayRoom, game: relayGame } = resolvedForRelay;
          relayRoom.relay.send(agentId, relayGame.progressCounter, {
            type: relayData.type,
            data: relayData.data,
            scope,
            pluginId: relayData.pluginId ?? pluginId,
          });
          this.broadcastSpectatorState(relayRoom);
          // Notify other players in the game
          for (const [slotAgentId] of relayRoom.externalSlots) {
            if (slotAgentId !== agentId) notifyAgent(slotAgentId);
          }
          // Also notify bot sessions
          for (const bot of relayRoom.botSessions) {
            if (bot.id !== agentId) notifyAgent(bot.id);
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
            const state = this.getSpectatorViewForRoom(room);
            if (state) {
              const extra = { gameType: room.gameType };
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

        // Check waiting rooms (FFA pre-game)
        const waitingRoom = this.waitingRooms.get(gameId);
        if (waitingRoom) {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            waitingRoom.spectators.add(ws);

            // Send current waiting room state
            ws.send(JSON.stringify({
              type: 'state_update',
              data: {
                gameType: waitingRoom.gameType,
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

  /**
   * Get the spectator view for a game room, using the plugin's spectator delay.
   * Uses the engine's GameRoom.getSpectatorView with SpectatorContext.
   */
  private getSpectatorViewForRoom(room: GameRoomData): any {
    const delay = room.plugin.spectatorDelay ?? 0;
    const currentProgress = room.game.progressCounter;
    const delayedProgress = Math.max(0, currentProgress - delay);
    const relayMessages = room.relay.getSpectatorMessages(delayedProgress);
    const ctx = { handles: room.handleMap, relayMessages };
    return room.game.getSpectatorView(delay, ctx);
  }

  private broadcastSpectatorState(room: GameRoomData): void {
    const state = this.getSpectatorViewForRoom(room);
    if (!state) return;

    // Add relay messages for the frontend (delayed per plugin setting)
    const delay = room.plugin.spectatorDelay ?? 0;
    const delayedProgress = Math.max(0, room.game.progressCounter - delay);
    const relayMessages = room.relay.getSpectatorMessages(delayedProgress);

    const extra = { gameType: room.gameType };
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

  createBotGame(teamSize: number = 4): { gameId: string; game: GameRoom<any, any, any, any> } {
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

    const relay = new GameRelay(players.map(p => ({ id: p.id, team: p.team })));

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
      botHandles,
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
   * Create a waiting room for FFA games (no lobby phases).
   * Players collect here before the game is created. When enough players join,
   * the waiting room promotes to a real game with game_start fired immediately.
   */
  createWaitingRoom(
    gameType: string,
    targetPlayers: number,
    initialPlayers: { id: string; handle: string }[],
  ): string {
    const roomId = crypto.randomUUID();

    const waitingRoom: WaitingRoom = {
      id: roomId,
      gameType,
      targetPlayers,
      players: [...initialPlayers],
      spectators: new Set(),
      createdAt: Date.now(),
    };

    this.waitingRooms.set(roomId, waitingRoom);

    for (const p of initialPlayers) {
      this.agentToWaitingRoom.set(p.id, roomId);
    }

    console.log(`[WaitingRoom] ${gameType} room ${roomId} created (${initialPlayers.length}/${targetPlayers} players)`);

    // Check if we already have enough players
    if (initialPlayers.length >= targetPlayers) {
      this.promoteWaitingRoom(roomId);
    }

    return roomId;
  }

  /**
   * Join a waiting room.
   */
  joinWaitingRoom(
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

    console.log(`[WaitingRoom] ${handle} (${agentId}) joined ${waitingRoom.gameType} room ${roomId} (${waitingRoom.players.length}/${waitingRoom.targetPlayers})`);

    // Check if we have enough players to start
    if (waitingRoom.players.length >= waitingRoom.targetPlayers) {
      const gameId = this.promoteWaitingRoom(roomId);
      return { success: true, gameStarted: true, gameId };
    }

    return { success: true };
  }

  /**
   * Promote a waiting room to a real game.
   * Creates the GameRoom, fires game_start, cleans up the waiting room.
   */
  private promoteWaitingRoom(roomId: string): string {
    const waitingRoom = this.waitingRooms.get(roomId)!;
    const { gameType, players } = waitingRoom;
    const gameId = roomId; // Reuse the ID so spectator WebSocket connections carry over

    const plugin = getGame(gameType);
    if (!plugin) throw new Error(`Cannot promote waiting room: unknown game type "${gameType}"`);

    const handleMap: Record<string, string> = {};
    for (const p of players) {
      handleMap[p.id] = p.handle;
      // Move agent mapping from waiting room to game
      this.agentToWaitingRoom.delete(p.id);
      this.agentToGame.set(p.id, gameId);
    }

    // Build game config — currently OATHBREAKER-specific but extensible
    // Future games can define their own config builder via the plugin
    let config: any;
    if (gameType === 'oathbreaker') {
      config = {
        ...DEFAULT_OATH_CONFIG,
        playerIds: players.map(p => p.id),
        seed: gameId,
      };
    } else {
      // Generic fallback — games with waiting rooms should define config needs
      config = {
        playerIds: players.map(p => p.id),
        seed: gameId,
      };
    }

    const game = GameRoom.create(plugin, config, gameId, players.map(p => p.id));
    const relay = new GameRelay(players.map(p => ({ id: p.id, team: 'FFA' })));

    const room: GameRoomData = {
      gameType,
      plugin,
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

    console.log(`[WaitingRoom] ${gameType} room ${roomId} promoted to game ${gameId} with ${players.length} players`);
    return gameId;
  }

  /**
   * Broadcast waiting room state to WebSocket spectators.
   */
  private broadcastWaitingRoomState(waitingRoom: WaitingRoom): void {
    const data = {
      type: 'state_update',
      data: {
        gameType: waitingRoom.gameType,
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

    // Final spectator broadcast (no delay — show the ending)
    const allRelayMessages = room.relay.getAllMessages();
    const finalCtx = { handles: room.handleMap, relayMessages: allRelayMessages };
    const spectatorView = room.game.getSpectatorView(0, finalCtx);
    if (spectatorView) {
      const extra = { gameType: room.gameType };
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

    // Generic ELO recording — uses computePayouts to determine winners/losers
    try {
      const playerIds = [...room.game.playerIds];
      if (playerIds.length >= 2) {
        const payouts = room.game.computePayouts(playerIds);
        const eloPlayers = playerIds.map(id => ({
          handle: room.handleMap[id] ?? getAgentName(id),
          payout: payouts.get(id) ?? 0,
        }));
        this.elo.recordGameResult(room.game.gameId, eloPlayers);
      }
    } catch (err) {
      console.error('[ELO] Failed to record match:', err);
    }

    console.log(`[Game] Game ${gameId} (${room.gameType}) finished.`);

    // Build game result with Merkle root for on-chain anchoring
    const playerIds = [...room.game.playerIds];
    if (playerIds.length > 0) {
      try {
        const result = buildGameResultFromRoom(room.game, gameId, room.gameType, playerIds);
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
      botHandles,
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
    this.wss.close();
    this.server.close();
    this.elo.close();
  }
}
