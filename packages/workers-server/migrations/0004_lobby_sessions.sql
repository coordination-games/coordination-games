-- Phase 4: Lobby discovery table and player→lobby session tracking

CREATE TABLE IF NOT EXISTS lobbies (
  id          TEXT    NOT NULL PRIMARY KEY,
  game_type   TEXT    NOT NULL,
  team_size   INTEGER NOT NULL,
  phase       TEXT    NOT NULL DEFAULT 'forming',
  created_at  TEXT    NOT NULL,
  game_id     TEXT
);

CREATE TABLE IF NOT EXISTS lobby_sessions (
  player_id   TEXT NOT NULL PRIMARY KEY,
  lobby_id    TEXT NOT NULL,
  joined_at   TEXT NOT NULL
);
