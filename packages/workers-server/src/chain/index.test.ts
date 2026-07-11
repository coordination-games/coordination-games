import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRelay, type RelayEnv } from './index.js';
import { MOCK_CREDIT_BALANCE, MockRelay } from './mock-relay.js';
import { OnChainRelay } from './onchain-relay.js';
import { StrictLocalRelay } from './strict-local-relay.js';

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

function relayEnv(overrides: Partial<RelayEnv> = {}): RelayEnv {
  return { DB: db, ...overrides };
}

describe('createRelay', () => {
  it('Given exact strict local mode without RPC, when creating a relay, then returns StrictLocalRelay', () => {
    expect(createRelay(relayEnv({ STRICT_LOCAL_SETTLEMENT: 'true' }))).toBeInstanceOf(
      StrictLocalRelay,
    );
  });

  it.each([
    undefined,
    'false',
    'TRUE',
    '1',
    'strict',
  ])('Given strict flag %s without RPC, when creating a relay, then preserves MockRelay defaults', async (flag) => {
    const relay = createRelay(
      flag === undefined ? relayEnv() : relayEnv({ STRICT_LOCAL_SETTLEMENT: flag }),
    );

    expect(relay).toBeInstanceOf(MockRelay);
    expect(relay).not.toBeInstanceOf(StrictLocalRelay);
    expect(await relay.getBalance('agent-id')).toEqual({ credits: MOCK_CREDIT_BALANCE, usdc: '0' });
    expect(await relay.getAgentByAddress('0x0000000000000000000000000000000000000001')).toBeNull();
  });

  it('Given RPC_URL and strict local mode, when creating a relay, then returns OnChainRelay without a network call', () => {
    const relay = createRelay(
      relayEnv({ RPC_URL: 'https://rpc.example.test', STRICT_LOCAL_SETTLEMENT: 'true' }),
    );

    expect(relay).toBeInstanceOf(OnChainRelay);
    expect(relay).not.toBeInstanceOf(StrictLocalRelay);
  });
});
