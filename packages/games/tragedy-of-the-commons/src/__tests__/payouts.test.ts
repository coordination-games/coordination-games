import { describe, expect, it } from 'vitest';
import {
  TragedyOfTheCommonsPlugin,
  type TragedyOutcome,
  type TragedyPlayerRanking,
} from '../index.js';

function ranking(id: string, vp: number, influence: number): TragedyPlayerRanking {
  return { id, vp, influence };
}

function outcome(rankings: TragedyPlayerRanking[], commonsHealthPercent = 100): TragedyOutcome {
  return {
    rankings,
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

describe('TragedyOfTheCommonsPlugin.computePayouts', () => {
  it('does not let a healthy four-player winner take three entries from the field', () => {
    // Given: a healthy commons and an unambiguous four-player ranking.
    const ids = ['alpha', 'beta', 'gamma', 'delta'];

    // When: the full pot is distributed.
    const payouts = TragedyOfTheCommonsPlugin.computePayouts(
      outcome([
        ranking('alpha', 4, 0),
        ranking('beta', 3, 0),
        ranking('gamma', 2, 0),
        ranking('delta', 1, 0),
      ]),
      ids,
      10n,
    );

    // Then: no player moves by more than half an entry plus one rounding unit.
    expect([...payouts.values()].every((payout) => payout >= -6n && payout <= 6n)).toBe(true);
    expect([...payouts.values()]).not.toEqual([30n, -10n, -10n, -10n]);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('lets a later winner catch an early winner without a two-game snowball', () => {
    // Given: two healthy games with alpha and beta swapping first and second place.
    const ids = ['alpha', 'beta', 'gamma', 'delta'];
    const firstGame = outcome([
      ranking('alpha', 4, 0),
      ranking('beta', 3, 0),
      ranking('gamma', 2, 0),
      ranking('delta', 1, 0),
    ]);
    const secondGame = outcome([
      ranking('beta', 4, 0),
      ranking('alpha', 3, 0),
      ranking('gamma', 2, 0),
      ranking('delta', 1, 0),
    ]);

    // When: tournament balances carry across both games.
    const firstPayouts = TragedyOfTheCommonsPlugin.computePayouts(firstGame, ids, 10n);
    const secondPayouts = TragedyOfTheCommonsPlugin.computePayouts(secondGame, ids, 10n);
    const cumulative = new Map(
      ids.map((id) => [id, (firstPayouts.get(id) ?? 0n) + (secondPayouts.get(id) ?? 0n)]),
    );

    // Then: each game is carry-safe, the two winners converge, and the spread stays bounded.
    expect(
      [...firstPayouts.values(), ...secondPayouts.values()].every(
        (payout) => payout >= -6n && payout <= 6n,
      ),
    ).toBe(true);
    expect(cumulative.get('alpha')).toBe(cumulative.get('beta'));
    expect((cumulative.get('alpha') ?? 0n) - (cumulative.get('delta') ?? 0n)).toBeLessThanOrEqual(
      10n,
    );
  });

  it('shares occupied-position weight across an exact first-place tie', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta'];
    const payouts = TragedyOfTheCommonsPlugin.computePayouts(
      outcome([
        ranking('delta', 2, 5),
        ranking('alpha', 2, 7),
        ranking('beta', 2, 7),
        ranking('gamma', 1, 10),
      ]),
      ids,
      10n,
    );

    expect(payouts.get('alpha')).toBe(2n);
    expect(payouts.get('beta')).toBe(2n);
    expect(payouts.get('gamma')).toBe(-3n);
    expect(payouts.get('delta')).toBe(-1n);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('scales the competitive reward with commons health', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta'];
    const payouts = TragedyOfTheCommonsPlugin.computePayouts(
      outcome(
        [
          ranking('alpha', 3, 0),
          ranking('beta', 2, 0),
          ranking('gamma', 1, 0),
          ranking('delta', 0, 0),
        ],
        50,
      ),
      ids,
      10n,
    );

    expect(payouts.get('alpha')).toBe(2n);
    expect(payouts.get('beta')).toBe(1n);
    expect(payouts.get('gamma')).toBe(-1n);
    expect(payouts.get('delta')).toBe(-2n);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('rejects rankings that omit, duplicate, or invent payout recipients', () => {
    const ids = ['alpha', 'beta'];

    expect(() =>
      TragedyOfTheCommonsPlugin.computePayouts(outcome([ranking('alpha', 1, 0)]), ids, 1n),
    ).toThrow(/every player exactly once/);

    expect(() =>
      TragedyOfTheCommonsPlugin.computePayouts(
        outcome([ranking('alpha', 1, 0), ranking('alpha', 0, 0)]),
        ids,
        1n,
      ),
    ).toThrow(/duplicate player/);

    expect(() =>
      TragedyOfTheCommonsPlugin.computePayouts(
        outcome([ranking('alpha', 1, 0), ranking('intruder', 0, 0)]),
        ids,
        1n,
      ),
    ).toThrow(/unknown player/);
  });

  it('rejects non-integer settlement scores', () => {
    expect(() =>
      TragedyOfTheCommonsPlugin.computePayouts(
        outcome([ranking('alpha', 1.5, 0), ranking('beta', 0, 0)]),
        ['alpha', 'beta'],
        1n,
      ),
    ).toThrow(/non-integer score/);
  });

  it('rejects non-integer commons health percent', () => {
    expect(() =>
      TragedyOfTheCommonsPlugin.computePayouts(
        outcome([ranking('alpha', 1, 0), ranking('beta', 0, 0)], 99.5),
        ['alpha', 'beta'],
        1n,
      ),
    ).toThrow(/non-integer commons health percent/);
  });
});
