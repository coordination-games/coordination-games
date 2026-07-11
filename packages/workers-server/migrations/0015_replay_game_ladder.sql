CREATE TABLE plugin_elo_ladder_versions (
  game_type    TEXT PRIMARY KEY,
  version      INTEGER NOT NULL CHECK (version >= 0),
  write_token  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE plugin_elo_game_ratings (
  game_type   TEXT    NOT NULL,
  player_id   TEXT    NOT NULL REFERENCES players(id),
  rating      INTEGER NOT NULL DEFAULT 1000,
  games_played INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (game_type, player_id)
);

CREATE TABLE plugin_elo_replay_results (
  game_id      TEXT PRIMARY KEY,
  game_type    TEXT NOT NULL,
  replay_hash  TEXT NOT NULL,
  result_hash  TEXT NOT NULL,
  claim_token  TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  version_guard INTEGER NOT NULL DEFAULT 1
    CONSTRAINT plugin_elo_stale_version CHECK (version_guard = 1)
);

CREATE TABLE plugin_elo_replay_players (
  game_id        TEXT    NOT NULL REFERENCES plugin_elo_replay_results(game_id),
  player_id      TEXT    NOT NULL REFERENCES players(id),
  rank           INTEGER NOT NULL CHECK (rank >= 1),
  rating_before  INTEGER NOT NULL,
  rating_after   INTEGER NOT NULL,
  delta          INTEGER NOT NULL,
  PRIMARY KEY (game_id, player_id)
);

CREATE INDEX plugin_elo_game_ratings_order
  ON plugin_elo_game_ratings (game_type, rating DESC, games_played DESC, player_id ASC);

CREATE INDEX plugin_elo_replay_players_history
  ON plugin_elo_replay_players (player_id, game_id);
