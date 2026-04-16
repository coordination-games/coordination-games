-- Phase 8: Collapse lobby_sessions + game_sessions into a single player_sessions table.
--
-- A player's current location is tracked by a single row pointing at a lobby.
-- The lobby row carries a `game_id` once LobbyDO spawns a game, so routing is:
--   session → lobby → (game_id if set → GameRoomDO, else LobbyDO).
--
-- This eliminates the two-table mutual-exclusion-by-convention bug where a
-- stale finished game_session could shadow an active lobby_session.

CREATE TABLE IF NOT EXISTS player_sessions (
  player_id TEXT NOT NULL PRIMARY KEY,
  lobby_id  TEXT NOT NULL,
  joined_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS player_sessions_by_lobby ON player_sessions (lobby_id);

-- Backfill from lobby_sessions (players currently queued in a lobby).
INSERT OR IGNORE INTO player_sessions (player_id, lobby_id, joined_at)
SELECT player_id, lobby_id, joined_at FROM lobby_sessions;

-- Backfill from game_sessions (players currently in a game — no lobby_sessions
-- row because LobbyDO deletes it at handoff). Resolve via lobbies.game_id.
INSERT OR IGNORE INTO player_sessions (player_id, lobby_id, joined_at)
SELECT gs.player_id, l.id, gs.joined_at
FROM game_sessions gs
JOIN lobbies l ON l.game_id = gs.game_id;

DROP TABLE IF EXISTS lobby_sessions;
DROP TABLE IF EXISTS game_sessions;
