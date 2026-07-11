import type { D1Database } from '@cloudflare/workers-types';
import {
  type FakeStatement,
  type LadderFakeStore,
  ownsVersionedClaim,
  runFakeBatch,
} from './ladder-d1-fake-types.js';

export type {
  FakeAuditRow,
  FakeRatingRow,
  FakeResultRow,
  FakeVersionRow,
  LadderFakeStore,
} from './ladder-d1-fake-types.js';

export function makeLadderFakeD1(store: LadderFakeStore): D1Database {
  let barrierReadsRemaining = store.beforeRatingRead ? 2 : 0;
  const execute = (sql: string, bindings: readonly unknown[]): unknown => {
    const read = sql.trimStart().startsWith('SELECT');
    if (read && sql.includes('FROM plugin_elo_ladder_versions')) {
      return store.versions.find((row) => row.game_type === bindings[0]) ?? null;
    }
    if (
      read &&
      sql.includes('FROM plugin_elo_replay_results') &&
      sql.includes('WHERE game_id = ?')
    ) {
      return store.results.find((row) => row.game_id === bindings[0]) ?? null;
    }
    if (
      read &&
      sql.includes('FROM plugin_elo_replay_players') &&
      sql.includes('WHERE game_id = ?')
    ) {
      return store.audit
        .filter((row) => row.game_id === bindings[0])
        .sort((left, right) => left.player_id.localeCompare(right.player_id));
    }
    if (read && sql.includes('FROM plugin_elo_game_ratings') && sql.includes('player_id IN')) {
      const gameType = bindings[0];
      const playerIds = new Set(bindings.slice(1));
      return store.ratings.filter(
        (row) => row.game_type === gameType && playerIds.has(row.player_id),
      );
    }
    if (read && sql.includes('FROM players') && sql.includes('id IN')) {
      const playerIds = new Set(bindings);
      return store.players.filter((row) => playerIds.has(row.id));
    }
    if (sql.includes('FROM plugin_elo_game_ratings gr') && sql.includes('gr.player_id = ?')) {
      const [gameType, playerId] = bindings;
      const rating = store.ratings.find(
        (row) => row.game_type === gameType && row.player_id === playerId,
      );
      if (!rating) return null;
      return {
        player_id: rating.player_id,
        handle:
          store.players.find((player) => player.id === rating.player_id)?.handle ??
          rating.player_id,
        rating: rating.rating,
        games_played: rating.games_played,
      };
    }
    if (read && sql.includes('FROM plugin_elo_replay_results rr')) {
      const [gameType, playerId, limit] = bindings;
      return store.audit
        .filter((row) => row.player_id === playerId)
        .map((row) => ({
          ...row,
          result: store.results.find((result) => result.game_id === row.game_id),
        }))
        .filter((row) => row.result?.game_type === gameType)
        .sort((left, right) => right.game_id.localeCompare(left.game_id))
        .slice(0, Number(limit))
        .map((row) => ({
          game_id: row.game_id,
          rank: row.rank,
          rating_before: row.rating_before,
          rating_after: row.rating_after,
          delta: row.delta,
          recorded_at: row.result?.recorded_at,
        }));
    }
    if (sql.includes('FROM plugin_elo_game_ratings gr')) {
      const [gameType, limit, offset] = bindings;
      return store.ratings
        .filter((row) => row.game_type === gameType)
        .map((row) => ({
          player_id: row.player_id,
          handle:
            store.players.find((player) => player.id === row.player_id)?.handle ?? row.player_id,
          rating: row.rating,
          games_played: row.games_played,
        }))
        .sort(
          (left, right) =>
            right.rating - left.rating ||
            right.games_played - left.games_played ||
            left.player_id.localeCompare(right.player_id),
        )
        .slice(Number(offset), Number(offset) + Number(limit));
    }
    if (sql.includes('INSERT OR IGNORE INTO plugin_elo_replay_results')) {
      if (!store.results.some((row) => row.game_id === bindings[0])) {
        store.results.push({
          game_id: String(bindings[0]),
          game_type: String(bindings[1]),
          replay_hash: String(bindings[2]),
          result_hash: String(bindings[3]),
          claim_token: String(bindings[4]),
          recorded_at: String(bindings[5]),
          version_guard: 1,
        });
      }
      return { success: true };
    }
    if (sql.includes('INSERT INTO plugin_elo_ladder_versions')) {
      const [gameType, nextVersion, writeToken, updatedAt, gameId, claimToken, expectedVersion] =
        bindings;
      const ownsResult = store.results.some(
        (row) => row.game_id === gameId && row.claim_token === claimToken,
      );
      const existing = store.versions.find((row) => row.game_type === gameType);
      if (ownsResult && !store.forceStaleVersion) {
        if (existing && existing.version === expectedVersion) {
          existing.version = Number(nextVersion);
          existing.write_token = String(writeToken);
          existing.updated_at = String(updatedAt);
        } else if (!existing && expectedVersion === 0) {
          store.versions.push({
            game_type: String(gameType),
            version: Number(nextVersion),
            write_token: String(writeToken),
            updated_at: String(updatedAt),
          });
        }
      }
      return { success: true };
    }
    if (sql.includes('INSERT INTO plugin_elo_replay_players')) {
      const [
        gameId,
        playerId,
        rank,
        before,
        after,
        delta,
        checkGameId,
        claimToken,
        version,
        token,
      ] = bindings;
      if (
        ownsVersionedClaim(store, { gameId: checkGameId, claimToken, version, writeToken: token })
      ) {
        store.audit.push({
          game_id: String(gameId),
          player_id: String(playerId),
          rank: Number(rank),
          rating_before: Number(before),
          rating_after: Number(after),
          delta: Number(delta),
        });
      }
      return { success: true };
    }
    if (sql.includes('INSERT INTO plugin_elo_game_ratings')) {
      const [
        gameType,
        playerId,
        rating,
        gamesPlayed,
        updatedAt,
        gameId,
        claimToken,
        version,
        token,
      ] = bindings;
      if (ownsVersionedClaim(store, { gameId, claimToken, version, writeToken: token })) {
        const existing = store.ratings.find(
          (row) => row.game_type === gameType && row.player_id === playerId,
        );
        if (existing) {
          existing.rating = Number(rating);
          existing.games_played = Number(gamesPlayed);
          existing.updated_at = String(updatedAt);
        } else {
          store.ratings.push({
            game_type: String(gameType),
            player_id: String(playerId),
            rating: Number(rating),
            games_played: Number(gamesPlayed),
            updated_at: String(updatedAt),
          });
        }
      }
      return { success: true };
    }
    if (sql.includes('UPDATE plugin_elo_replay_results') && sql.includes('version_guard')) {
      const [checkGameId, claimToken, version, token, gameId, whereClaimToken] = bindings;
      const result = store.results.find(
        (row) => row.game_id === gameId && row.claim_token === whereClaimToken,
      );
      if (result) {
        result.version_guard = ownsVersionedClaim(store, {
          gameId: checkGameId,
          claimToken,
          version,
          writeToken: token,
        })
          ? 1
          : 0;
        if (result.version_guard === 0) {
          store.staleVersionFailures = (store.staleVersionFailures ?? 0) + 1;
          throw new Error('CHECK constraint failed: plugin_elo_stale_version');
        }
      }
      return { success: true };
    }
    throw new Error(`unhandled ladder SQL: ${sql}`);
  };

  const prepare = (sql: string): FakeStatement => {
    store.prepareCount = (store.prepareCount ?? 0) + 1;
    const create = (bindings: readonly unknown[]): FakeStatement => ({
      sql,
      bindings,
      bind: (...values) => create(values),
      first: async <T>() => {
        const value = execute(sql, bindings);
        return (Array.isArray(value) ? (value[0] ?? null) : value) as T | null;
      },
      all: async <T>() => {
        if (
          sql.includes('FROM plugin_elo_game_ratings') &&
          sql.includes('player_id IN') &&
          barrierReadsRemaining > 0
        ) {
          barrierReadsRemaining -= 1;
          await store.beforeRatingRead?.();
        }
        const value = execute(sql, bindings);
        return { results: (Array.isArray(value) ? value : []) as T[] };
      },
      run: async () => execute(sql, bindings),
    });
    return create([]);
  };

  const batch = async (statements: readonly FakeStatement[]): Promise<unknown[]> =>
    runFakeBatch(store, statements, execute);

  return { prepare, batch } as unknown as D1Database;
}
