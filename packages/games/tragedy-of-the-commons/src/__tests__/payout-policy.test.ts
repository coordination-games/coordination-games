import { describe, expect, it } from 'vitest';
import {
  TragedyOfTheCommonsPlugin,
  type TragedyOutcome,
  type TragedyPlayerRanking,
} from '../index.js';

const RANKINGS: readonly TragedyPlayerRanking[] = [
  { id: 'alpha', vp: 4, influence: 0 },
  { id: 'beta', vp: 3, influence: 0 },
  { id: 'gamma', vp: 2, influence: 0 },
  { id: 'delta', vp: 1, influence: 0 },
];

function outcome(
  commonsHealthPercent: number,
  rankings: readonly TragedyPlayerRanking[] = RANKINGS,
): TragedyOutcome {
  return {
    rankings: [...rankings],
    roundsPlayed: 12,
    flourishingEcosystems: 1,
    collapsedEcosystems: 0,
    commonsHealthPercent,
  };
}

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

describe('Tragedy v0 carry-safe payout policy', () => {
  it.each([
    { health: 0, expected: [0n, 0n, 0n, 0n] },
    { health: 50, expected: [2n, 1n, -1n, -2n] },
    { health: 100, expected: [3n, 1n, -1n, -3n] },
  ])('bounds the competitive pool at health $health', ({ health, expected }) => {
    // Given: four distinct rankings and a selected commons-health boundary.
    const ids = ['alpha', 'beta', 'gamma', 'delta'];

    // When: the pot is split into reserve and competitive pools.
    const payouts = TragedyOfTheCommonsPlugin.computePayouts(outcome(health), ids, 10n);

    // Then: floor(pot * health / 200) produces the expected zero-sum deltas.
    expect([...payouts.values()]).toEqual(expected);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('clamps integer health below zero and above one hundred', () => {
    // Given: valid rankings with health outside the supported range.
    const ids = ['alpha', 'beta', 'gamma', 'delta'];

    // When: payouts are computed at both extremes.
    const below = TragedyOfTheCommonsPlugin.computePayouts(outcome(-20), ids, 10n);
    const above = TragedyOfTheCommonsPlugin.computePayouts(outcome(140), ids, 10n);

    // Then: the values match the zero and one-hundred health boundaries.
    expect([...below.values()]).toEqual([0n, 0n, 0n, 0n]);
    expect([...above.values()]).toEqual([3n, 1n, -1n, -3n]);
  });

  it('assigns non-divisible reserve and competitive remainders deterministically', () => {
    // Given: three players, a fifteen-unit pot, and a healthy commons.
    const ids = ['gamma', 'alpha', 'beta'];
    const rankings = [
      { id: 'alpha', vp: 3, influence: 0 },
      { id: 'beta', vp: 2, influence: 0 },
      { id: 'gamma', vp: 1, influence: 0 },
    ];

    // When: eight reserve units and seven competitive units are distributed.
    const payouts = TragedyOfTheCommonsPlugin.computePayouts(outcome(100, rankings), ids, 5n);

    // Then: alphabetical reserve remainder and rank-order group remainder conserve the pot.
    expect([...payouts.entries()]).toEqual([
      ['gamma', -2n],
      ['alpha', 2n],
      ['beta', 0n],
    ]);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('keeps values invariant while preserving caller Map insertion order', () => {
    // Given: the same players and ranking in different input orders.
    const firstIds = ['gamma', 'alpha', 'delta', 'beta'];
    const secondIds = ['beta', 'delta', 'alpha', 'gamma'];
    const reversedRankings = [...RANKINGS].reverse();

    // When: both permutations are paid from the same healthy pot.
    const first = TragedyOfTheCommonsPlugin.computePayouts(outcome(100), firstIds, 10n);
    const second = TragedyOfTheCommonsPlugin.computePayouts(
      outcome(100, reversedRankings),
      secondIds,
      10n,
    );

    // Then: values are identical by id and each Map follows its caller order exactly once.
    expect([...first.keys()]).toEqual(firstIds);
    expect([...second.keys()]).toEqual(secondIds);
    expect(first.size).toBe(firstIds.length);
    for (const id of firstIds) expect(first.get(id)).toBe(second.get(id));
  });

  it('makes a full score and influence tie equal after indivisible pool remainders', () => {
    // Given: four exact ties where reserve and competitive pools are separately indivisible.
    const ids = ['delta', 'beta', 'alpha', 'gamma'];
    const tied = ids.map((id) => ({ id, vp: 2, influence: 3 }));

    // When: a half-health pot is distributed.
    const payouts = TragedyOfTheCommonsPlugin.computePayouts(outcome(50, tied), ids, 10n);

    // Then: competitive remainders offset reserve remainders and every net delta is equal.
    expect([...payouts.entries()]).toEqual([
      ['delta', 0n],
      ['beta', 0n],
      ['alpha', 0n],
      ['gamma', 0n],
    ]);
  });

  it('shares a partial tie fairly and gives its odd unit alphabetically', () => {
    // Given: alpha and beta tied across the top two occupied positions.
    const ids = ['delta', 'beta', 'alpha', 'gamma'];
    const rankings = [
      { id: 'beta', vp: 3, influence: 1 },
      { id: 'alpha', vp: 3, influence: 1 },
      { id: 'gamma', vp: 2, influence: 0 },
      { id: 'delta', vp: 1, influence: 0 },
    ];

    // When: the healthy twenty-unit pot assigns seven competitive units to the tied group.
    const payouts = TragedyOfTheCommonsPlugin.computePayouts(outcome(100, rankings), ids, 5n);

    // Then: alpha receives the tied-group remainder without disturbing caller order.
    expect([...payouts.entries()]).toEqual([
      ['delta', -2n],
      ['beta', 1n],
      ['alpha', 2n],
      ['gamma', -1n],
    ]);
  });

  it('keeps every net delta above the entry-loss floor and the game zero-sum', () => {
    // Given: representative health, pot, and tie combinations.
    const ids = ['alpha', 'beta', 'gamma', 'delta'];
    const scenarios = [
      outcome(0),
      outcome(33),
      outcome(100),
      outcome(
        67,
        ids.map((id) => ({ id, vp: 1, influence: 1 })),
      ),
    ];

    // When: every scenario is paid with a ten-unit entry.
    const payouts = scenarios.map((scenario) =>
      TragedyOfTheCommonsPlugin.computePayouts(scenario, ids, 10n),
    );

    // Then: no gross share is negative and every complete game conserves all entries.
    for (const game of payouts) {
      expect([...game.values()].every((delta) => delta >= -10n)).toBe(true);
      expect(sum(game.values())).toBe(0n);
    }
  });
});
