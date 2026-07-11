import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { buildActionMerkleTree, type MerkleLeafData } from '@coordination-games/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import * as pluginEndpoint from '../plugin-endpoint.js';
import { type LadderFakeStore, makeLadderFakeD1 } from '../plugins/elo/__tests__/ladder-d1-fake.js';

type ReplayBundle = {
  readonly gameId: string;
  readonly gameType: string;
  readonly finished: boolean;
  readonly playerIds: readonly string[];
  readonly config: unknown;
  readonly actionLog: readonly { readonly playerId: string | null; readonly action: unknown }[];
  readonly result: {
    readonly outcome: unknown;
    readonly movesRoot: string;
    readonly configHash: string;
    readonly turnCount: number;
  };
  readonly horizonReveal?: unknown;
  readonly privateMetadata?: unknown;
};

function bundle(overrides: Partial<ReplayBundle> = {}): ReplayBundle {
  const actionLog = overrides.actionLog ?? [
    { playerId: null, action: { type: 'game_start' } },
    { playerId: 'alice', action: { type: 'move', path: [] } },
  ];
  const leaves: MerkleLeafData[] = actionLog.map((entry, actionIndex) => ({
    actionIndex,
    playerId: entry.playerId,
    actionData: JSON.stringify(entry.action),
  }));
  return {
    gameId: 'game-1',
    gameType: 'capture-the-lobster',
    finished: true,
    playerIds: ['alice', 'bob'],
    config: { gameType: 'capture-the-lobster', playerIds: ['alice', 'bob'] },
    actionLog,
    result: {
      outcome: {
        winner: 'A',
        score: { A: 1, B: 0 },
        turnCount: 1,
        playerStats: {
          alice: { team: 'A', kills: 0, deaths: 0, flagCarries: 1, flagCaptures: 1 },
          bob: { team: 'B', kills: 0, deaths: 0, flagCarries: 0, flagCaptures: 0 },
        },
      },
      movesRoot: buildActionMerkleTree(leaves).root,
      configHash: `0x${'33'.repeat(32)}`,
      turnCount: actionLog.length,
    },
    ...overrides,
  };
}

function namespace(response: () => Response): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => 'game-1' }),
    get: () => ({ fetch: async () => response() }),
  } as unknown as DurableObjectNamespace;
}

function makeEnv(store: LadderFakeStore, response: () => Response, adminToken?: string): Env {
  return {
    DB: makeLadderFakeD1(store),
    GAME_ROOM: namespace(response),
    LOBBY: {} as DurableObjectNamespace,
    ENVIRONMENT: 'test',
    ...(adminToken === undefined ? {} : { ADMIN_TOKEN: adminToken }),
  };
}

async function ingest(env: Env, token = 'secret'): Promise<Response> {
  const handler = Reflect.get(pluginEndpoint, 'handleAdminLadderReplay');
  if (typeof handler !== 'function') {
    throw new TypeError('admin ladder replay handler is not implemented');
  }
  return handler(
    new Request('https://worker.invalid/api/admin/ladder/replay/game-1', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
    }),
    env,
    'game-1',
  );
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('expected response object');
  }
  return Object.fromEntries(Object.entries(value));
}

function emptyStore(): LadderFakeStore {
  return {
    players: [
      { id: 'alice', handle: 'Alice' },
      { id: 'bob', handle: 'Bob' },
    ],
    versions: [],
    ratings: [],
    results: [],
    audit: [],
  };
}

describe('POST /api/admin/ladder/replay/:gameId', () => {
  let currentBundle: ReplayBundle;
  let store: LadderFakeStore;

  beforeEach(() => {
    currentBundle = bundle();
    store = emptyStore();
  });

  it('Given ADMIN_TOKEN is disabled, when replay ingestion is requested, then the endpoint returns 503', async () => {
    // Given
    const env = makeEnv(store, () => Response.json(currentBundle));

    // When
    const response = await ingest(env);

    // Then
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Admin endpoint disabled (ADMIN_TOKEN not set)',
    });
  });

  it('Given a wrong admin token, when replay ingestion is requested, then the endpoint returns 401', async () => {
    // Given
    const env = makeEnv(store, () => Response.json(currentBundle), 'secret');

    // When
    const response = await ingest(env, 'wrong');

    // Then
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid admin token' });
  });

  it('Given a completed authoritative bundle, when ingested twice, then its hash is deterministic and ratings record once', async () => {
    // Given
    const env = makeEnv(store, () => Response.json(currentBundle), 'secret');

    // When
    const first = await ingest(env);
    const second = await ingest(env);
    const firstReceipt = responseRecord(await first.json());
    const secondReceipt = responseRecord(await second.json());

    // Then
    expect(first.status).toBe(200);
    expect(firstReceipt).toMatchObject({
      gameId: 'game-1',
      gameType: 'capture-the-lobster',
      recorded: true,
      players: [
        { playerId: 'alice', rank: 1, before: 1000, after: 1016, delta: 16 },
        { playerId: 'bob', rank: 2, before: 1000, after: 984, delta: -16 },
      ],
    });
    expect(secondReceipt).toMatchObject({
      replayHash: Reflect.get(firstReceipt, 'replayHash'),
      recorded: false,
    });
    expect(store.results).toHaveLength(1);
  });

  it('Given only secret reveal fields change, when re-ingested, then they are excluded from evidence and the public receipt', async () => {
    // Given
    currentBundle = bundle({
      horizonReveal: { secret: 'first-secret' },
      privateMetadata: 'private',
    });
    const env = makeEnv(store, () => Response.json(currentBundle), 'secret');
    const first = await ingest(env);
    const firstReceipt = responseRecord(await first.json());
    currentBundle = bundle({
      horizonReveal: { secret: 'second-secret' },
      privateMetadata: 'changed',
    });

    // When
    const second = await ingest(env);
    const secondReceipt = responseRecord(await second.json());
    const serialized = JSON.stringify(secondReceipt);

    // Then
    expect(Reflect.get(secondReceipt, 'replayHash')).toBe(Reflect.get(firstReceipt, 'replayHash'));
    expect(Reflect.get(secondReceipt, 'recorded')).toBe(false);
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('config');
    expect(serialized).not.toContain('action');
  });

  it('Given the GameRoom reports unfinished, when ingested, then no ladder write occurs', async () => {
    // Given
    const env = makeEnv(
      store,
      () => Response.json({ error: 'Game not finished yet' }, { status: 409 }),
      'secret',
    );

    // When
    const response = await ingest(env);

    // Then
    expect(response.status).toBe(409);
    expect(store.results).toEqual([]);
  });

  it('Given a malformed completed bundle, when ingested, then it is rejected without writes', async () => {
    // Given
    const env = makeEnv(store, () => Response.json({ gameId: 'game-1', finished: true }), 'secret');

    // When
    const response = await ingest(env);

    // Then
    expect(response.status).toBe(400);
    expect(store.results).toEqual([]);
  });

  it('Given an action log that disagrees with movesRoot, when ingested, then replay verification rejects it', async () => {
    // Given
    currentBundle = bundle({
      result: { ...bundle().result, movesRoot: `0x${'ff'.repeat(32)}` },
    });
    const env = makeEnv(store, () => Response.json(currentBundle), 'secret');

    // When
    const response = await ingest(env);

    // Then
    expect(response.status).toBe(409);
    expect(store.results).toEqual([]);
  });

  it('Given the same game id later has different replay evidence, when ingested, then the conflict is explicit', async () => {
    // Given
    const env = makeEnv(store, () => Response.json(currentBundle), 'secret');
    await ingest(env);
    currentBundle = bundle({
      actionLog: [
        { playerId: null, action: { type: 'game_start' } },
        { playerId: 'alice', action: { type: 'turn_timeout' } },
      ],
    });

    // When
    const response = await ingest(env);

    // Then
    expect(response.status).toBe(409);
    expect(store.results).toHaveLength(1);
  });
});
