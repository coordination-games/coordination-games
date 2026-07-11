import {
  computeHorizonCommitment,
  computeTournamentPolicyHash,
  createHiddenHorizonPublicConfig,
  createTournamentCommitment,
  deriveTournamentGameSeed,
  parseBytes32Hex,
  revealTournamentHorizon,
  type TournamentCommitmentRecord,
  verifyTournamentCommitment,
} from '@coordination-games/engine';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictLocalRelay } from '../chain/strict-local-relay.js';
import { ServerPluginRuntime } from '../plugins/runtime.js';
import { createSettlementPlugin, SETTLEMENT_PLUGIN_ID } from '../plugins/settlement/index.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

type SettlementDelta = { readonly agentId: string; readonly delta: bigint };
type SubmittedPayload = {
  readonly playerIds: string[];
  readonly deltas: readonly SettlementDelta[];
  readonly configHash?: string;
  readonly turnCount?: number;
  readonly horizonReveal?: {
    readonly secret: string;
    readonly playerEntropy: string;
  };
};
type TournamentRecord = TournamentCommitmentRecord;
type TreasuryRow = { readonly id: string; readonly chain_agent_id: number | null };
type PreparedLookup = {
  bind: (...values: string[]) => { first: () => Promise<TreasuryRow | null> };
};
type SettlementHarness = {
  readonly _plugin: {
    readonly entryCost: bigint;
    getOutcome: (state: unknown) => unknown;
    computePayouts: (
      outcome: unknown,
      playerIds: string[],
      entryCost: bigint,
    ) => Map<string, bigint>;
  };
  readonly _meta: {
    readonly gameId: string;
    readonly gameType: string;
    readonly playerIds: string[];
    readonly handleMap: Record<string, string>;
    readonly teamMap: Record<string, string>;
    readonly createdAt: string;
  };
  readonly _state: unknown;
  readonly _actionLog: readonly unknown[];
  readonly _configHash?: string;
  readonly _tournamentCommitment?: TournamentRecord;
  buildSettlementArtifact: () => {
    readonly outcome: unknown;
    readonly movesRoot: `0x${string}`;
    readonly configHash: string;
    readonly turnCount: number;
    readonly horizonReveal?: { readonly secret: string; readonly playerEntropy: string };
  };
  readonly env: {
    readonly TREASURY_AGENT_HANDLE?: string;
    readonly DB: { prepare: (sql: string) => PreparedLookup };
  };
  getPluginRuntime: () => Promise<{
    handleCall: (
      pluginId: string,
      name: string,
      payload: unknown,
      viewer: unknown,
    ) => Promise<void>;
  }>;
};
type KickOffSettlement = (this: SettlementHarness) => Promise<void>;

let GameRoomDO: { readonly prototype: object };

async function getKickOffSettlement(): Promise<KickOffSettlement> {
  if (GameRoomDO === undefined) {
    ({ GameRoomDO } = await import('./GameRoomDO.js'));
  }
  const descriptor = Object.getOwnPropertyDescriptor(GameRoomDO.prototype, 'kickOffSettlement');
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new Error('GameRoomDO.kickOffSettlement is unavailable');
  }
  const kickOffSettlement: KickOffSettlement = descriptor.value;
  return kickOffSettlement;
}

function buildHarness(input: {
  readonly treasuryHandle?: string;
  readonly treasuryRow: TreasuryRow | null;
  readonly tournament?: TournamentRecord;
}): {
  readonly harness: SettlementHarness;
  readonly submitted: SubmittedPayload[];
  readonly computeInputs: string[][];
  readonly computeEntryCosts: bigint[];
} {
  const submitted: SubmittedPayload[] = [];
  const computeInputs: string[][] = [];
  const computeEntryCosts: bigint[] = [];
  const players = ['player-a', 'player-b'];
  const outcome =
    input.tournament === undefined
      ? { winner: 'player-a' }
      : { roundsPlayed: 4, winner: 'player-a' };
  const harness: SettlementHarness = {
    _plugin: {
      entryCost: 100n,
      getOutcome: () => outcome,
      computePayouts: (_outcome, playerIds, entryCost) => {
        computeInputs.push([...playerIds]);
        computeEntryCosts.push(entryCost);
        return new Map([
          ['player-a', 75n],
          ['player-b', -75n],
        ]);
      },
    },
    _meta: {
      gameId: 'game-room-settlement-test',
      gameType: 'tragedy-of-the-commons',
      playerIds: players,
      handleMap: { 'player-a': 'alpha', 'player-b': 'beta' },
      teamMap: { 'player-a': 'player-a', 'player-b': 'player-b' },
      createdAt: '2026-07-11T00:00:00.000Z',
    },
    _state: { finished: true },
    _actionLog: [],
    ...(input.tournament === undefined
      ? {}
      : { _configHash: input.tournament.t0ConfigHash, _tournamentCommitment: input.tournament }),
    buildSettlementArtifact: () => {
      if (input.tournament === undefined) {
        return {
          outcome,
          movesRoot: `0x${'00'.repeat(32)}`,
          configHash: parseBytes32Hex(`0x${'66'.repeat(32)}`),
          turnCount: 0,
        };
      }
      if (!verifyTournamentCommitment(input.tournament).ok) {
        throw new Error('Tournament commitment verification failed');
      }
      return {
        outcome,
        movesRoot: `0x${'00'.repeat(32)}`,
        configHash: input.tournament.t0ConfigHash,
        turnCount: 4,
        horizonReveal: revealTournamentHorizon(input.tournament),
      };
    },
    env: {
      ...(input.treasuryHandle === undefined
        ? {}
        : { TREASURY_AGENT_HANDLE: input.treasuryHandle }),
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => input.treasuryRow }),
        }),
      },
    },
    getPluginRuntime: async () => ({
      handleCall: async (_pluginId, name, payload) => {
        if (name !== 'submit' || !isSubmittedPayload(payload)) {
          throw new Error('Expected settlement submit payload');
        }
        submitted.push(payload);
      },
    }),
  };
  return { harness, submitted, computeInputs, computeEntryCosts };
}

function isSubmittedPayload(value: unknown): value is SubmittedPayload {
  if (!isRecord(value)) return false;
  return Array.isArray(value.playerIds) && Array.isArray(value.deltas);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GameRoomDO.kickOffSettlement treasury wiring', () => {
  it('Given no treasury configuration, when GameRoomDO settles, then it submits the unchanged playing roster and deltas', async () => {
    const { harness, submitted, computeInputs } = buildHarness({ treasuryRow: null });
    const kickOffSettlement = await getKickOffSettlement();

    await kickOffSettlement.call(harness);

    expect(computeInputs).toEqual([['player-a', 'player-b']]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      playerIds: ['player-a', 'player-b'],
      deltas: [
        { agentId: 'player-a', delta: 75n },
        { agentId: 'player-b', delta: -75n },
      ],
    });
  });

  it('Given a registered configured treasury, when GameRoomDO settles, then it appends the treasury only to the aligned settlement payload', async () => {
    const { harness, submitted, computeInputs } = buildHarness({
      treasuryHandle: 'tournament-treasury',
      treasuryRow: { id: 'treasury-id', chain_agent_id: 303 },
    });
    const kickOffSettlement = await getKickOffSettlement();

    await kickOffSettlement.call(harness);

    expect(computeInputs).toEqual([['player-a', 'player-b']]);
    expect(harness._meta.playerIds).toEqual(['player-a', 'player-b']);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      playerIds: ['player-a', 'player-b', 'treasury-id'],
      deltas: [
        { agentId: 'player-a', delta: 75n },
        { agentId: 'player-b', delta: -75n },
        { agentId: 'treasury-id', delta: 0n },
      ],
    });
    const payload = submitted[0];
    if (payload === undefined) throw new Error('Expected one submitted payload');
    expect(payload.playerIds).toHaveLength(payload.deltas.length);
    expect(payload.deltas.reduce((sum, delta) => sum + delta.delta, 0n)).toBe(0n);
  });

  it.each([
    ['missing row', null, 'configured treasury handle "tournament-treasury" has no players row'],
    [
      'null chain agent identity',
      { id: 'treasury-id', chain_agent_id: null },
      'configured treasury handle "tournament-treasury" has no chain_agent_id',
    ],
  ] as const)('Given a configured treasury with %s, when GameRoomDO settles, then it logs and never submits', async (_caseName, treasuryRow, reason) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { harness, submitted } = buildHarness({
      treasuryHandle: 'tournament-treasury',
      treasuryRow,
    });
    const kickOffSettlement = await getKickOffSettlement();

    await kickOffSettlement.call(harness);

    expect(submitted).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(`[settle game-room-settlement-test] skip: ${reason}`);
  });
});

describe('GameRoomDO.kickOffSettlement tournament commitment wiring', () => {
  const rootSeed = parseBytes32Hex(`0x${'20'.repeat(32)}`);
  const secret = parseBytes32Hex(`0x${'22'.repeat(32)}`);
  const entropy = parseBytes32Hex(`0x${'33'.repeat(32)}`);
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
  const commitment = computeHorizonCommitment({
    secret,
    gameId: 'game-room-settlement-test',
    playerEntropy: entropy,
    policyHash,
  });
  const record = createTournamentCommitment({
    context: {
      tournamentRootSeed: rootSeed,
      gameSeed: deriveTournamentGameSeed(rootSeed, 'tournament-settlement', 0),
      tournamentId: 'tournament-settlement',
      gameIndex: 0,
      policy,
      economics: {
        baseEntryCost: 100n,
        entryCost: 100n,
        playerCount: 2,
        basePot: 200n,
        incomingCarry: 0n,
        releasedCarry: 0n,
        carryRemainder: 0n,
        carry: 0n,
        slash: 0n,
        treasuryDelta: 0n,
      },
      horizonSecret: secret,
      playerEntropy: entropy,
    },
    gameId: 'game-room-settlement-test',
    gameType: 'tragedy-of-the-commons',
    playerIds: ['player-a', 'player-b'],
    gameConfig: {
      finished: true,
      hiddenHorizon: createHiddenHorizonPublicConfig(commitment, policy),
      tournamentEconomics: { entryCost: '100' },
    },
  });

  const escalatedRecord = createTournamentCommitment({
    context: {
      tournamentRootSeed: rootSeed,
      gameSeed: deriveTournamentGameSeed(rootSeed, 'tournament-settlement', 0),
      tournamentId: 'tournament-settlement',
      gameIndex: 0,
      policy,
      economics: {
        baseEntryCost: 100n,
        entryCost: 103n,
        playerCount: 2,
        basePot: 206n,
        incomingCarry: 6n,
        releasedCarry: 6n,
        carryRemainder: 0n,
        carry: 0n,
        slash: 0n,
        treasuryDelta: -6n,
      },
      horizonSecret: secret,
      playerEntropy: entropy,
    },
    gameId: 'game-room-settlement-test',
    gameType: 'tragedy-of-the-commons',
    playerIds: ['player-a', 'player-b'],
    gameConfig: {
      finished: true,
      hiddenHorizon: createHiddenHorizonPublicConfig(commitment, policy),
      tournamentEconomics: { entryCost: '103' },
    },
  });

  const carryPolicy = { ...policy, carryBps: 2_000, slashBps: 500 };
  const carryCommitment = computeHorizonCommitment({
    secret,
    gameId: 'game-room-settlement-test',
    playerEntropy: entropy,
    policyHash: computeTournamentPolicyHash(carryPolicy),
  });
  const carryRecord = createTournamentCommitment({
    context: {
      tournamentRootSeed: rootSeed,
      gameSeed: deriveTournamentGameSeed(rootSeed, 'tournament-settlement', 0),
      tournamentId: 'tournament-settlement',
      gameIndex: 0,
      policy: carryPolicy,
      economics: {
        baseEntryCost: 100n,
        entryCost: 100n,
        playerCount: 2,
        basePot: 200n,
        incomingCarry: 0n,
        releasedCarry: 0n,
        carryRemainder: 0n,
        carry: 40n,
        slash: 10n,
        treasuryDelta: 50n,
      },
      horizonSecret: secret,
      playerEntropy: entropy,
    },
    gameId: 'game-room-settlement-test',
    gameType: 'tragedy-of-the-commons',
    playerIds: ['player-a', 'player-b'],
    gameConfig: {
      finished: true,
      hiddenHorizon: createHiddenHorizonPublicConfig(carryCommitment, carryPolicy),
      tournamentEconomics: { entryCost: '100' },
    },
  });

  it('Given a verified tournament record, when settling, then it uses the frozen hash, separate reveal, and actual rounds', async () => {
    const { harness, submitted } = buildHarness({
      treasuryHandle: 'tournament-treasury',
      treasuryRow: { id: 'treasury-id', chain_agent_id: 303 },
      tournament: record,
    });
    const kickOffSettlement = await getKickOffSettlement();

    await kickOffSettlement.call(harness);

    expect(submitted).toEqual([
      expect.objectContaining({
        configHash: record.t0ConfigHash,
        turnCount: 4,
        horizonReveal: {
          secret: record.horizonSecret,
          playerEntropy: record.playerEntropy,
        },
      }),
    ]);
  });

  it('Given a frozen escalated tournament cost, when settling, then computePayouts and its floor use that sealed value', async () => {
    // Given
    const { harness, submitted, computeEntryCosts } = buildHarness({
      treasuryHandle: 'tournament-treasury',
      treasuryRow: { id: 'treasury-id', chain_agent_id: 303 },
      tournament: escalatedRecord,
    });
    const kickOffSettlement = await getKickOffSettlement();

    // When
    await kickOffSettlement.call(harness);

    // Then
    expect(computeEntryCosts).toEqual([103n]);
    expect(submitted).toHaveLength(1);
  });

  it('Given carry and slash withholding, when a tournament game settles, then treasury receives both plus the exact allocation residual', async () => {
    // Given
    const { harness, submitted } = buildHarness({
      treasuryHandle: 'tournament-treasury',
      treasuryRow: { id: 'treasury-id', chain_agent_id: 303 },
      tournament: carryRecord,
    });
    const kickOffSettlement = await getKickOffSettlement();

    // When
    await kickOffSettlement.call(harness);

    // Then
    const payload = submitted[0];
    if (payload === undefined) throw new Error('Expected tournament settlement payload');
    expect(payload.deltas).toContainEqual({ agentId: 'treasury-id', delta: 51n });
    expect(payload.deltas.reduce((sum, delta) => sum + delta.delta, 0n)).toBe(0n);
  });

  it('Given a tampered exact commitment input, when settling, then it fails closed before submission', async () => {
    const tampered: TournamentRecord = {
      ...record,
      commitmentInput: Uint8Array.of(9, 2, 3),
    };
    const { harness, submitted } = buildHarness({ treasuryRow: null, tournament: tampered });
    const kickOffSettlement = await getKickOffSettlement();

    await kickOffSettlement.call(harness);

    expect(submitted).toHaveLength(0);
  });

  it('Given strict local relay mode, when GameRoom kicks off tournament settlement through the plugin, then confirms and persists its receipt', async () => {
    const miniflare = new Miniflare({
      compatibilityDate: '2025-01-01',
      d1Databases: ['DB'],
      modules: true,
      script: 'export default { fetch() { return new Response(); } };',
    });
    try {
      const db = await miniflare.getD1Database('DB');
      await db.exec(
        'CREATE TABLE players (id TEXT PRIMARY KEY, wallet_address TEXT NOT NULL UNIQUE, handle TEXT NOT NULL UNIQUE, chain_agent_id INTEGER, elo INTEGER NOT NULL, games_played INTEGER NOT NULL, wins INTEGER NOT NULL, created_at TEXT NOT NULL)',
      );
      for (const [id, handle, chainAgentId] of [
        ['player-a', 'alpha', 1],
        ['player-b', 'beta', 2],
        ['treasury-id', 'tournament-treasury', 3],
      ] as const) {
        await db
          .prepare(
            'INSERT INTO players (id, wallet_address, handle, chain_agent_id, elo, games_played, wins, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)',
          )
          .bind(
            id,
            `0x${chainAgentId.toString().padStart(40, '0')}`,
            handle,
            chainAgentId,
            '2026-07-11',
          )
          .run();
      }
      const values = new Map<string, unknown>();
      const relay = new StrictLocalRelay(db, 'tournament-treasury');
      const runtime = new ServerPluginRuntime(
        {
          storage: {
            get: async <T>(key: string) => values.get(key) as T | undefined,
            put: async <T>(key: string, value: T) => void values.set(key, value),
            delete: async (key: string) => values.delete(key),
            list: async <T>() => new Map<string, T>(),
          },
          relay: {
            publish: async () => undefined,
            visibleTo: async () => [],
            since: async () => [],
            getTip: async () => 0,
          },
          alarms: { scheduleAt: async () => undefined, cancel: async () => undefined },
          d1: db,
          chain: relay,
        },
        { gameId: 'game-room-settlement-test' },
      );
      await runtime.register(createSettlementPlugin());
      const { harness } = buildHarness({
        treasuryHandle: 'tournament-treasury',
        treasuryRow: { id: 'treasury-id', chain_agent_id: 3 },
        tournament: record,
      });
      Object.assign(harness, {
        env: {
          DB: db,
          TREASURY_AGENT_HANDLE: 'tournament-treasury',
          STRICT_LOCAL_SETTLEMENT: 'true',
        },
        getPluginRuntime: async () => runtime,
      });
      const kickOffSettlement = await getKickOffSettlement();

      await kickOffSettlement.call(harness);
      await runtime.handleAlarm(SETTLEMENT_PLUGIN_ID);
      const result = await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'state', {}, { kind: 'admin' });

      expect(result).toMatchObject({ state: { kind: 'confirmed', blockNumber: 1 } });
      if (!isRecord(result) || !isRecord(result.state) || typeof result.state.txHash !== 'string') {
        throw new Error('Expected confirmed settlement receipt');
      }
      expect(
        await db
          .prepare('SELECT tx_hash FROM strict_local_settlement_receipts WHERE tx_hash = ?')
          .bind(result.state.txHash)
          .first(),
      ).not.toBeNull();
    } finally {
      await miniflare.dispose();
    }
  });
});
