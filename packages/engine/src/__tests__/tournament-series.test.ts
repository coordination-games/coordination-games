import { describe, expect, it } from 'vitest';
import {
  computeTournamentConfigHash,
  computeTournamentPolicyHash,
  createSeries,
  deriveGameSeed,
  deriveTournamentGameSeed,
  onGameSettled,
  parseBytes32Hex,
  type TournamentPolicy,
  type TournamentSeriesConfig,
} from '../index.js';

const ROOT_SEED = parseBytes32Hex(`0x${'11'.repeat(32)}`);
const OTHER_ROOT_SEED = parseBytes32Hex(`0x${'22'.repeat(32)}`);
const HORIZON_COMMITMENT = parseBytes32Hex(`0x${'33'.repeat(32)}`);
const POLICY: TournamentPolicy = {
  seriesLength: 2,
  baseEntryCost: 10_000_000n,
  carryBps: 2_000,
  slashBps: 500,
  minRounds: 2,
  maxRounds: 10,
  hazardNumerator: 1,
  hazardDenominator: 5,
};
const CONFIG: TournamentSeriesConfig = {
  tournamentId: 'tragedy-finals',
  gameType: 'tragedy-of-the-commons/v2',
  playerIds: ['charlie', 'alpha', 'bravo'],
  policy: POLICY,
};

function payoutMap(
  entries: readonly (readonly [playerId: string, delta: unknown])[],
): ReadonlyMap<string, unknown> {
  return new Map(entries);
}

describe('TournamentSeries', () => {
  it('creates immutable replayable state and a seed-pinned game-0 config', () => {
    // Given
    const configPlayers = [...CONFIG.playerIds];

    // When
    const first = createSeries(CONFIG, ROOT_SEED);
    const replay = createSeries(CONFIG, ROOT_SEED);

    // Then
    expect(first).toEqual(replay);
    expect(first.series).toEqual({
      tournamentId: CONFIG.tournamentId,
      gameType: CONFIG.gameType,
      playerIds: CONFIG.playerIds,
      activePlayerIds: CONFIG.playerIds,
      policy: POLICY,
      policyHash: computeTournamentPolicyHash(POLICY),
      tournamentRootSeed: ROOT_SEED,
      currentGameIndex: 0,
      settledGameIds: [],
      standings: [
        { playerId: 'alpha', cumulativeDelta: 0n, gamesPlayed: 0 },
        { playerId: 'bravo', cumulativeDelta: 0n, gamesPlayed: 0 },
        { playerId: 'charlie', cumulativeDelta: 0n, gamesPlayed: 0 },
      ],
      treasuryCarry: 0n,
    });
    expect(first.gameConfig).toEqual({
      tournamentId: CONFIG.tournamentId,
      gameIndex: 0,
      gameType: CONFIG.gameType,
      playerIds: CONFIG.playerIds,
      tournamentRootSeed: ROOT_SEED,
      gameSeed: deriveTournamentGameSeed(ROOT_SEED, CONFIG.tournamentId, 0),
      policyHash: computeTournamentPolicyHash(POLICY),
      baseEntryCost: POLICY.baseEntryCost,
      incomingCarry: 0n,
      entryCost: POLICY.baseEntryCost,
      incomingCarryPlan: null,
    });
    expect(Object.isFrozen(first.series)).toBe(true);
    expect(Object.isFrozen(first.series.playerIds)).toBe(true);
    expect(Object.isFrozen(first.series.policy)).toBe(true);
    expect(Object.isFrozen(first.series.standings)).toBe(true);
    expect(CONFIG.playerIds).toEqual(configPlayers);
  });

  it('settles two games, accumulates sorted standings, and terminates with an auditable plan', () => {
    // Given
    const initial = createSeries(CONFIG, ROOT_SEED);

    // When
    const first = onGameSettled(
      initial.series,
      { gameId: 'game-0', gameIndex: 0 },
      payoutMap([
        ['bravo', 5n],
        ['charlie', -2n],
        ['alpha', 5n],
      ]),
    );
    const second = onGameSettled(
      first.series,
      { gameId: 'game-1', gameIndex: 1 },
      payoutMap([
        ['charlie', 10n],
        ['alpha', -4n],
        ['bravo', 0n],
      ]),
    );

    // Then
    expect(first.standings).toEqual([
      { playerId: 'alpha', cumulativeDelta: 5n, gamesPlayed: 1 },
      { playerId: 'bravo', cumulativeDelta: 5n, gamesPlayed: 1 },
      { playerId: 'charlie', cumulativeDelta: -2n, gamesPlayed: 1 },
    ]);
    expect(first.carryPlan).toEqual({
      fromGameIndex: 0,
      toGameIndex: 1,
      carryBps: POLICY.carryBps,
      slashBps: POLICY.slashBps,
      baseEntryCost: POLICY.baseEntryCost,
      playerCount: CONFIG.playerIds.length,
      incomingCarry: 0n,
      releasedCarry: 0n,
      carryRemainder: 0n,
      carry: 6_000_000n,
    });
    expect(first.nextGameConfig?.incomingCarryPlan).toEqual(first.carryPlan);
    expect(first.nextGameConfig?.tournamentRootSeed).toBe(ROOT_SEED);
    expect(second.standings).toEqual([
      { playerId: 'charlie', cumulativeDelta: 8n, gamesPlayed: 2 },
      { playerId: 'bravo', cumulativeDelta: 5n, gamesPlayed: 2 },
      { playerId: 'alpha', cumulativeDelta: 1n, gamesPlayed: 2 },
    ]);
    expect(second.nextGameConfig).toBeNull();
    expect(second.carryPlan).toEqual({
      fromGameIndex: 1,
      toGameIndex: null,
      carryBps: POLICY.carryBps,
      slashBps: POLICY.slashBps,
      baseEntryCost: POLICY.baseEntryCost,
      playerCount: CONFIG.playerIds.length,
      incomingCarry: 6_000_000n,
      releasedCarry: 6_000_000n,
      carryRemainder: 0n,
      carry: 7_200_000n,
    });
  });

  it('Given a carry-producing game, when the next config is created, then it freezes the treasury-funded escalated entry cost', () => {
    // Given
    const initial = createSeries(CONFIG, ROOT_SEED);

    // When
    const settled = onGameSettled(
      initial.series,
      { gameId: 'game-0', gameIndex: 0 },
      payoutMap([
        ['alpha', 10n],
        ['bravo', -5n],
        ['charlie', -5n],
      ]),
    );

    // Then
    expect(initial.gameConfig.entryCost).toBe(POLICY.baseEntryCost);
    expect(settled.nextGameConfig?.incomingCarry).toBe(6_000_000n);
    expect(settled.nextGameConfig?.entryCost).toBe(12_000_000n);
  });

  it('removes eliminated players only after their settled game and carries survivors forward', () => {
    // Given
    const initial = createSeries(CONFIG, ROOT_SEED);

    // When
    const settled = onGameSettled(
      initial.series,
      { gameId: 'game-0', gameIndex: 0 },
      payoutMap([
        ['alpha', 5n],
        ['bravo', 0n],
        ['charlie', -5n],
      ]),
      ['charlie'],
    );

    // Then
    expect(settled.series.activePlayerIds).toEqual(['alpha', 'bravo']);
    expect(settled.series.standings).toEqual([
      { playerId: 'alpha', cumulativeDelta: 5n, gamesPlayed: 1 },
      { playerId: 'bravo', cumulativeDelta: 0n, gamesPlayed: 1 },
      { playerId: 'charlie', cumulativeDelta: -5n, gamesPlayed: 1 },
    ]);
    expect(settled.carryPlan.playerCount).toBe(3);
    expect(settled.nextGameConfig?.playerIds).toEqual(['alpha', 'bravo']);
  });

  it('is deeply replayable and independent of payout-map insertion order', () => {
    // Given
    const settle = (entries: readonly (readonly [string, unknown])[]) => {
      const initial = createSeries(CONFIG, ROOT_SEED);
      return onGameSettled(initial.series, { gameId: 'game-0', gameIndex: 0 }, payoutMap(entries));
    };

    // When
    const first = settle([
      ['alpha', 3n],
      ['bravo', 1n],
      ['charlie', -4n],
    ]);
    const replay = settle([
      ['charlie', -4n],
      ['alpha', 3n],
      ['bravo', 1n],
    ]);

    // Then
    expect(first).toEqual(replay);
  });

  it('does not mutate prior series, config, outcome, or payouts', () => {
    // Given
    const initial = createSeries(CONFIG, ROOT_SEED);
    const outcome = { gameId: 'game-0', gameIndex: 0 };
    const payouts = payoutMap([
      ['alpha', 1n],
      ['bravo', 2n],
      ['charlie', 3n],
    ]);

    // When
    const settled = onGameSettled(initial.series, outcome, payouts);

    // Then
    expect(initial.series.currentGameIndex).toBe(0);
    expect(initial.series.settledGameIds).toEqual([]);
    expect(initial.series.standings.every((standing) => standing.gamesPlayed === 0)).toBe(true);
    expect(outcome).toEqual({ gameId: 'game-0', gameIndex: 0 });
    expect([...payouts.entries()]).toEqual([
      ['alpha', 1n],
      ['bravo', 2n],
      ['charlie', 3n],
    ]);
    expect(settled.series).not.toBe(initial.series);
    expect(settled.series.standings).not.toBe(initial.series.standings);
    expect(Object.isFrozen(settled.series)).toBe(true);
    expect(Object.isFrozen(settled.carryPlan)).toBe(true);
  });

  it('delegates game seeds to the pinned encoder and separates root seeds and indices', () => {
    // Given
    const tournamentId = CONFIG.tournamentId;

    // When
    const first = deriveGameSeed(ROOT_SEED, tournamentId, 0);

    // Then
    expect(first).toBe(deriveTournamentGameSeed(ROOT_SEED, tournamentId, 0));
    expect(deriveGameSeed(ROOT_SEED, tournamentId, 0)).toBe(first);
    expect(deriveGameSeed(ROOT_SEED, tournamentId, 1)).not.toBe(first);
    expect(deriveGameSeed(OTHER_ROOT_SEED, tournamentId, 0)).not.toBe(first);
  });

  it('carries the root seed into Task 4 config hashing', () => {
    // Given
    const firstSeries = createSeries(CONFIG, ROOT_SEED);
    const otherSeries = createSeries(CONFIG, OTHER_ROOT_SEED);

    // When
    const first = onGameSettled(
      firstSeries.series,
      { gameId: 'game-0', gameIndex: 0 },
      payoutMap(CONFIG.playerIds.map((playerId) => [playerId, 0n])),
    );
    const other = onGameSettled(
      otherSeries.series,
      { gameId: 'game-0', gameIndex: 0 },
      payoutMap(CONFIG.playerIds.map((playerId) => [playerId, 0n])),
    );
    const firstNext = first.nextGameConfig;
    const otherNext = other.nextGameConfig;

    // Then
    expect(firstNext).not.toBeNull();
    expect(otherNext).not.toBeNull();
    if (firstNext === null || otherNext === null) return;
    const fixture = {
      gameId: 'game-1',
      horizonCommitment: HORIZON_COMMITMENT,
      gameConfig: { commitmentVersion: 1 },
    } as const;
    expect(
      computeTournamentConfigHash({
        ...firstNext,
        ...fixture,
      }),
    ).not.toBe(
      computeTournamentConfigHash({
        ...otherNext,
        ...fixture,
      }),
    );
  });
});
