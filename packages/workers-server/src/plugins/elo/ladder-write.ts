import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { LadderRatingUpdate } from '@coordination-games/engine';
import {
  LadderPersistenceError,
  type RatingRow,
  type RecordReplayLadderInput,
} from './ladder-types.js';

export const MAX_LADDER_WRITE_ATTEMPTS = 3;
export const STALE_VERSION_CONSTRAINT = 'plugin_elo_stale_version';

type VersionRow = { readonly version: number };

type VersionedWriteInput = {
  readonly input: RecordReplayLadderInput;
  readonly updates: readonly LadderRatingUpdate[];
  readonly currentByPlayer: ReadonlyMap<string, RatingRow>;
  readonly expectedVersion: number;
  readonly claimToken: string;
  readonly recordedAt: string;
};

export async function readLadderVersion(db: D1Database, gameType: string): Promise<number> {
  const row = await db
    .prepare('SELECT version FROM plugin_elo_ladder_versions WHERE game_type = ?')
    .bind(gameType)
    .first<VersionRow>();
  const version = row?.version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new LadderPersistenceError(`invalid ladder version for ${gameType}`);
  }
  return version;
}

function ownsClaimAndVersionSql(): string {
  return `EXISTS (
    SELECT 1
      FROM plugin_elo_replay_results rr
      JOIN plugin_elo_ladder_versions lv ON lv.game_type = rr.game_type
     WHERE rr.game_id = ? AND rr.claim_token = ?
       AND lv.version = ? AND lv.write_token = ?
  )`;
}

export function buildVersionedWriteStatements(
  db: D1Database,
  write: VersionedWriteInput,
): D1PreparedStatement[] {
  const { input, updates, currentByPlayer, expectedVersion, claimToken, recordedAt } = write;
  const nextVersion = expectedVersion + 1;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT OR IGNORE INTO plugin_elo_replay_results
           (game_id, game_type, replay_hash, result_hash, claim_token, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.gameId,
        input.gameType,
        input.replayHash,
        input.resultHash,
        claimToken,
        recordedAt,
      ),
    db
      .prepare(
        `INSERT INTO plugin_elo_ladder_versions (game_type, version, write_token, updated_at)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM plugin_elo_replay_results WHERE game_id = ? AND claim_token = ?
          )
         ON CONFLICT(game_type) DO UPDATE SET
           version = excluded.version,
           write_token = excluded.write_token,
           updated_at = excluded.updated_at
         WHERE plugin_elo_ladder_versions.version = ?`,
      )
      .bind(
        input.gameType,
        nextVersion,
        claimToken,
        recordedAt,
        input.gameId,
        claimToken,
        expectedVersion,
      ),
  ];

  for (const update of updates) {
    const guard = ownsClaimAndVersionSql();
    statements.push(
      db
        .prepare(
          `INSERT INTO plugin_elo_replay_players
             (game_id, player_id, rank, rating_before, rating_after, delta)
           SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        )
        .bind(
          input.gameId,
          update.playerId,
          update.rank,
          update.ratingBefore,
          update.ratingAfter,
          update.delta,
          input.gameId,
          claimToken,
          nextVersion,
          claimToken,
        ),
      db
        .prepare(
          `INSERT INTO plugin_elo_game_ratings
             (game_type, player_id, rating, games_played, updated_at)
           SELECT ?, ?, ?, ?, ? WHERE ${guard}
           ON CONFLICT(game_type, player_id) DO UPDATE SET
             rating = excluded.rating,
             games_played = excluded.games_played,
             updated_at = excluded.updated_at`,
        )
        .bind(
          input.gameType,
          update.playerId,
          update.ratingAfter,
          (currentByPlayer.get(update.playerId)?.games_played ?? 0) + 1,
          recordedAt,
          input.gameId,
          claimToken,
          nextVersion,
          claimToken,
        ),
    );
  }

  statements.push(
    db
      .prepare(
        `UPDATE plugin_elo_replay_results
            SET version_guard = CASE WHEN ${ownsClaimAndVersionSql()} THEN 1 ELSE 0 END
          WHERE game_id = ? AND claim_token = ?`,
      )
      .bind(input.gameId, claimToken, nextVersion, claimToken, input.gameId, claimToken),
  );
  return statements;
}

export function isStaleVersionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes(STALE_VERSION_CONSTRAINT)) return true;
  return error.cause instanceof Error && error.cause.message.includes(STALE_VERSION_CONSTRAINT);
}
