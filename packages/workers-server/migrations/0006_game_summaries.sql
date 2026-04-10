-- Phase 6: game_summaries — cached progress written by GameRoomDO on each
-- progress increment.  The /api/games list query joins this instead of
-- fan-out to every DO.

CREATE TABLE IF NOT EXISTS game_summaries (
  game_id          TEXT PRIMARY KEY REFERENCES games(game_id),
  progress_counter INTEGER NOT NULL DEFAULT 0,
  summary_json     TEXT NOT NULL DEFAULT '{}',
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
