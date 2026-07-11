import { describe, expect, it } from 'vitest';
import {
  createSeries,
  onGameSettled,
  parseBytes32Hex,
  type TournamentPolicy,
  type TournamentSeriesConfig,
  TournamentSeriesError,
} from '../index.js';

const ROOT_SEED = parseBytes32Hex(`0x${'11'.repeat(32)}`);
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

describe('TournamentSeries validation', () => {
  it.each([
    [{ ...CONFIG, tournamentId: '' }, 'tournamentId'],
    [{ ...CONFIG, gameType: '' }, 'gameType'],
    [{ ...CONFIG, playerIds: [] }, 'playerIds'],
    [{ ...CONFIG, playerIds: ['alpha', ''] }, 'playerIds'],
    [{ ...CONFIG, playerIds: ['alpha', 'alpha'] }, 'playerIds'],
    [{ ...CONFIG, policy: { ...POLICY, seriesLength: 0 } }, 'seriesLength'],
  ])('rejects invalid series config %#', (config, field) => {
    expect(() => createSeries(config, ROOT_SEED)).toThrow(field);
  });

  it.each([
    [
      { gameId: 'game-0', gameIndex: 1 },
      payoutMap(CONFIG.playerIds.map((playerId) => [playerId, 0n])),
      'gameIndex',
    ],
    [
      { gameId: '', gameIndex: 0 },
      payoutMap(CONFIG.playerIds.map((playerId) => [playerId, 0n])),
      'gameId',
    ],
    [
      { gameId: 'game-0', gameIndex: 0 },
      payoutMap([
        ['alpha', 0n],
        ['bravo', 0n],
      ]),
      'payouts',
    ],
    [
      { gameId: 'game-0', gameIndex: 0 },
      payoutMap([...CONFIG.playerIds.map((playerId) => [playerId, 0n] as const), ['unknown', 0n]]),
      'payouts',
    ],
    [
      { gameId: 'game-0', gameIndex: 0 },
      payoutMap(CONFIG.playerIds.map((playerId) => [playerId, playerId === 'alpha' ? 0 : 0n])),
      'payouts',
    ],
  ])('rejects invalid settlement %#', (outcome, payouts, field) => {
    const { series } = createSeries(CONFIG, ROOT_SEED);
    expect(() => onGameSettled(series, outcome, payouts)).toThrow(field);
    expect(() => onGameSettled(series, outcome, payouts)).toThrow(TournamentSeriesError);
  });

  it('rejects duplicate game IDs and settlement after series completion', () => {
    // Given
    const initial = createSeries(CONFIG, ROOT_SEED);
    const zeroPayouts = payoutMap(CONFIG.playerIds.map((playerId) => [playerId, 0n]));
    const first = onGameSettled(initial.series, { gameId: 'duplicate', gameIndex: 0 }, zeroPayouts);

    // When / Then
    expect(() =>
      onGameSettled(first.series, { gameId: 'duplicate', gameIndex: 1 }, zeroPayouts),
    ).toThrow('gameId');
    const final = onGameSettled(first.series, { gameId: 'game-1', gameIndex: 1 }, zeroPayouts);
    expect(() =>
      onGameSettled(final.series, { gameId: 'game-2', gameIndex: 2 }, zeroPayouts),
    ).toThrow('complete');
  });
});
