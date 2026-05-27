-- Sizing audit follow-up — add `capacity` to the lobbies discovery row.
--
-- Before: the `team_size` column carried whatever the CLI/web sent on the
-- wire (game-overloaded — team-size for CtL, player-count for OATH/Tragedy)
-- and every consumer reinvented a per-game formula for "how many seats does
-- this lobby actually hold?" (3 places in the web shell, 1 in fill-bots,
-- 1 in the CLI list). The server had no canonical answer.
--
-- After: `capacity` is computed once at lobby-create time from the active
-- game plugin's first lobby phase (`LobbyPhase.capacity(initState)`), stored
-- on the discovery row, and exposed by `/api/lobbies`. Clients render the
-- server's number instead of guessing. `team_size` stays as the raw
-- create-body input — phases consume it via `accumulatedMetadata.teamSize`
-- in their `init()`.
--
-- Per the no-backwards-compat policy (pre-launch), we DROP and recreate the
-- table cleanly. Any in-flight lobbies / unfinished games are killed by this
-- migration; new ones use the new column from the start.

DROP TABLE IF EXISTS lobbies;

CREATE TABLE lobbies (
  id          TEXT    NOT NULL PRIMARY KEY,
  game_type   TEXT    NOT NULL,
  team_size   INTEGER NOT NULL,
  capacity    INTEGER NOT NULL,
  phase       TEXT    NOT NULL DEFAULT 'lobby'
              CHECK (phase IN ('lobby', 'in_progress', 'finished')),
  created_at  TEXT    NOT NULL,
  game_id     TEXT
);
