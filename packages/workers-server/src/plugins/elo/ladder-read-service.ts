import type { D1Database } from '@cloudflare/workers-types';

export type GameLeaderboardRow = {
  readonly playerId: string;
  readonly handle: string;
  readonly gameType: string;
  readonly rating: number;
  readonly gamesPlayed: number;
};

export type GameLadderMatchRow = {
  readonly gameId: string;
  readonly rank: number;
  readonly ratingBefore: number;
  readonly ratingAfter: number;
  readonly delta: number;
  readonly recordedAt: string;
};

export type GamePlayerStats = GameLeaderboardRow & {
  readonly recentMatches: readonly GameLadderMatchRow[];
};

type GameLeaderboardRawRow = {
  readonly player_id: string;
  readonly handle: string;
  readonly rating: number;
  readonly games_played: number;
};

type GameMatchRawRow = {
  readonly game_id: string;
  readonly rank: number;
  readonly rating_before: number;
  readonly rating_after: number;
  readonly delta: number;
  readonly recorded_at: string;
};

function leaderboardRow(row: GameLeaderboardRawRow, gameType: string): GameLeaderboardRow {
  return {
    playerId: row.player_id,
    handle: row.handle,
    gameType,
    rating: row.rating,
    gamesPlayed: row.games_played,
  };
}

export async function getGameLeaderboard(
  db: D1Database,
  gameType: string,
  limit: number,
  offset: number,
): Promise<readonly GameLeaderboardRow[]> {
  const result = await db
    .prepare(
      `SELECT gr.player_id, p.handle, gr.rating, gr.games_played
         FROM plugin_elo_game_ratings gr
         JOIN players p ON p.id = gr.player_id
        WHERE gr.game_type = ?
        ORDER BY gr.rating DESC, gr.games_played DESC, gr.player_id ASC
        LIMIT ? OFFSET ?`,
    )
    .bind(gameType, limit, offset)
    .all<GameLeaderboardRawRow>();
  return result.results.map((row) => leaderboardRow(row, gameType));
}

export async function getGamePlayerStats(
  db: D1Database,
  gameType: string,
  playerId: string,
  matchLimit: number,
): Promise<GamePlayerStats | null> {
  const player = await db
    .prepare(
      `SELECT gr.player_id, p.handle, gr.rating, gr.games_played
         FROM plugin_elo_game_ratings gr
         JOIN players p ON p.id = gr.player_id
        WHERE gr.game_type = ? AND gr.player_id = ?`,
    )
    .bind(gameType, playerId)
    .first<GameLeaderboardRawRow>();
  if (player === null) return null;

  const matches = await db
    .prepare(
      `SELECT rr.game_id, rp.rank, rp.rating_before, rp.rating_after, rp.delta, rr.recorded_at
         FROM plugin_elo_replay_results rr
         JOIN plugin_elo_replay_players rp ON rp.game_id = rr.game_id
        WHERE rr.game_type = ? AND rp.player_id = ?
        ORDER BY rr.recorded_at DESC, rr.game_id DESC
        LIMIT ?`,
    )
    .bind(gameType, playerId, matchLimit)
    .all<GameMatchRawRow>();
  return {
    ...leaderboardRow(player, gameType),
    recentMatches: matches.results.map((row) => ({
      gameId: row.game_id,
      rank: row.rank,
      ratingBefore: row.rating_before,
      ratingAfter: row.rating_after,
      delta: row.delta,
      recordedAt: row.recorded_at,
    })),
  };
}
