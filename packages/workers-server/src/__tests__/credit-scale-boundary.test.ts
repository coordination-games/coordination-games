/**
 * Credit-unit boundary lock.
 *
 * Pre-April-2026 this test guarded a specific bug where `GameRoomDO` was
 * relaying plugin-declared `entryCost` (whole credits, `number`) straight
 * into `int256` settlement deltas without scaling to the on-chain 6-decimal
 * raw unit. Symptom: CtL with `entryCost: 10` moved 10 raw units = 0.00001
 * whole credits per game; a 400-credit registration paid for 40 billion
 * games.
 *
 * That bug is now prevented at the type level. `CoordinationGame.entryCost`
 * is a `bigint` in raw units, declared via `credits(n)`:
 *
 *   entryCost: credits(10),   // = 10_000_000n raw
 *
 * `GameRoomDO.kickOffSettlement` and `LobbyDO.checkBalanceOrError` consume
 * that bigint directly — there is no scaling boundary to forget. This test
 * still locks the invariants so any future refactor that reintroduces a
 * units mismatch fails loudly instead of bleeding balances.
 */

import { CREDIT_SCALE, credits } from '@coordination-games/engine';
import { CaptureTheLobsterPlugin, type CtlOutcome } from '@coordination-games/game-ctl';
import { describe, expect, it } from 'vitest';

describe('credit unit boundary — raw-bigint discipline', () => {
  it('CREDIT_SCALE is 10^6 (matches USDC decimals)', () => {
    expect(CREDIT_SCALE).toBe(1_000_000n);
  });

  it('credits(n) scales whole integers to raw units', () => {
    expect(credits(10)).toBe(10_000_000n);
    expect(credits(1)).toBe(1_000_000n);
    expect(credits(0)).toBe(0n);
  });

  it('CaptureTheLobsterPlugin.entryCost is already raw (no settlement-time scaling)', () => {
    expect(CaptureTheLobsterPlugin.entryCost).toBe(10_000_000n);
  });

  it('settlement boundary: plugin.entryCost flows into computePayouts unchanged', () => {
    const playerIds = ['alice', 'bob'];
    const outcome: CtlOutcome = {
      winner: 'A',
      score: { A: 1, B: 0 },
      turnCount: 5,
      playerStats: {
        alice: { team: 'A', kills: 1, deaths: 0, flagCarries: 1, flagCaptures: 1 },
        bob: { team: 'B', kills: 0, deaths: 1, flagCarries: 0, flagCaptures: 0 },
      },
    };

    // This mirrors GameRoomDO.kickOffSettlement: no multiply, no scale.
    const entryCost = CaptureTheLobsterPlugin.entryCost;
    const payouts = CaptureTheLobsterPlugin.computePayouts(outcome, playerIds, entryCost);

    // Deltas submitted to the relay / contract must be in raw units.
    expect(payouts.get('alice')).toBe(10_000_000n);
    expect(payouts.get('bob')).toBe(-10_000_000n);

    // Invariants GameRoomDO enforces before submit (zero-sum, no delta
    // below -entryCost) must still hold in raw space.
    const deltas = playerIds.map((id) => payouts.get(id) ?? 0n);
    const sum = deltas.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(0n);
    for (const d of deltas) expect(d).toBeGreaterThanOrEqual(-entryCost);
  });
});
