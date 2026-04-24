-- Phase 5.2: ELO becomes a real ServerPlugin. The plugin owns its tables
-- under the `plugin_elo_*` namespace. Per the no-backwards-compat policy
-- (pre-launch), we DROP the legacy `matches` / `match_players` tables
-- (which the now-deleted parallel D1 tracker wrote to) and recreate them
-- under the plugin namespace.
--
-- The `players` table itself stays where it is — it is identity, not
-- ELO-specific (handle / wallet_address / chain_agent_id columns are
-- consumed across the whole worker). The plugin reads / writes the
-- `elo`, `games_played`, `wins` columns on it.
--
-- No backfill: any in-flight match history is dropped.

DROP TABLE IF EXISTS match_players;
DROP TABLE IF EXISTS matches;

CREATE TABLE plugin_elo_matches (
  id           TEXT PRIMARY KEY,
  game_type    TEXT NOT NULL,
  map_seed     TEXT,
  turns        INTEGER,
  winner_team  TEXT,
  started_at   TEXT,
  ended_at     TEXT
);

CREATE TABLE plugin_elo_match_players (
  match_id    TEXT    NOT NULL REFERENCES plugin_elo_matches(id),
  player_id   TEXT    NOT NULL REFERENCES players(id),
  team        TEXT,
  class       TEXT,
  elo_before  INTEGER,
  elo_after   INTEGER,
  PRIMARY KEY (match_id, player_id)
);
