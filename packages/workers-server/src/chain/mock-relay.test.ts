import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveMockChainAgentId, MockRelay } from './mock-relay.js';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const REGISTER_PARAMS = {
  name: 'mock-treasury',
  address: ADDRESS,
  agentURI: 'https://example.test/mock-treasury',
  permitDeadline: 0,
  v: 27,
  r: '0x',
  s: '0x',
};

let miniflare: Miniflare;
let db: D1Database;

beforeEach(async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2025-01-01',
    d1Databases: ['DB'],
    modules: true,
    script: 'export default { fetch() { return new Response(); } };',
  });
  db = await miniflare.getD1Database('DB');
  await db.exec(
    'CREATE TABLE players (id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE, chain_agent_id INTEGER, elo INTEGER NOT NULL, games_played INTEGER NOT NULL, wins INTEGER NOT NULL, created_at TEXT NOT NULL)',
  );
});

afterEach(async () => {
  await miniflare.dispose();
});

describe('deriveMockChainAgentId', () => {
  it('Given one valid wallet address, when deriving a local relay identity twice, then returns the same positive safe integer', () => {
    const first = deriveMockChainAgentId(ADDRESS);
    const second = deriveMockChainAgentId(ADDRESS.toUpperCase());

    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0);
    expect(Number.isSafeInteger(first)).toBe(true);
  });

  it('Given an invalid wallet address, when deriving a local relay identity, then rejects it explicitly', () => {
    expect(() => deriveMockChainAgentId('not-an-evm-address')).toThrow('Invalid EVM address');
  });

  it('Given a new wallet, when MockRelay registers it, then inserts the derived chain identity', async () => {
    await new MockRelay(db).register(REGISTER_PARAMS);

    const row = await db
      .prepare('SELECT id, chain_agent_id FROM players WHERE wallet_address = ?')
      .bind(ADDRESS.toLowerCase())
      .first<{ id: string; chain_agent_id: number | null }>();

    expect(row?.chain_agent_id).toBe(deriveMockChainAgentId(ADDRESS));
  });

  it('Given a cached player with a null identity, when MockRelay registers it, then backfills in place without duplicate rows', async () => {
    await db
      .prepare(
        'INSERT INTO players (id, wallet_address, handle, chain_agent_id, elo, games_played, wins, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        'stable-player-id',
        ADDRESS.toLowerCase(),
        'mock-treasury',
        null,
        1000,
        0,
        0,
        '2026-07-11',
      )
      .run();
    const relay = new MockRelay(db);

    const first = await relay.register(REGISTER_PARAMS);
    const second = await relay.register(REGISTER_PARAMS);
    const row = await db
      .prepare('SELECT id, chain_agent_id FROM players WHERE wallet_address = ?')
      .bind(ADDRESS.toLowerCase())
      .first<{ id: string; chain_agent_id: number | null }>();
    const count = await db
      .prepare('SELECT COUNT(*) AS count FROM players WHERE wallet_address = ?')
      .bind(ADDRESS.toLowerCase())
      .first<{ count: number }>();

    expect(first.agentId).toBe('stable-player-id');
    expect(second.agentId).toBe('stable-player-id');
    expect(row).toEqual({
      id: 'stable-player-id',
      chain_agent_id: deriveMockChainAgentId(ADDRESS),
    });
    expect(count?.count).toBe(1);
  });
});
