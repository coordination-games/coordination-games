import { getGame } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import {
  TRAGEDY_GAME_ID,
  TragedyOfTheCommonsPlugin,
  TragedyOfTheCommonsV2Plugin,
  type TragedyV2Outcome,
} from '../index.js';

const PLAYER_IDS = ['alpha', 'beta', 'gamma', 'delta'];

function v2Outcome(commonsHealthPercent: number): TragedyV2Outcome {
  return {
    rankings: [
      { id: 'alpha', vp: 4, influence: 0 },
      { id: 'beta', vp: 3, influence: 0 },
      { id: 'gamma', vp: 2, influence: 0 },
      { id: 'delta', vp: 1, influence: 0 },
    ],
    roundsPlayed: 12,
    flourishingEcosystems: 1,
    collapsedEcosystems: 0,
    commonsHealthPercent,
    averageTileHealthPercent: commonsHealthPercent,
  };
}

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

describe('registered Tragedy payout policy', () => {
  it('registers V2 as the live game with carry-safe healthy payouts', () => {
    // Given: the plugin side effect has registered the public Tragedy game id.
    const registered = getGame(TRAGEDY_GAME_ID);

    // When: the live registry path settles a healthy four-player V2 outcome.
    expect(registered).toBe(TragedyOfTheCommonsV2Plugin);
    if (registered === undefined) throw new Error('expected registered Tragedy game');
    const payouts = registered.computePayouts(v2Outcome(100), PLAYER_IDS, 10n);

    // Then: the operational path uses bounded ranked rewards rather than winner-take-all.
    expect([...payouts.values()]).toEqual([3n, 1n, -1n, -3n]);
    expect([...payouts.values()]).not.toEqual([30n, -10n, -10n, -10n]);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('applies the shared policy directly to the extended V2 outcome', () => {
    // Given: a half-health V2 outcome carrying averageTileHealthPercent.
    const outcome = v2Outcome(50);

    // When: V2 computes payouts directly.
    const payouts = TragedyOfTheCommonsV2Plugin.computePayouts(outcome, PLAYER_IDS, 10n);

    // Then: V2 matches the shared reserve and health-scaled ranking curve.
    expect(outcome.averageTileHealthPercent).toBe(50);
    expect([...payouts.values()]).toEqual([2n, 1n, -1n, -2n]);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('rejects negative entry costs on both public plugin versions', () => {
    // Given: a valid V2-compatible outcome and a negative entry cost.
    const outcome = v2Outcome(100);

    // When: either public plugin attempts settlement.
    const settleV0 = () => TragedyOfTheCommonsPlugin.computePayouts(outcome, PLAYER_IDS, -1n);
    const settleV2 = () => TragedyOfTheCommonsV2Plugin.computePayouts(outcome, PLAYER_IDS, -1n);

    // Then: both reject negative money explicitly.
    expect(settleV0).toThrow(/entry cost must be non-negative/i);
    expect(settleV2).toThrow(/entry cost must be non-negative/i);
  });

  it('supports zero entry cost as an all-zero settlement', () => {
    // Given: a healthy V2 outcome with no entry stake.
    const outcome = v2Outcome(100);

    // When: both public plugin versions settle the zero pot.
    const v0 = TragedyOfTheCommonsPlugin.computePayouts(outcome, PLAYER_IDS, 0n);
    const v2 = TragedyOfTheCommonsV2Plugin.computePayouts(outcome, PLAYER_IDS, 0n);

    // Then: every player appears once with a zero delta.
    expect([...v0.entries()]).toEqual(PLAYER_IDS.map((id) => [id, 0n]));
    expect([...v2.entries()]).toEqual(PLAYER_IDS.map((id) => [id, 0n]));
  });
});
