/**
 * Player identity — read-through cache.
 *
 * Chain is source of truth for identity (handle, chain_agent_id, wallet).
 * D1 owns game stats (elo, wins, games_played).
 * resolvePlayer() is the ONLY way to create/lookup player rows.
 */

import type { ChainRelay } from '../chain/types.js';

export interface Player {
  id: string;
  handle: string;
  walletAddress: string;
  chainAgentId: number | null;
  elo: number;
  gamesPlayed: number;
  wins: number;
  createdAt: string;
}

export class PlayerHandleTakenError extends Error {
  constructor(handle: string) {
    super(`Handle "${handle}" is already taken`);
    this.name = 'PlayerHandleTakenError';
  }
}

// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
export function rowToPlayer(row: any): Player {
  return {
    id: row.id,
    handle: row.handle,
    walletAddress: row.wallet_address,
    chainAgentId: row.chain_agent_id ?? null,
    elo: row.elo,
    gamesPlayed: row.games_played,
    wins: row.wins,
    createdAt: row.created_at,
  };
}

/**
 * Resolve a player by wallet address. Single gateway for player row creation.
 *
 * 1. Check D1 (cache hit) — return existing row, sync handle if hint differs.
 * 2. Cache miss — ask chain via relay.getAgentByAddress().
 * 3. Create D1 row from chain data or hint.
 *
 * @param hint.handle - Caller-provided name (from auth verify body or register params).
 *   Used to update handle on cache hit, or as fallback name on cache miss when chain has no data.
 */
export async function resolvePlayer(
  address: string,
  relay: ChainRelay,
  db: D1Database,
  hint?: { handle?: string; chainAgentId?: number },
): Promise<{ player: Player; created: boolean }> {
  const addressLower = address.toLowerCase();

  // 1. Check D1 cache
  const row = await db
    .prepare('SELECT * FROM players WHERE wallet_address = ? COLLATE NOCASE')
    .bind(addressLower)
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    .first<any>();

  if (row) {
    const player = rowToPlayer(row);

    // Sync handle if caller provides a different one
    if (hint?.handle && hint.handle !== player.handle) {
      try {
        await db
          .prepare('UPDATE players SET handle = ? WHERE id = ?')
          .bind(hint.handle, player.id)
          .run();
        player.handle = hint.handle;
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      } catch (err: any) {
        if (err.message?.includes('UNIQUE')) throw new PlayerHandleTakenError(hint.handle);
        throw err;
      }
    }

    // Backfill chain_agent_id if we have it now but didn't before
    if (hint?.chainAgentId && !player.chainAgentId) {
      await db
        .prepare('UPDATE players SET chain_agent_id = ? WHERE id = ?')
        .bind(hint.chainAgentId, player.id)
        .run();
      player.chainAgentId = hint.chainAgentId;
    }

    return { player, created: false };
  }

  // 2. Cache miss — try chain
  const chainInfo = await relay.getAgentByAddress(addressLower);

  const handle = chainInfo?.name ?? hint?.handle;
  if (!handle) {
    throw new Error(`Cannot create player for ${address}: no name from chain or caller`);
  }

  const chainAgentId =
    hint?.chainAgentId ?? (chainInfo?.registered ? Number(chainInfo.agentId) : null);

  // 3. Create D1 row
  const playerId = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await db
      .prepare(
        'INSERT INTO players (id, wallet_address, handle, chain_agent_id, elo, games_played, wins, created_at) VALUES (?, ?, ?, ?, 1000, 0, 0, ?)',
      )
      .bind(playerId, addressLower, handle, chainAgentId, now)
      .run();
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  } catch (err: any) {
    if (err.message?.includes('UNIQUE')) {
      // Race condition: another request created the row — retry lookup
      const retryRow = await db
        .prepare('SELECT * FROM players WHERE wallet_address = ? COLLATE NOCASE')
        .bind(addressLower)
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
        .first<any>();
      if (retryRow) return { player: rowToPlayer(retryRow), created: false };
      // If still not found, the UNIQUE was on handle, not wallet_address
      throw new PlayerHandleTakenError(handle);
    }
    throw err;
  }

  const player: Player = {
    id: playerId,
    handle,
    walletAddress: addressLower,
    chainAgentId,
    elo: 1000,
    gamesPlayed: 0,
    wins: 0,
    createdAt: now,
  };

  return { player, created: true };
}
