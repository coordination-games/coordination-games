ALTER TABLE players ADD COLUMN chain_agent_id INTEGER;
CREATE UNIQUE INDEX idx_players_chain_agent_id ON players(chain_agent_id);
