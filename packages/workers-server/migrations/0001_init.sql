CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  elo INTEGER DEFAULT 1200,
  games_played INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  game_type TEXT NOT NULL,
  map_seed TEXT,
  turns INTEGER,
  winner_team TEXT,
  started_at TEXT,
  ended_at TEXT,
  replay_json TEXT
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  team TEXT,
  class TEXT,
  elo_before INTEGER,
  elo_after INTEGER,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
