import { describe, expect, it } from 'vitest';
import {
  TragedyOfTheCommonsPlugin,
  type TragedyOutcome,
  type TragedyPlayerRanking,
} from '../index.js';

function ranking(id: string, vp: number, influence: number): TragedyPlayerRanking {
  return { id, vp, influence };
}

function outcome(rankings: TragedyPlayerRanking[]): TragedyOutcome {
  return {
    rankings,
    roundsPlayed: 12,
    flourishingEcosystems: 1,
    collapsedEcosystems: 0,
  };
}

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

describe('TragedyOfTheCommonsPlugin.computePayouts', () => {
  it('pays the same canonical winner used by ranking policy', () => {
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

    expect(payouts.get('alpha')).toBe(30n);
    expect(payouts.get('beta')).toBe(-10n);
    expect(payouts.get('gamma')).toBe(-10n);
    expect(payouts.get('delta')).toBe(-10n);
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
});
