/**
 * Shared game server framework for the Coordination Games platform.
 *
 * Takes a game plugin + config, and provides:
 * - Game room management (create, lookup, remove)
 * - Action submission (delegated to GameRoom)
 * - Game result publishing (Merkle tree construction)
 *
 * The game plugin owns turns, phases, resolution, and visibility.
 * The framework is a dumb pipe: action -> state -> broadcast -> maybe set timer.
 */

import crypto from 'node:crypto';
import type {
  CoordinationGame,
  GameResult,
} from '../types.js';
import { GameRoom } from '../game-session.js';
import { buildActionMerkleTree, type MerkleLeafData } from '../merkle.js';
import { AuthManager, type AuthConfig } from './auth.js';
import { BalanceTracker, type BalanceConfig } from './balance.js';

// ---------------------------------------------------------------------------
// Game result & Merkle tree
// ---------------------------------------------------------------------------

/**
 * Build the game result for on-chain anchoring.
 * Call this after the game is finished.
 */
export function buildGameResult<TConfig, TState, TAction, TOutcome>(
  room: GameRoom<TConfig, TState, TAction, TOutcome>,
  playerIds: string[],
  config: TConfig,
): GameResult {
  if (!room.isOver()) {
    throw new Error('Cannot build result for an unfinished game');
  }

  const outcome = room.getOutcome();

  // Build Merkle tree from action log
  const leaves: MerkleLeafData[] = room.actionLog.map((entry, idx) => ({
    actionIndex: idx,
    playerId: entry.playerId,
    actionData: JSON.stringify(entry.action),
    stateHash: entry.stateHash,
  }));
  const merkleTree = buildActionMerkleTree(leaves);

  // Compute config hash
  const configHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex');

  return {
    gameId: room.gameId,
    gameType: room.gamePlugin.gameType,
    players: playerIds,
    outcome,
    movesRoot: merkleTree.root,
    configHash,
    turnCount: room.actionLog.length,
    timestamp: Date.now(),
  };
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

  constructor(config: {
    games?: Map<string, CoordinationGame<any, any, any, any>>;
    authConfig?: AuthConfig;
    balanceConfig?: BalanceConfig;
  } = {}) {
    this.games = config.games ?? new Map();
    this.auth = new AuthManager(config.authConfig);
    this.balance = new BalanceTracker(config.balanceConfig);
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
  createRoom<TConfig, TState, TAction, TOutcome>(
    gameType: string,
    config: TConfig,
  ): GameRoom<TConfig, TState, TAction, TOutcome> {
    const plugin = this.games.get(gameType);
    if (!plugin) {
      throw new Error(`Unknown game type: ${gameType}`);
    }

    const gameId = `game_${crypto.randomBytes(8).toString('hex')}`;
    const room = GameRoom.create(plugin, config, gameId);
    this.rooms.set(gameId, room);
    return room as GameRoom<TConfig, TState, TAction, TOutcome>;
  }

  /**
   * Get a game room by ID.
   */
  getRoom(roomId: string): GameRoom<any, any, any, any> | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Submit an action to a game room.
   */
  async submitAction(
    roomId: string,
    playerId: string | null,
    action: any,
  ): Promise<{ success: boolean; error?: string }> {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: `Room ${roomId} not found` };
    }
    return room.handleAction(playerId, action);
  }

  /**
   * Finish a game and compute results + payouts.
   */
  finishGame(roomId: string, playerIds: string[], config: any): {
    result: GameResult;
    payouts: Map<string, number>;
  } | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.isOver()) return null;

    const result = buildGameResult(room, playerIds, config);
    const payouts = room.computePayouts(playerIds);

    // Settle balances
    this.balance.settle(payouts, room.gamePlugin.entryCost);

    return { result, payouts };
  }

  /**
   * Remove a game room (cleanup).
   */
  removeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.cancelTimer();
    }
    this.rooms.delete(roomId);
  }

  /**
   * Get all active (non-finished) game rooms.
   */
  getActiveRooms(): GameRoom<any, any, any, any>[] {
    return [...this.rooms.values()].filter(
      (r) => !r.isOver(),
    );
  }
}
