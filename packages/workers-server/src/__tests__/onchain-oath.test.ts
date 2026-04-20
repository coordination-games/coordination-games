/**
 * OATHBREAKER on-chain settlement — contract test (Phase 3.1).
 *
 * Plays a full OATHBREAKER game end-to-end through the engine action API,
 * derives the outcome + payouts, then runs the same two invariants
 * `GameRoomDO.settleOnChain()` enforces before submitting the tx:
 *   1. zero-sum: `sum(deltas) === 0n`
 *   2. floor:    every delta `≥ -entryCost`
 *
 * Pre-Phase-3.1 these invariants tripped on every OATH game (`dollarValue`
 * was a float divide → non-zero-sum sum) so settlement was silently
 * skipped. With BigInt math + the highest-rank remainder rule, both must
 * pass for any valid end-state.
 *
 * We avoid the full DO test harness (Workers runtime mocks, D1, viem
 * relay) — `GameRoomDO.settleOnChain` is mostly Cloudflare wiring around
 * these invariant checks and a relay call. The wiring is exercised by the
 * smoke tests; here we lock the math.
 */

import {
  applyAction,
  createInitialState,
  DEFAULT_OATH_CONFIG,
  OathbreakerPlugin,
  type OathState,
} from '@coordination-games/game-oathbreaker';
import { describe, expect, it } from 'vitest';

/**
 * Mirror of the two BigInt invariants in `GameRoomDO.settleOnChain` so a
 * regression in either side fails this test.
 */
function checkSettlementInvariants(
  payouts: Map<string, bigint>,
  playerIds: string[],
  entryCost: bigint,
): { ok: true } | { ok: false; reason: string } {
  const deltas = playerIds.map((id) => ({ agentId: id, delta: payouts.get(id) ?? 0n }));
  const sum = deltas.reduce((acc, d) => acc + d.delta, 0n);
  if (sum !== 0n) {
    return { ok: false, reason: `non-zero-sum: ${sum.toString()}` };
  }
  const floor = deltas.find((d) => d.delta < -entryCost);
  if (floor) {
    return { ok: false, reason: `floor violation: ${floor.agentId} ${floor.delta.toString()}` };
  }
  return { ok: true };
}

/** Drive a game to `phase === 'finished'` by submitting `decision` for every
 *  pairing each round, accepting whatever the engine returns as the agreed
 *  pledge (defaults to minPledge on timeout). */
function playToCompletion(
  initial: OathState,
  scriptedDecisions: Array<'C' | 'D'>,
  pledge = 5,
): OathState {
  let state = initial;
  // game_start
  state = applyAction(state, null, { type: 'game_start' }).state;
  let roundIdx = 0;
  while (state.phase === 'playing') {
    // Pledge phase: every player proposes the same pledge to lock it in.
    for (const pairing of state.pairings) {
      state = applyAction(state, pairing.player1, { type: 'propose_pledge', amount: pledge }).state;
      state = applyAction(state, pairing.player2, { type: 'propose_pledge', amount: pledge }).state;
    }
    // Decision phase: alternate or follow the script.
    const decision = scriptedDecisions[roundIdx % scriptedDecisions.length] ?? 'C';
    for (const pairing of state.pairings) {
      state = applyAction(state, pairing.player1, { type: 'submit_decision', decision }).state;
      state = applyAction(state, pairing.player2, { type: 'submit_decision', decision }).state;
    }
    roundIdx++;
    if (roundIdx > 200) throw new Error('game did not finish in 200 rounds (likely a bug)');
  }
  return state;
}

describe('OATHBREAKER settlement invariants — end-to-end', () => {
  const playerIds = ['alice', 'bob', 'carol', 'dave'];
  // plugin.entryCost is raw-unit bigint (credits(1) = 1_000_000n).
  const entryCost = OathbreakerPlugin.entryCost;

  function make(seed: string): OathState {
    return createInitialState({
      ...DEFAULT_OATH_CONFIG,
      maxRounds: 6, // shorter for the test
      playerIds: [...playerIds],
      seed,
      // OathConfig.entryCost is display-only whole credits (see types.ts).
      entryCost: 1,
    });
  }

  it('all-cooperate game: payouts pass both invariants', () => {
    const state = playToCompletion(make('coop-seed'), ['C']);
    expect(state.phase).toBe('finished');
    const outcome = OathbreakerPlugin.getOutcome(state);
    const payouts = OathbreakerPlugin.computePayouts(outcome, playerIds, entryCost);
    expect(checkSettlementInvariants(payouts, playerIds, entryCost)).toEqual({ ok: true });
  });

  it('all-defect game: payouts pass both invariants (heavy supply burn)', () => {
    const state = playToCompletion(make('def-seed'), ['D']);
    expect(state.phase).toBe('finished');
    const outcome = OathbreakerPlugin.getOutcome(state);
    const payouts = OathbreakerPlugin.computePayouts(outcome, playerIds, entryCost);
    expect(checkSettlementInvariants(payouts, playerIds, entryCost)).toEqual({ ok: true });
  });

  it('mixed C/D game: payouts pass both invariants and sum to 0n', () => {
    const state = playToCompletion(make('mix-seed'), ['C', 'D', 'C', 'C', 'D', 'C']);
    expect(state.phase).toBe('finished');
    const outcome = OathbreakerPlugin.getOutcome(state);
    const payouts = OathbreakerPlugin.computePayouts(outcome, playerIds, entryCost);
    const result = checkSettlementInvariants(payouts, playerIds, entryCost);
    expect(result).toEqual({ ok: true });
    let s = 0n;
    for (const v of payouts.values()) s += v;
    expect(s).toBe(0n);
  });

  it('several seeds: invariants hold for every distinct game outcome', () => {
    for (const seed of ['s1', 's2', 's3', 's4', 's5']) {
      const state = playToCompletion(make(seed), ['C', 'D']);
      const outcome = OathbreakerPlugin.getOutcome(state);
      const payouts = OathbreakerPlugin.computePayouts(outcome, playerIds, entryCost);
      const result = checkSettlementInvariants(payouts, playerIds, entryCost);
      expect(result).toEqual({ ok: true });
    }
  });
});
