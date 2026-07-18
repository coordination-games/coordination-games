ALTER TABLE player_sessions ADD COLUMN terminal_state TEXT
  CHECK (terminal_state IS NULL OR terminal_state IN ('eliminated', 'completed'));
