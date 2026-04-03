/**
 * Server-side balance tracking for the coordination games framework.
 *
 * Tracks "effective available balance" for each player:
 *   available = onChainBalance - committedToActiveGames - pendingBurns
 *
 * This is a simple in-memory tracker. The server knows active games
 * (it runs lobbies) and can read pendingBurns from the contract.
 *
 * During the transition period (before on-chain credits are live),
 * all players start with a default balance and the tracker operates
 * purely in-memory.
 */

import type { PlayerBalance } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BalanceConfig {
  /** Default starting balance for new players (dev/testing mode) */
  defaultBalance?: number;
  /**
   * Optional function to read on-chain balance for an agentId.
   * If not provided, the tracker uses in-memory balances only.
   */
  readOnChainBalance?: (playerId: string) => Promise<number>;
  /**
   * Optional function to read pending burn amount for an agentId.
   * If not provided, pendingBurns defaults to 0.
   */
  readPendingBurns?: (playerId: string) => Promise<number>;
}

// ---------------------------------------------------------------------------
// Balance tracker
// ---------------------------------------------------------------------------

export class BalanceTracker {
  /** In-memory balances (used when no on-chain reader is configured) */
  private balances: Map<string, number> = new Map();
  /** Credits committed to active games */
  private committed: Map<string, number> = new Map();
  private config: BalanceConfig;

  constructor(config?: BalanceConfig) {
    this.config = config ?? {};
  }

  /**
   * Get the full balance breakdown for a player.
   */
  async getBalance(playerId: string): Promise<PlayerBalance> {
    const onChainBalance = await this.getOnChainBalance(playerId);
    const committedAmount = this.committed.get(playerId) ?? 0;
    const pendingBurns = await this.getPendingBurns(playerId);
    const available = Math.max(0, onChainBalance - committedAmount - pendingBurns);

    return {
      playerId,
      onChainBalance,
      committed: committedAmount,
      pendingBurns,
      available,
    };
  }

  /**
   * Check if a player can afford to join a game.
   */
  async canAfford(playerId: string, amount: number): Promise<boolean> {
    const balance = await this.getBalance(playerId);
    return balance.available >= amount;
  }

  /**
   * Commit credits for a player joining a game.
   * Returns false if insufficient balance.
   */
  async commit(playerId: string, amount: number): Promise<boolean> {
    const affordable = await this.canAfford(playerId, amount);
    if (!affordable) return false;

    const current = this.committed.get(playerId) ?? 0;
    this.committed.set(playerId, current + amount);
    return true;
  }

  /**
   * Release committed credits (game cancelled, player left lobby).
   */
  release(playerId: string, amount: number): void {
    const current = this.committed.get(playerId) ?? 0;
    this.committed.set(playerId, Math.max(0, current - amount));
  }

  /**
   * Settle a completed game. Applies deltas and releases commitments.
   *
   * @param deltas - Map of playerId -> credit delta (positive = won, negative = lost)
   * @param entryPerPlayer - The entry cost that was committed per player
   */
  settle(deltas: Map<string, number>, entryPerPlayer: number): void {
    for (const [playerId, delta] of deltas) {
      // Release the committed amount
      this.release(playerId, entryPerPlayer);

      // Apply the delta to in-memory balance (if using in-memory mode)
      if (!this.config.readOnChainBalance) {
        const current = this.balances.get(playerId) ?? this.getDefaultBalance();
        this.balances.set(playerId, current + delta);
      }
    }
  }

  /**
   * Initialize a player's balance (for dev/testing mode).
   */
  initBalance(playerId: string, amount?: number): void {
    this.balances.set(playerId, amount ?? this.getDefaultBalance());
  }

  /**
   * Set a player's in-memory balance directly (for testing).
   */
  setBalance(playerId: string, amount: number): void {
    this.balances.set(playerId, amount);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async getOnChainBalance(playerId: string): Promise<number> {
    if (this.config.readOnChainBalance) {
      return this.config.readOnChainBalance(playerId);
    }
    // In-memory mode: return stored balance or default
    if (!this.balances.has(playerId)) {
      this.balances.set(playerId, this.getDefaultBalance());
    }
    return this.balances.get(playerId)!;
  }

  private async getPendingBurns(playerId: string): Promise<number> {
    if (this.config.readPendingBurns) {
      return this.config.readPendingBurns(playerId);
    }
    return 0;
  }

  private getDefaultBalance(): number {
    return this.config.defaultBalance ?? 1000;
  }
}
