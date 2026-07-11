import {
  computeHorizonCommitment,
  computeTournamentPolicyHash,
  createHiddenHorizonPublicConfig,
  deriveTournamentGameSeed,
  parseBytes32Hex,
} from '@coordination-games/engine';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

type StoredValue = unknown;
type Storage = {
  readonly values: Map<string, StoredValue>;
  get: <T>(key: string | readonly string[]) => Promise<T | Map<string, T | undefined> | undefined>;
  put: (key: string, value: StoredValue) => Promise<void>;
  list: <T>() => Promise<Map<string, T>>;
  getAlarm: () => Promise<null>;
  setAlarm: () => Promise<void>;
  deleteAlarm: () => Promise<void>;
  delete: (key: string) => Promise<boolean>;
};

type Handler = (this: object, request?: Request) => Promise<Response>;
let gameRoomPrototype: object | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectNoPrivatePublicMaterial(value: unknown): void {
  const serialized = JSON.stringify(value).toLowerCase();
  for (const privateValue of [secret, entropy, rootSeed]) {
    expect(serialized).not.toContain(privateValue.toLowerCase());
  }
  for (const privateKey of [
    'horizonsecret',
    '"secret"',
    'playerentropy',
    '"entropy"',
    'tournamentrootseed',
    'root_seed',
    'horizonreveal',
    'commitmentinput',
    'configinput',
    'privatepayload',
    'privatematerial',
  ]) {
    expect(serialized).not.toContain(privateKey);
  }
}

function storage(): Storage {
  const values = new Map<string, StoredValue>();
  return {
    values,
    get: async <T>(key: string | readonly string[]) => {
      if (typeof key === 'string') return values.get(key) as T | undefined;
      return new Map(key.map((entry) => [entry, values.get(entry) as T | undefined]));
    },
    put: async (key, value) => {
      values.set(key, value);
    },
    list: async <T>() => new Map(values) as Map<string, T>,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    delete: async (key) => values.delete(key),
  };
}

async function handler(name: string): Promise<Handler> {
  const { GameRoomDO } = await import('./GameRoomDO.js');
  gameRoomPrototype = GameRoomDO.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(GameRoomDO.prototype, name);
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new Error(`GameRoomDO.${name} is unavailable`);
  }
  return descriptor.value;
}

function makeRoom(storageHandle: Storage): object {
  if (gameRoomPrototype === null) throw new Error('GameRoomDO prototype is unavailable');
  return Object.assign(Object.create(gameRoomPrototype), {
    _loaded: false,
    _meta: null,
    _plugin: null,
    _state: null,
    _config: null,
    _configHash: null,
    _tournamentCommitment: null,
    _actionLog: [],
    _progress: { counter: 0 },
    _stateVersion: 0,
    _spectatorSnapshots: [],
    _lastSpectatorIdx: null,
    ctx: {
      id: { name: 'tournament-room' },
      storage: storageHandle,
      blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      waitUntil: () => undefined,
      getWebSockets: () => [],
    },
    env: {
      DB: {
        prepare: () => ({ bind: () => ({ run: async () => undefined }) }),
      },
    },
  });
}

const rootSeed = parseBytes32Hex(`0x${'20'.repeat(32)}`);
const secret = parseBytes32Hex(`0x${'21'.repeat(32)}`);
const entropy = parseBytes32Hex(`0x${'22'.repeat(32)}`);
const policy = {
  seriesLength: 1,
  baseEntryCost: 100n,
  carryBps: 0,
  slashBps: 0,
  minRounds: 1,
  maxRounds: 4,
  hazardNumerator: 1,
  hazardDenominator: 2,
};
const policyHash = computeTournamentPolicyHash(policy);
const gameId = 'tournament-room';
const commitment = computeHorizonCommitment({ secret, gameId, playerEntropy: entropy, policyHash });
const config = {
  maxRounds: 4,
  startingPoints: 100,
  minPledge: 5,
  maxPledgePct: 50,
  titheRate: 10,
  yieldRate: 10,
  scalingK: 1,
  turnTimerSeconds: 10,
  seed: 'oath-seed',
  entryCost: 1,
  playerIds: ['alice', 'bob'],
  hiddenHorizon: createHiddenHorizonPublicConfig(commitment, policy),
};
const context = {
  tournamentRootSeed: rootSeed,
  gameSeed: deriveTournamentGameSeed(rootSeed, 'tournament-1', 0),
  tournamentId: 'tournament-1',
  gameIndex: 0,
  policy,
  horizonSecret: secret,
  playerEntropy: entropy,
};

describe('GameRoomDO tournament creation lifecycle', () => {
  it('Given a mismatched public commitment, when creating, then it rejects before storage writes', async () => {
    const store = storage();
    const create = await handler('handleCreate');
    const room = makeRoom(store);
    const response = await create.call(
      room,
      new Request('https://game.invalid/', {
        method: 'POST',
        body: JSON.stringify({
          gameType: 'oathbreaker',
          gameId,
          playerIds: ['alice', 'bob'],
          config: { ...config, hiddenHorizon: { ...config.hiddenHorizon, commitment: entropy } },
          tournamentCommitContext: {
            ...context,
            policy: { ...policy, baseEntryCost: '100' },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(store.values).toEqual(new Map());
  });

  it('Given a nested private alias, when creating, then it rejects before plugin initialization or storage writes', async () => {
    const store = storage();
    const create = await handler('handleCreate');
    const room = makeRoom(store);
    const response = await create.call(
      room,
      new Request('https://game.invalid/', {
        method: 'POST',
        body: JSON.stringify({
          gameType: 'oathbreaker',
          gameId,
          playerIds: ['alice', 'bob'],
          config: { ...config, diagnostics: { player_entropy: 'masked' } },
          tournamentCommitContext: {
            ...context,
            policy: { ...policy, baseEntryCost: '100' },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(store.values).toEqual(new Map());
  });

  it('Given a valid tournament create, when it reloads and finishes, then it preserves the sealed t0 artifact and reveals separately', async () => {
    const store = storage();
    const create = await handler('handleCreate');
    const room = makeRoom(store);
    const createResponse = await create.call(
      room,
      new Request('https://game.invalid/', {
        method: 'POST',
        body: JSON.stringify({
          gameType: 'oathbreaker',
          gameId,
          playerIds: ['alice', 'bob'],
          config,
          tournamentCommitContext: {
            ...context,
            policy: { ...policy, baseEntryCost: '100' },
          },
        }),
      }),
    );
    const createPayload = await createResponse.json();
    if (!isRecord(createPayload) || !isRecord(createPayload.tournament)) {
      throw new Error('Expected public tournament create payload');
    }

    expect(createResponse.status).toBe(200);
    expect(createPayload).toMatchObject({
      tournament: { commitment, policyHash },
    });
    expect(store.values.has('configHash')).toBe(true);
    expect(store.values.has('tournamentCommitment')).toBe(true);
    expectNoPrivatePublicMaterial(createPayload);
    expectNoPrivatePublicMaterial(store.values.get('config'));
    expectNoPrivatePublicMaterial(store.values.get('meta'));
    expectNoPrivatePublicMaterial(store.values.get('snapshot:0'));

    const result = await handler('handleResult');
    const bundle = await handler('handleBundle');
    const beforeResult = await result.call(makeRoom(store));
    const beforeBundle = await bundle.call(makeRoom(store));
    expect(beforeResult.status).toBe(409);
    expect(beforeBundle.status).toBe(409);
    expect(await beforeResult.text()).not.toContain(secret);
    expect(await beforeBundle.text()).not.toContain(secret);

    const currentState = store.values.get('state');
    if (typeof currentState !== 'object' || currentState === null || Array.isArray(currentState)) {
      throw new Error('Expected OATHBREAKER state');
    }
    store.values.set('state', { ...currentState, phase: 'finished' });
    store.values.set('config', { ...config, seed: 'mutated-config' });
    const currentMeta = store.values.get('meta');
    if (typeof currentMeta !== 'object' || currentMeta === null || Array.isArray(currentMeta)) {
      throw new Error('Expected game meta');
    }
    store.values.set('meta', { ...currentMeta, createdAt: 'tampered' });
    store.values.set('actionLog', [{ playerId: 'alice', action: { tampered: true } }]);

    const resultResponse = await result.call(makeRoom(store));
    const bundleResponse = await bundle.call(makeRoom(store));
    const resultPayload = await resultResponse.json();
    const bundlePayload = await bundleResponse.json();
    if (
      !isRecord(resultPayload) ||
      !isRecord(bundlePayload) ||
      !isRecord(bundlePayload.tournament)
    ) {
      throw new Error('Expected finished tournament payloads');
    }
    expect(resultResponse.status).toBe(200);
    expect(bundleResponse.status).toBe(200);
    expect(resultPayload).toMatchObject({
      configHash: createPayload.tournament.configHash,
      horizonReveal: { secret, playerEntropy: entropy },
      turnCount: 0,
    });
    expect(bundlePayload).toMatchObject({
      config,
      tournament: { commitment, policyHash },
      horizonReveal: { secret, playerEntropy: entropy },
    });
    expect(JSON.stringify(bundlePayload.config)).not.toContain('mutated-config');
    expect(JSON.stringify(bundlePayload.tournament)).not.toContain(rootSeed);

    const sealed = structuredClone(store.values.get('tournamentCommitment'));
    if (!isRecord(sealed)) throw new Error('Expected sealed tournament record');
    const configInput = Reflect.get(sealed, 'configInput');
    if (!(configInput instanceof Uint8Array)) throw new Error('Expected encoded config input');
    const firstByte = configInput[0];
    if (firstByte === undefined) throw new Error('Expected non-empty encoded config input');
    configInput[0] = firstByte ^ 1;
    store.values.set('tournamentCommitment', sealed);

    const tamperedRoom = makeRoom(store);
    const tamperedResult = await result.call(tamperedRoom);
    expect(tamperedResult.status).toBe(409);
    const submissions: unknown[] = [];
    Object.assign(tamperedRoom, {
      getPluginRuntime: async () => ({
        handleCall: async () => {
          submissions.push('submitted');
        },
      }),
    });
    const kickOffSettlement = await handler('kickOffSettlement');
    await kickOffSettlement.call(tamperedRoom);
    expect(submissions).toEqual([]);
  });
});
