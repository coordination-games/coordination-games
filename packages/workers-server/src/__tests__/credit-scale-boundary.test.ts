/**
 * Credit decimal scaling — settlement boundary test.
 *
 * Locks in the fix for the pre-launch money bug where `GameRoomDO` was
 * relaying plugin-declared `entryCost` values (whole credits) straight
 * into `int256` settlement deltas without scaling to the on-chain 6-decimal
 * raw unit. Symptom: CtL with `entryCost: 10` moved 10 raw units = 0.00001
 * whole credits per game; a 400-credit registration paid for 40 billion
 * games.
 *
 * The fix is a single boundary in `GameRoomDO.kickOffSettlement`:
 *
 *   const entryCost = BigInt(this._plugin.entryCost) * CREDIT_SCALE;
 *   const payouts   = this._plugin.computePayouts(outcome, playerIds, entryCost);
 *
 * Plugin `computePayouts` functions stay untouched — they do proportional
 * math and conservation; scale passes through.
 *
 * This test mirrors that boundary with CtL's real plugin (entryCost: 10,
 * binary winner/loser) and asserts the deltas that `OnChainRelay.submit`
 * would hand to `settleGame` are in raw 6-decimal units.
 */

import { CREDIT_SCALE } from '@coordination-games/engine';
import { CaptureTheLobsterPlugin, type CtlOutcome } from '@coordination-games/game-ctl';
import { describe, expect, it } from 'vitest';

describe('CREDIT_SCALE — settlement boundary', () => {
  it('CREDIT_SCALE is 10^6 (matches USDC decimals and contract credits = net * 100 on a 6-dec USDC)', () => {
    expect(CREDIT_SCALE).toBe(1_000_000n);
  });

  it('GameRoomDO boundary: plugin entryCost (whole credits) → scaled deltas (raw credit units)', () => {
    // Construct a minimal CtL outcome: Team A wins, one player each side.
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

    // Simulate the GameRoomDO boundary: scale whole-credit entryCost to raw.
    expect(CaptureTheLobsterPlugin.entryCost).toBe(10);
    const entryCost = BigInt(CaptureTheLobsterPlugin.entryCost) * CREDIT_SCALE;
    expect(entryCost).toBe(10_000_000n);

    const payouts = CaptureTheLobsterPlugin.computePayouts(outcome, playerIds, entryCost);

    // Deltas submitted to the relay / contract must be in raw units.
    expect(payouts.get('alice')).toBe(10_000_000n);
    expect(payouts.get('bob')).toBe(-10_000_000n);

    // The invariants GameRoomDO enforces before submit must still hold in
    // scaled space (zero-sum + no delta below -entryCost).
    const deltas = playerIds.map((id) => payouts.get(id) ?? 0n);
    const sum = deltas.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(0n);
    for (const d of deltas) expect(d).toBeGreaterThanOrEqual(-entryCost);
  });

  it('unscaled (buggy) boundary would yield deltas 6 orders of magnitude smaller — regression lock', () => {
    // Sanity: this is what the old code did. If anyone ever "fixes" scaling
    // by reverting, this test gives them a direct before/after comparison.
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
    const unscaled = BigInt(CaptureTheLobsterPlugin.entryCost); // 10n — wrong
    const scaled = unscaled * CREDIT_SCALE; // 10_000_000n — correct

    const unscaledPayouts = CaptureTheLobsterPlugin.computePayouts(outcome, playerIds, unscaled);
    const scaledPayouts = CaptureTheLobsterPlugin.computePayouts(outcome, playerIds, scaled);

    expect(unscaledPayouts.get('alice')).toBe(10n); // buggy — 0.00001 credits
    expect(scaledPayouts.get('alice')).toBe(10_000_000n); // correct — 10 credits
    expect(scaledPayouts.get('alice')).toBe((unscaledPayouts.get('alice') ?? 0n) * CREDIT_SCALE);
  });
});
