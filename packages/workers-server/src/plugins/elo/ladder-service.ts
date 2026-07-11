import type { D1Database } from '@cloudflare/workers-types';
import { computeMultiplayerElo, DEFAULT_LADDER_RATING } from '@coordination-games/engine';
import {
  LadderPersistenceError,
  LadderReplayConflictError,
  type RatingRow,
  type RecordReplayLadderInput,
  type ReplayLadderPlayerReceipt,
  type ReplayLadderReceipt,
  type ReplayResultRow,
} from './ladder-types.js';
import { parseRecordReplayLadderInput } from './ladder-validation.js';
import {
  buildVersionedWriteStatements,
  isStaleVersionError,
  MAX_LADDER_WRITE_ATTEMPTS,
  readLadderVersion,
} from './ladder-write.js';

export {
  LadderPersistenceError,
  LadderReplayConflictError,
  type RecordReplayLadderInput,
  type ReplayLadderPlayerReceipt,
  type ReplayLadderReceipt,
} from './ladder-types.js';

type ReplayPlayerRow = {
  readonly player_id: string;
  readonly rank: number;
  readonly rating_before: number;
  readonly rating_after: number;
  readonly delta: number;
};

type PlayerIdRow = { readonly id: string };

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function hasSameEvidence(existing: ReplayResultRow, input: RecordReplayLadderInput): boolean {
  return (
    existing.game_type === input.gameType &&
    existing.replay_hash === input.replayHash &&
    existing.result_hash === input.resultHash
  );
}

async function readResult(db: D1Database, gameId: string): Promise<ReplayResultRow | null> {
  return db
    .prepare(
      `SELECT game_id, game_type, replay_hash, result_hash, claim_token, recorded_at
         FROM plugin_elo_replay_results
        WHERE game_id = ?`,
    )
    .bind(gameId)
    .first<ReplayResultRow>();
}

async function readReceiptPlayers(
  db: D1Database,
  gameId: string,
): Promise<readonly ReplayLadderPlayerReceipt[]> {
  const rows = await db
    .prepare(
      `SELECT player_id, rank, rating_before, rating_after, delta
         FROM plugin_elo_replay_players
        WHERE game_id = ?
        ORDER BY player_id ASC`,
    )
    .bind(gameId)
    .all<ReplayPlayerRow>();
  return rows.results.map((row) => ({
    playerId: row.player_id,
    rank: row.rank,
    before: row.rating_before,
    after: row.rating_after,
    delta: row.delta,
  }));
}

async function existingReceipt(
  db: D1Database,
  input: RecordReplayLadderInput,
): Promise<ReplayLadderReceipt | null> {
  const existing = await readResult(db, input.gameId);
  if (!existing) return null;
  if (!hasSameEvidence(existing, input)) {
    throw new LadderReplayConflictError(input.gameId);
  }
  return {
    gameId: existing.game_id,
    gameType: existing.game_type,
    replayHash: existing.replay_hash,
    recorded: false,
    players: await readReceiptPlayers(db, input.gameId),
  };
}

async function requireRegisteredPlayers(
  db: D1Database,
  input: RecordReplayLadderInput,
): Promise<void> {
  const playerIds = input.placements.map((placement) => placement.playerId);
  const rows = await db
    .prepare(`SELECT id FROM players WHERE id IN (${placeholders(playerIds.length)})`)
    .bind(...playerIds)
    .all<PlayerIdRow>();
  const registered = new Set(rows.results.map((row) => row.id));
  const missing = playerIds.filter((playerId) => !registered.has(playerId));
  if (missing.length > 0) {
    throw new LadderPersistenceError(`unregistered ladder players: ${missing.join(', ')}`);
  }
}

async function readRatings(
  db: D1Database,
  input: RecordReplayLadderInput,
): Promise<ReadonlyMap<string, RatingRow>> {
  const playerIds = input.placements.map((placement) => placement.playerId);
  const rows = await db
    .prepare(
      `SELECT player_id, rating, games_played
         FROM plugin_elo_game_ratings
        WHERE game_type = ? AND player_id IN (${placeholders(playerIds.length)})`,
    )
    .bind(input.gameType, ...playerIds)
    .all<RatingRow>();
  return new Map(rows.results.map((row) => [row.player_id, row]));
}

export async function recordReplayLadderMatch(
  db: D1Database,
  untrustedInput: RecordReplayLadderInput,
): Promise<ReplayLadderReceipt> {
  const input = parseRecordReplayLadderInput(untrustedInput);
  const priorReceipt = await existingReceipt(db, input);
  if (priorReceipt) return priorReceipt;
  await requireRegisteredPlayers(db, input);

  const claimToken = crypto.randomUUID();
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  for (let attempt = 0; attempt < MAX_LADDER_WRITE_ATTEMPTS; attempt += 1) {
    const concurrentReceipt = await existingReceipt(db, input);
    if (concurrentReceipt) return concurrentReceipt;
    const expectedVersion = await readLadderVersion(db, input.gameType);
    const currentByPlayer = await readRatings(db, input);
    const updates = computeMultiplayerElo({
      participants: input.placements.map(({ playerId }) => ({
        playerId,
        rating: currentByPlayer.get(playerId)?.rating ?? DEFAULT_LADDER_RATING,
      })),
      placements: input.placements,
    });

    try {
      await db.batch(
        buildVersionedWriteStatements(db, {
          input,
          updates,
          currentByPlayer,
          expectedVersion,
          claimToken,
          recordedAt,
        }),
      );
    } catch (error) {
      if (isStaleVersionError(error)) continue;
      throw error;
    }

    const persisted = await readResult(db, input.gameId);
    if (!persisted) {
      throw new LadderPersistenceError(`missing replay result after recording ${input.gameId}`);
    }
    if (!hasSameEvidence(persisted, input)) {
      throw new LadderReplayConflictError(input.gameId);
    }
    return {
      gameId: persisted.game_id,
      gameType: persisted.game_type,
      replayHash: persisted.replay_hash,
      recorded: persisted.claim_token === claimToken,
      players: await readReceiptPlayers(db, input.gameId),
    };
  }

  throw new LadderPersistenceError(
    `ladder write remained stale after ${MAX_LADDER_WRITE_ATTEMPTS} attempts`,
  );
}
