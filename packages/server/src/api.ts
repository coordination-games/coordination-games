import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';

import {
  GameManager,
  GamePhase,
  GameUnit,
  FlagState,
  TeamMessage,
  TurnRecord,
  UnitClass,
  ALL_DIRECTIONS,
  Direction,
  Hex,
  generateMap,
  TileType,
  GameMap,
  getUnitVision,
  hexToString,
  CLASS_VISION,
} from '@lobster/engine';
import { EloTracker } from './elo.js';
import { runAllBotsTurn } from './claude-bot.js';

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
  chatA: TeamMessage[];
  chatB: TeamMessage[];
  flagA: { status: 'at_base' | 'carried'; carrier?: string };
  flagB: { status: 'at_base' | 'carried'; carrier?: string };
  score: { A: number; B: number };
  mapRadius: number;
  visibleA: string[];  // hex keys visible to team A
  visibleB: string[];  // hex keys visible to team B
}

export interface GameRoom {
  game: GameManager;
  spectators: Set<WebSocket>;
  stateHistory: SpectatorState[];   // indexed by turn
  spectatorDelay: number;           // turns of delay (default 5)
  turnTimer: ReturnType<typeof setInterval> | null;
  botHandles: string[];             // handles of bot players in this room
  botMeta: { id: string; unitClass: UnitClass; team: 'A' | 'B' }[];
  finished: boolean;
  useClaudeBots: boolean;
  turnInProgress: boolean;
}

// ---------------------------------------------------------------------------
// Spectator state builder
// ---------------------------------------------------------------------------

function buildSpectatorState(game: GameManager): SpectatorState {
  const { map, units, flags, turn, phase, config, score } = game;

  // Build full tile array (no fog — spectators see everything)
  const tiles: SpectatorTile[] = [];
  const unitsByHex = new Map<string, GameUnit>();
  for (const u of units) {
    if (u.alive) {
      unitsByHex.set(`${u.position.q},${u.position.r}`, u);
    }
  }

  const flagsByHex = new Map<string, 'A' | 'B'>();
  for (const team of ['A', 'B'] as const) {
    const f = flags[team];
    flagsByHex.set(`${f.position.q},${f.position.r}`, team);
  }

  for (const [key, tileType] of map.tiles) {
    const [qStr, rStr] = key.split(',');
    const q = Number(qStr);
    const r = Number(rStr);
    const tile: SpectatorTile = { q, r, type: tileType };

    const unitHere = unitsByHex.get(key);
    if (unitHere) {
      tile.unit = {
        id: unitHere.id,
        team: unitHere.team,
        unitClass: unitHere.unitClass,
        carryingFlag: unitHere.carryingFlag || undefined,
        alive: unitHere.alive,
      };
    }

    const flagTeam = flagsByHex.get(key);
    if (flagTeam !== undefined) {
      tile.flag = { team: flagTeam };
    }

    tiles.push(tile);
  }

  // Kills from most recent turn
  const history = game.getTurnHistory();
  const lastRecord = history.length > 0 ? history[history.length - 1] : null;
  const kills = lastRecord?.kills ?? [];

  // Build flag status summaries
  function flagStatus(f: FlagState): { status: 'at_base' | 'carried'; carrier?: string } {
    if (f.carried && f.carrierId) {
      return { status: 'carried', carrier: f.carrierId };
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
  for (const u of units) {
    if (!u.alive) continue;
    const unitVision = getUnitVision(
      { id: u.id, position: u.position, unitClass: u.unitClass, team: u.team, alive: u.alive } as any,
      walls,
      allHexKeys,
    );
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
    chatA: game.teamMessages.A,
    chatB: game.teamMessages.B,
    flagA: flagStatus(flags.A),
    flagB: flagStatus(flags.B),
    score: { A: score.A, B: score.B },
    mapRadius: map.radius,
    visibleA: [...visibleA],
    visibleB: [...visibleB],
  };
}

// ---------------------------------------------------------------------------
// Helper: delayed state for spectators
// ---------------------------------------------------------------------------

function getDelayedState(room: GameRoom): SpectatorState | null {
  const delayedTurn = room.game.turn - room.spectatorDelay;
  const idx = Math.max(0, delayedTurn);
  if (room.stateHistory.length === 0) return null;
  if (idx >= room.stateHistory.length) {
    return room.stateHistory[room.stateHistory.length - 1];
  }
  return room.stateHistory[idx];
}

// ---------------------------------------------------------------------------
// GameServer
// ---------------------------------------------------------------------------

export class GameServer {
  private app: any;
  private server: http.Server;
  private wss: WebSocketServer;
  readonly elo: EloTracker;
  private useClaudeBots: boolean = false;

  readonly games: Map<string, GameRoom> = new Map();

  constructor(port?: number) {
    this.app = express();
    this.app.use(express.json());

    // Serve static frontend if built
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const webDistPath = path.resolve(__dirname, '../../web/dist');
    this.app.use(express.static(webDistPath));

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ noServer: true });
    this.elo = new EloTracker();

    // Enable Claude Agent SDK bots (uses local credentials from ~/.claude)
    this.useClaudeBots = process.env.USE_CLAUDE_BOTS !== 'false';
    console.log(this.useClaudeBots
      ? 'Claude Agent SDK bots enabled (haiku) — using local credentials'
      : 'Claude bots disabled — using heuristic bots');

    this.setupRoutes();
    this.setupWebSocket();
  }

  // ---------------------------------------------------------------------------
  // REST routes
  // ---------------------------------------------------------------------------

  private setupRoutes(): void {
    const router = express.Router();

    // List active lobbies (stub — lobby system not yet implemented)
    router.get('/lobbies', (_req, res) => {
      res.json([]);
    });

    // List active games
    router.get('/games', (_req, res) => {
      const list = Array.from(this.games.entries()).map(([id, room]) => ({
        id,
        turn: room.game.turn,
        phase: room.game.phase,
        teams: {
          A: room.game.units.filter((u) => u.team === 'A').map((u) => u.id),
          B: room.game.units.filter((u) => u.team === 'B').map((u) => u.id),
        },
        spectators: room.spectators.size,
      }));
      res.json(list);
    });

    // Game details
    router.get('/games/:id', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const state = getDelayedState(room);
      if (!state) return res.status(200).json({ phase: 'pre_game' });
      res.json(state);
    });

    // Current spectator state (delayed)
    router.get('/games/:id/state', (req, res) => {
      const room = this.games.get(req.params.id);
      if (!room) return res.status(404).json({ error: 'Game not found' });

      const state = getDelayedState(room);
      if (!state) return res.status(200).json({ phase: 'pre_game' });
      res.json(state);
    });

    // Create a bot game
    router.post('/games/start', (req, res) => {
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

      if (room.game.phase !== 'finished') {
        return res.status(400).json({ error: 'Game is still in progress' });
      }

      res.json({
        gameId: room.game.gameId,
        turns: room.stateHistory,
        winner: room.game.winner,
        score: room.game.score,
        mapRadius: room.game.map.radius,
      });
    });

    this.app.use('/api', router);

    // SPA catch-all: serve index.html for any non-API route
    const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
    const indexPath = path.resolve(__dirname2, '../../web/dist/index.html');
    this.app.get('*', (_req: any, res: any) => {
      res.sendFile(indexPath);
    });
  }

  // ---------------------------------------------------------------------------
  // WebSocket upgrade handling
  // ---------------------------------------------------------------------------

  private setupWebSocket(): void {
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`);
      const match = url.pathname.match(/^\/ws\/game\/(.+)$/);

      if (!match) {
        socket.destroy();
        return;
      }

      const gameId = match[1];
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
    });
  }

  // ---------------------------------------------------------------------------
  // Broadcast to spectators
  // ---------------------------------------------------------------------------

  private broadcastState(room: GameRoom): void {
    const state = getDelayedState(room);
    if (!state) return;

    const msg = JSON.stringify({ type: 'state_update', data: state });
    for (const ws of room.spectators) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Create a bot game
  // ---------------------------------------------------------------------------

  createBotGame(teamSize: number = 4): { gameId: string; game: GameManager } {
    const gameId = crypto.randomUUID();
    const classes: UnitClass[] = ['rogue', 'knight', 'mage'];

    const players: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[] = [];
    const botHandles: string[] = [];

    for (let i = 0; i < teamSize; i++) {
      const handleA = `bot_${i * 2 + 1}`;
      const handleB = `bot_${i * 2 + 2}`;
      botHandles.push(handleA, handleB);

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

    const gameMap = generateMap({ radius: 5 });
    const game = new GameManager(gameId, gameMap, players);

    // Take initial snapshot
    const initialState = buildSpectatorState(game);

    const room: GameRoom = {
      game,
      spectators: new Set(),
      stateHistory: [initialState],
      spectatorDelay: 0,  // No delay for beta testing
      turnTimer: null,
      botHandles,
      botMeta: players,
      finished: false,
      useClaudeBots: this.useClaudeBots,
      turnInProgress: false,
    };

    this.games.set(gameId, room);

    // Start the auto-play turn loop
    // Claude bots need more time per turn (API calls), heuristic bots are instant
    const turnInterval = room.useClaudeBots ? 8000 : 2000;
    room.turnTimer = setInterval(() => {
      this.runTurnLoop(gameId).catch((err) => {
        console.error(`Turn loop error for ${gameId}:`, err);
      });
    }, turnInterval);

    return { gameId, game };
  }

  // ---------------------------------------------------------------------------
  // Turn loop — submit random bot moves, resolve, broadcast
  // ---------------------------------------------------------------------------

  async runTurnLoop(gameId: string): Promise<void> {
    const room = this.games.get(gameId);
    if (!room || room.finished || room.turnInProgress) return;
    room.turnInProgress = true;

    const { game, botHandles } = room;

    if (game.isGameOver()) {
      // Clean up
      if (room.turnTimer) clearInterval(room.turnTimer);
      room.turnTimer = null;
      room.finished = true;
      room.turnInProgress = false;

      // Final broadcast with no delay so spectators see the result
      const finalState = buildSpectatorState(game);
      room.stateHistory.push(finalState);
      const msg = JSON.stringify({ type: 'game_over', data: finalState });
      for (const ws of room.spectators) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }
      return;
    }

    if (room.useClaudeBots) {
      // Claude Agent SDK bots — each bot runs haiku with game MCP tools
      await runAllBotsTurn(game, room.botMeta, game.turn);
    } else {
      // Fallback: random bot moves
      for (const botId of botHandles) {
        const unit = game.units.find((u) => u.id === botId);
        if (!unit || !unit.alive) continue;
        const randomDir = ALL_DIRECTIONS[Math.floor(Math.random() * ALL_DIRECTIONS.length)];
        game.submitMove(botId, [randomDir]);
      }
    }

    // Resolve the turn
    game.resolveTurn();

    // Snapshot current state
    const state = buildSpectatorState(game);
    room.stateHistory.push(state);

    // Broadcast delayed state to spectators
    this.broadcastState(room);
    room.turnInProgress = false;
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
      if (room.turnTimer) clearInterval(room.turnTimer);
      for (const ws of room.spectators) ws.close();
    }
    this.wss.close();
    this.server.close();
    this.elo.close();
  }
}
