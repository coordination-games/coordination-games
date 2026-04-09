-- Phase 3: game_sessions table
-- Maps a player_id to the game they are currently in.
-- One row per active player — updated when they join/leave a game.

CREATE TABLE IF NOT EXISTS game_sessions (
  player_id TEXT NOT NULL,
  game_id   TEXT NOT NULL,
  game_type TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (player_id)
);

CREATE INDEX IF NOT EXISTS game_sessions_by_game ON game_sessions (game_id);
