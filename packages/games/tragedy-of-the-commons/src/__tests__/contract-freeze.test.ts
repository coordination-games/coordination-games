import { describe, expect, it } from 'vitest';
import {
  TragedyOfTheCommonsPlugin,
  type TragedyOutcome,
  type TragedyPlayerRanking,
  type TragedyState,
} from '../index.js';

const PLAYER_IDS = ['gamma', 'alpha', 'beta'];

// RED exemption: this characterization suite intentionally starts GREEN against
// unchanged code; it records the public contract before later Tragedy refactors.
const computePayouts: (
  outcome: TragedyOutcome,
  playerIds: string[],
  entryCost: bigint,
) => Map<string, bigint> = TragedyOfTheCommonsPlugin.computePayouts;

function createState(maxRounds: number): TragedyState {
  const createConfig = TragedyOfTheCommonsPlugin.createConfig;
  if (!createConfig) throw new Error('expected Tragedy createConfig');
  const setup = createConfig(
    PLAYER_IDS.map((id) => ({ id, handle: id })),
    'tragedy-contract-freeze-seed',
    { maxRounds },
  );
  return TragedyOfTheCommonsPlugin.createInitialState(setup.config);
}

function startGame(state: TragedyState): TragedyState {
  return TragedyOfTheCommonsPlugin.applyAction(state, null, { type: 'game_start' }).state;
}

function passRound(state: TragedyState): TragedyState {
  return state.players.reduce(
    (current, player) =>
      TragedyOfTheCommonsPlugin.applyAction(current, player.id, { type: 'pass' }).state,
    state,
  );
}

function netPayoutSum(payouts: Map<string, bigint>): bigint {
  return [...payouts.values()].reduce((total, payout) => total + payout, 0n);
}

describe('Tragedy v0 public contract freeze', () => {
  it('keeps computePayouts zero-sum and assigns the whole healthy-commons pot to the canonical tied winner', () => {
    const payouts = computePayouts(
      {
        rankings: [
          { id: 'gamma', vp: 4, influence: 2 },
          { id: 'beta', vp: 4, influence: 2 },
          { id: 'alpha', vp: 4, influence: 2 },
        ],
        roundsPlayed: 12,
        flourishingEcosystems: 1,
        collapsedEcosystems: 0,
        commonsHealthPercent: 100,
      },
      PLAYER_IDS,
      10n,
    );

    expect([...payouts.entries()]).toEqual([
      ['gamma', -10n],
      ['alpha', 20n],
      ['beta', -10n],
    ]);
    expect(netPayoutSum(payouts)).toBe(0n);
  });

  it('keeps computePayouts zero-sum and returns every entry cost at the zero-health commons boundary', () => {
    const payouts = computePayouts(
      {
        rankings: [
          { id: 'alpha', vp: 3, influence: 0 },
          { id: 'beta', vp: 2, influence: 0 },
          { id: 'gamma', vp: 1, influence: 0 },
        ],
        roundsPlayed: 12,
        flourishingEcosystems: 0,
        collapsedEcosystems: 5,
        commonsHealthPercent: 0,
      },
      PLAYER_IDS,
      10n,
    );

    expect([...payouts.entries()]).toEqual([
      ['gamma', 0n],
      ['alpha', 0n],
      ['beta', 0n],
    ]);
    expect(netPayoutSum(payouts)).toBe(0n);
  });

  it('keeps computePayouts integer reserve rounding at the 33-percent commons-health boundary', () => {
    const payouts = computePayouts(
      {
        rankings: [
          { id: 'beta', vp: 1, influence: 1 },
          { id: 'alpha', vp: 2, influence: 0 },
          { id: 'gamma', vp: 1, influence: 0 },
        ],
        roundsPlayed: 12,
        flourishingEcosystems: 0,
        collapsedEcosystems: 2,
        commonsHealthPercent: 33,
      },
      PLAYER_IDS,
      10n,
    );

    expect([...payouts.entries()]).toEqual([
      ['gamma', -3n],
      ['alpha', 6n],
      ['beta', -3n],
    ]);
    expect(netPayoutSum(payouts)).toBe(0n);
  });

  it('keeps getOutcome keys, number-valued fields, alphabetical full-tie ranking, and initial commons summary', () => {
    const outcome = TragedyOfTheCommonsPlugin.getOutcome(startGame(createState(12)));

    expect(Object.keys(outcome).sort()).toEqual([
      'collapsedEcosystems',
      'commonsHealthPercent',
      'flourishingEcosystems',
      'rankings',
      'roundsPlayed',
    ]);
    expect(outcome).toEqual({
      rankings: [
        { id: 'alpha', vp: 1, influence: 0 },
        { id: 'beta', vp: 1, influence: 0 },
        { id: 'gamma', vp: 1, influence: 0 },
      ],
      roundsPlayed: 1,
      flourishingEcosystems: 1,
      collapsedEcosystems: 0,
      commonsHealthPercent: 69,
    });
    expect(typeof outcome.roundsPlayed).toBe('number');
    expect(typeof outcome.flourishingEcosystems).toBe('number');
    expect(typeof outcome.collapsedEcosystems).toBe('number');
    expect(typeof outcome.commonsHealthPercent).toBe('number');
    expect(
      outcome.rankings.every(
        ({ id, vp, influence }: TragedyPlayerRanking) =>
          typeof id === 'string' && typeof vp === 'number' && typeof influence === 'number',
      ),
    ).toBe(true);
  });

  it('keeps isOver false before and at maxRounds, then true only after the final round resolves', () => {
    const started = startGame(createState(2));
    const atRoundBoundary = passRound(started);
    const afterFinalResolution = passRound(atRoundBoundary);

    expect(started).toMatchObject({ round: 1, phase: 'playing' });
    expect(TragedyOfTheCommonsPlugin.isOver(started)).toBe(false);
    expect(atRoundBoundary).toMatchObject({ round: 2, phase: 'playing' });
    expect(TragedyOfTheCommonsPlugin.isOver(atRoundBoundary)).toBe(false);
    expect(afterFinalResolution).toMatchObject({ round: 2, phase: 'finished' });
    expect(TragedyOfTheCommonsPlugin.isOver(afterFinalResolution)).toBe(true);
  });
});
