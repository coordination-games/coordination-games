-- Short-lived, single-use tickets for authenticating WebSocket upgrades.
-- Native WebSocket clients can't set custom headers, so the player trades a
-- Bearer-authed POST for a ticket and opens the socket with `?ticket=<id>`.
-- The server consumes (delete-on-read) the ticket on upgrade.
CREATE TABLE IF NOT EXISTS ws_tickets (
  ticket TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_tickets_expires ON ws_tickets(expires_at);
