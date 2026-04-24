-- Phase 4.6: Unify the lobbies.phase enum onto the engine-level GamePhaseKind.
--
-- BEFORE (since 0004): phase TEXT with the per-DO ad-hoc strings
--   'forming' (default, never written), 'running', 'starting', 'game', 'failed'.
-- AFTER: phase TEXT CHECK (phase IN ('lobby', 'in_progress', 'finished'))
--   matching the new `GamePhaseKind` exported from `@coordination-games/engine`:
--     'lobby'       — pre-game (was 'forming' / 'running' / 'starting')
--     'in_progress' — game has been spawned (was 'game')
--     'finished'    — terminal: game ended OR lobby errored (was 'failed')
--                     (the lobbies row also carries `game_id`; absence of a
--                     game_id on a 'finished' row means the lobby died)
--
-- Per the no-backwards-compat policy (pre-launch), we DROP and recreate the
-- table cleanly. Any in-flight lobbies / unfinished games are killed by this
-- migration; new ones use the new enum from the start.
--
-- D1 / SQLite has no native ENUM, so we enforce the constraint with a CHECK.
-- The `lobbies` table is otherwise unchanged.

DROP TABLE IF EXISTS lobbies;

CREATE TABLE lobbies (
  id          TEXT    NOT NULL PRIMARY KEY,
  game_type   TEXT    NOT NULL,
  team_size   INTEGER NOT NULL,
  phase       TEXT    NOT NULL DEFAULT 'lobby'
              CHECK (phase IN ('lobby', 'in_progress', 'finished')),
  created_at  TEXT    NOT NULL,
  game_id     TEXT
);
