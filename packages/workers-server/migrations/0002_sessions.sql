CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  name TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
