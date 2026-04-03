/**
 * Shared game server framework for the Coordination Games platform.
 *
 * Takes a game plugin + config, and provides:
 * - Lobby management (create, join, team formation)
 * - Turn resolution (collect moves, validate, resolve)
 * - Spectator WebSocket feed
 * - Game result publishing (Merkle tree construction)
 *
 * This framework is designed to coexist with the existing CtL server.
 * Game-specific servers can extend or compose with this framework
 * rather than being fully replaced by it.
 */

import crypto from 'node:crypto';
import type {
  CoordinationGame,
  SignedMove,
  TurnData,
  GameResult,
  GameRoomPhase,
  LobbyPlayer,
  ChatMessage,
  FrameworkConfig,
} from '../types.js';
import { buildGameMerkleTree, type MerkleLeafData } from '../merkle.js';
import { AuthManager, type AuthConfig } from './auth.js';
import { BalanceTracker, type BalanceConfig } from './balance.js';

// ---------------------------------------------------------------------------
// Game room — manages a single game instance
// ---------------------------------------------------------------------------

export interface GameRoom<TConfig, TState, TMove, TOutcome> {
  readonly roomId: string;
  readonly gameId: string;
  readonly plugin: CoordinationGame<TConfig, TState, TMove, TOutcome>;
  readonly config: TConfig;
  readonly playerIds: string[];

  state: TState;
  phase: GameRoomPhase;
  turn: number;
  turnHistory: TurnData<TMove>[];
  currentMoves: Map<string, SignedMove<TMove>>;
  turnTimer: ReturnType<typeof setTimeout> | null;
  turnStartedAt: number;
  turnTimeoutMs: number;
  turnResolveCallback: (() => void) | null;
}

/**
 * Create a new game room with an initialized game state.
 */
export function createGameRoom<TConfig, TState, TMove, TOutcome>(
  plugin: CoordinationGame<TConfig, TState, TMove, TOutcome>,
  config: TConfig,
  playerIds: string[],
  options?: { turnTimeoutMs?: number },
): GameRoom<TConfig, TState, TMove, TOutcome> {
  const gameId = `game_${crypto.randomBytes(8).toString('hex')}`;
  const state = plugin.createInitialState(config);

  return {
    roomId: gameId,
    gameId,
    plugin,
    config,
    playerIds,
    state,
    phase: 'in_progress',
    turn: 1,
    turnHistory: [],
    currentMoves: new Map(),
    turnTimer: null,
    turnStartedAt: Date.now(),
    turnTimeoutMs: options?.turnTimeoutMs ?? 30000,
    turnResolveCallback: null,
  };
}

// ---------------------------------------------------------------------------
// Move collection and turn resolution
// ---------------------------------------------------------------------------

/**
 * Submit a move for a player in a game room.
 * Validates the move against the plugin, then stores it.
 */
export function submitMove<TConfig, TState, TMove, TOutcome>(
  room: GameRoom<TConfig, TState, TMove, TOutcome>,
  playerId: string,
  move: TMove,
  signature?: string,
): { success: boolean; error?: string } {
  if (room.phase !== 'in_progress') {
    return { success: false, error: 'Game is not in progress' };
  }

  if (!room.playerIds.includes(playerId)) {
    return { success: false, error: `Player ${playerId} is not in this game` };
  }

  // Validate the move using the plugin
  const valid = room.plugin.validateMove(room.state, playerId, move);
  if (!valid) {
    return { success: false, error: 'Invalid move' };
  }

  // Store the signed move
  const signedMove: SignedMove<TMove> = {
    playerId,
    move,
    signature,
    turnNumber: room.turn,
    gameId: room.gameId,
  };
  room.currentMoves.set(playerId, signedMove);

  // Check if all moves are in — trigger early resolution
  if (room.currentMoves.size >= room.playerIds.length) {
    if (room.turnResolveCallback) {
      room.turnResolveCallback();
    }
  }

  return { success: true };
}

/**
 * Check if all players have submitted moves for the current turn.
 */
export function allMovesSubmitted<TConfig, TState, TMove, TOutcome>(
  room: GameRoom<TConfig, TState, TMove, TOutcome>,
): boolean {
  return room.currentMoves.size >= room.playerIds.length;
}

/**
 * Resolve the current turn. Collects all submitted moves,
 * invokes the plugin's resolveTurn, records turn data,
 * and advances to the next turn.
 */
export function resolveTurn<TConfig, TState, TMove, TOutcome>(
  room: GameRoom<TConfig, TState, TMove, TOutcome>,
): TurnData<TMove> {
  // Build moves map for the plugin
  const movesMap = new Map<string, TMove>();
  const signedMoves: SignedMove<TMove>[] = [];

  for (const [playerId, signedMove] of room.currentMoves) {
    movesMap.set(playerId, signedMove.move);
    signedMoves.push(signedMove);
  }

  // Resolve the turn using the plugin
  const newState = room.plugin.resolveTurn(room.state, movesMap);

  // Compute state hash for the turn record
  const stateHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(newState))
    .digest('hex');

  // Record turn data
  const turnData: TurnData<TMove> = {
    turnNumber: room.turn,
    moves: signedMoves,
    stateHash,
  };
  room.turnHistory.push(turnData);

  // Update room state
  room.state = newState;
  room.currentMoves.clear();
  room.turn++;
  room.turnStartedAt = Date.now();

  // Check if game is over
  if (room.plugin.isOver(room.state)) {
    room.phase = 'finished';
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  return turnData;
}

// ---------------------------------------------------------------------------
// Game result & Merkle tree
// ---------------------------------------------------------------------------

/**
 * Build the game result for on-chain anchoring.
 * Call this after the game is finished.
 */
export function buildGameResult<TConfig, TState, TMove, TOutcome>(
  room: GameRoom<TConfig, TState, TMove, TOutcome>,
): GameResult {
  if (room.phase !== 'finished') {
    throw new Error('Cannot build result for an unfinished game');
  }

  const outcome = room.plugin.getOutcome(room.state);

  // Build Merkle tree from turn history
  const merkleInput = room.turnHistory.map((turn) => ({
    turnNumber: turn.turnNumber,
    moves: turn.moves.map((m) => ({
      turnNumber: m.turnNumber,
      playerId: m.playerId,
      moveData: JSON.stringify(m.move),
      signature: m.signature,
    } as MerkleLeafData)),
  }));
  const merkleTree = buildGameMerkleTree(merkleInput);

  // Compute config hash
  const configHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(room.config))
    .digest('hex');

  return {
    gameId: room.gameId,
    gameType: room.plugin.gameType,
    players: room.playerIds,
    outcome,
    movesRoot: merkleTree.root,
    configHash,
    turnCount: room.turnHistory.length,
    timestamp: Date.now(),
  };
}

/**
 * Compute payouts for a finished game.
 */
export function computePayouts<TConfig, TState, TMove, TOutcome>(
  room: GameRoom<TConfig, TState, TMove, TOutcome>,
): Map<string, number> {
  if (room.phase !== 'finished') {
    throw new Error('Cannot compute payouts for an unfinished game');
  }

  const outcome = room.plugin.getOutcome(room.state);
  return room.plugin.computePayouts(outcome, room.playerIds);
}

// ---------------------------------------------------------------------------
// GameFramework — the main orchestrator
// ---------------------------------------------------------------------------

/**
 * The main game framework that manages multiple game rooms.
 * Game-specific servers can compose with this or extend it.
 */
export class GameFramework {
  readonly auth: AuthManager;
  readonly balance: BalanceTracker;
  private games: Map<string, CoordinationGame<any, any, any, any>>;
  private rooms: Map<string, GameRoom<any, any, any, any>> = new Map();
  private turnTimeoutMs: number;

  constructor(config: {
    games?: Map<string, CoordinationGame<any, any, any, any>>;
    authConfig?: AuthConfig;
    balanceConfig?: BalanceConfig;
    turnTimeoutMs?: number;
  } = {}) {
    this.games = config.games ?? new Map();
    this.auth = new AuthManager(config.authConfig);
    this.balance = new BalanceTracker(config.balanceConfig);
    this.turnTimeoutMs = config.turnTimeoutMs ?? 30000;
  }

  /**
   * Register a game plugin.
   */
  registerGame(plugin: CoordinationGame<any, any, any, any>): void {
    this.games.set(plugin.gameType, plugin);
  }

  /**
   * Get a registered game plugin by type.
   */
  getGame(gameType: string): CoordinationGame<any, any, any, any> | undefined {
    return this.games.get(gameType);
  }

  /**
   * List all registered game types.
   */
  listGameTypes(): string[] {
    return [...this.games.keys()];
  }

  /**
   * Create a new game room.
   */
  createRoom<TConfig, TState, TMove, TOutcome>(
    gameType: string,
    config: TConfig,
    playerIds: string[],
  ): GameRoom<TConfig, TState, TMove, TOutcome> {
    const plugin = this.games.get(gameType);
    if (!plugin) {
      throw new Error(`Unknown game type: ${gameType}`);
    }

    const room = createGameRoom(plugin, config, playerIds, {
      turnTimeoutMs: this.turnTimeoutMs,
    });
    this.rooms.set(room.roomId, room);
    return room as GameRoom<TConfig, TState, TMove, TOutcome>;
  }

  /**
   * Get a game room by ID.
   */
  getRoom(roomId: string): GameRoom<any, any, any, any> | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Submit a move to a game room.
   */
  submitMove(
    roomId: string,
    playerId: string,
    move: any,
    signature?: string,
  ): { success: boolean; error?: string } {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: `Room ${roomId} not found` };
    }
    return submitMove(room, playerId, move, signature);
  }

  /**
   * Resolve the current turn in a game room.
   */
  resolveTurn(roomId: string): TurnData<any> | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return resolveTurn(room);
  }

  /**
   * Finish a game and compute results + payouts.
   */
  finishGame(roomId: string): {
    result: GameResult;
    payouts: Map<string, number>;
  } | null {
    const room = this.rooms.get(roomId);
    if (!room || room.phase !== 'finished') return null;

    const result = buildGameResult(room);
    const payouts = computePayouts(room);

    // Settle balances
    this.balance.settle(payouts, room.plugin.entryCost);

    // Mark as settled
    room.phase = 'settled';

    return { result, payouts };
  }

  /**
   * Remove a game room (cleanup).
   */
  removeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room?.turnTimer) {
      clearTimeout(room.turnTimer);
    }
    this.rooms.delete(roomId);
  }

  /**
   * Get all active game rooms.
   */
  getActiveRooms(): GameRoom<any, any, any, any>[] {
    return [...this.rooms.values()].filter(
      (r) => r.phase === 'in_progress',
    );
  }
}
