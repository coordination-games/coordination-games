-- Phase 5: games table for tracking active/finished game status
-- Decoupled from game_sessions (which is per-player) so we can filter
-- the game list without hitting each DO.

CREATE TABLE IF NOT EXISTS games (
  game_id    TEXT PRIMARY KEY,
  game_type  TEXT NOT NULL,
  finished   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
