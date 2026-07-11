import { parseBytes32Hex } from '@coordination-games/engine';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StrictLocalRelay } from './strict-local-relay.js';

let miniflare: Miniflare;
let db: D1Database;

const settlement = {
  gameId: 'tournament-game-0',
  gameType: 'tragedy-of-the-commons',
  playerIds: ['player-a', 'player-b', 'treasury'],
  outcome: { winner: 'player-a' },
  movesRoot: `0x${'11'.repeat(32)}` as `0x${string}`,
  configHash: `0x${'22'.repeat(32)}`,
  turnCount: 2,
  horizonReveal: {
    secret: parseBytes32Hex(`0x${'33'.repeat(32)}`),
    playerEntropy: parseBytes32Hex(`0x${'44'.repeat(32)}`),
  },
  tournament: true as const,
  entryCost: 100n,
  timestamp: 1_700_000_000_000,
  deltas: [
    { agentId: 'player-a', delta: 50n },
    { agentId: 'player-b', delta: -100n },
    { agentId: 'treasury', delta: 50n },
  ],
};

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
  await db
    .prepare(
      'INSERT INTO players (id, wallet_address, handle, chain_agent_id, elo, games_played, wins, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)',
    )
    .bind('player-a', '0x0000000000000000000000000000000000000001', 'alpha', 1, '2026-07-11')
    .run();
  await db
    .prepare(
      'INSERT INTO players (id, wallet_address, handle, chain_agent_id, elo, games_played, wins, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)',
    )
    .bind('player-b', '0x0000000000000000000000000000000000000002', 'beta', 2, '2026-07-11')
    .run();
  await db
    .prepare(
      'INSERT INTO players (id, wallet_address, handle, chain_agent_id, elo, games_played, wins, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)',
    )
    .bind(
      'treasury',
      '0x0000000000000000000000000000000000000003',
      'tournament-treasury',
      3,
      '2026-07-11',
    )
    .run();
});

afterEach(async () => {
  await miniflare.dispose();
});

describe('StrictLocalRelay', () => {
  it('Given a valid tournament settlement, when submitted twice, then persists one deterministic confirmed receipt', async () => {
    const relay = new StrictLocalRelay(db, 'tournament-treasury');

    const first = await relay.submit(settlement);
    const second = await relay.submit(settlement);

    expect(second).toEqual(first);
    expect(await relay.pollReceipt(first.txHash)).toEqual({ status: 'confirmed', blockNumber: 1 });
    expect(
      await db
        .prepare('SELECT tx_hash FROM strict_local_settlement_receipts WHERE tx_hash = ?')
        .bind(first.txHash)
        .first(),
    ).not.toBeNull();
  });

  it.each([
    [
      'an unregistered participant',
      {
        ...settlement,
        playerIds: ['player-a', 'missing', 'treasury'],
        deltas: [
          { agentId: 'player-a', delta: 50n },
          { agentId: 'missing', delta: -100n },
          { agentId: 'treasury', delta: 50n },
        ],
      },
      /missing chain_agent_id/,
    ],
    [
      'duplicate participant IDs',
      { ...settlement, playerIds: ['player-a', 'player-a', 'treasury'] },
      /unique/,
    ],
    [
      'a non-zero sum',
      {
        ...settlement,
        deltas: [
          { agentId: 'player-a', delta: 50n },
          { agentId: 'player-b', delta: -100n },
          { agentId: 'treasury', delta: 51n },
        ],
      },
      /zero-sum/,
    ],
    [
      'a floor violation',
      {
        ...settlement,
        deltas: [
          { agentId: 'player-a', delta: 50n },
          { agentId: 'player-b', delta: -101n },
          { agentId: 'treasury', delta: 51n },
        ],
      },
      /floor/,
    ],
  ])('Given %s, when submitted, then rejects before receipt persistence', async (_name, payload, error) => {
    const relay = new StrictLocalRelay(db, 'tournament-treasury');

    await expect(relay.submit(payload)).rejects.toThrow(error);
  });

  it('Given a tournament payload without its configured treasury, when submitted, then rejects it', async () => {
    const relay = new StrictLocalRelay(db, 'tournament-treasury');
    const payload = {
      ...settlement,
      playerIds: ['player-a', 'player-b'],
      deltas: [
        { agentId: 'player-a', delta: 100n },
        { agentId: 'player-b', delta: -100n },
      ],
    };

    await expect(relay.submit(payload)).rejects.toThrow(/treasury/);
  });
});
