/**
 * OATHBREAKER payout math (BigInt) — Phase 3.1.
 *
 * Validates the locked rounding rule (highest-rank player collects the pot
 * remainder) and the canonical settlement order (balance desc → join order
 * asc → playerId lex asc) used as the tiebreaker.
 *
 * The historical bug this guards against: floor-divides on float
 * `dollarPerPoint = totalDollarsInvested / totalSupply` produced non-zero-sum
 * deltas, so `GameRoomDO.settleOnChain()` skipped silently. With BigInt math
 * + remainder allocation, the sum invariant is exact by construction.
 */

import { describe, expect, it } from 'vitest';
import {
  type CreditAmount,
  distributePot,
  OathbreakerPlugin,
  type OathOutcome,
  type OathPlayerRanking,
  rankPlayersForSettlement,
} from '../index.js';

function ranking(
  id: string,
  finalBalance: number,
  oathsKept = 0,
  oathsBroken = 0,
): OathPlayerRanking {
  return { id, finalBalance, oathsKept, oathsBroken };
}

function makeOutcome(rankings: OathPlayerRanking[]): OathOutcome {
  return {
    rankings,
    roundsPlayed: 12,
    totalPrinted: 0,
    totalBurned: 0,
    finalSupply: rankings.reduce((s, r) => s + r.finalBalance, 0),
  };
}

function sum(values: Iterable<CreditAmount>): CreditAmount {
  let s = 0n;
  for (const v of values) s += v;
  return s;
}

describe('OATH distributePot — pot floor + remainder allocation', () => {
  it('two players with equal balances split the pot evenly when divisible', () => {
    const ranked = rankPlayersForSettlement([ranking('a', 10), ranking('b', 10)], ['a', 'b']);
    const shares = distributePot(100n, ranked);
    expect(shares.get('a')).toBe(50n);
    expect(shares.get('b')).toBe(50n);
    expect(sum(shares.values())).toBe(100n);
  });

  it('two equal-balance players, odd pot → highest-rank (joinOrder) gets the +1 remainder', () => {
    // Equal balances → tiebreak by joinOrder (a first), so 'a' is highest-rank.
    const ranked = rankPlayersForSettlement([ranking('a', 5), ranking('b', 5)], ['a', 'b']);
    const shares = distributePot(1n, ranked);
    expect(shares.get('a')).toBe(1n);
    expect(shares.get('b')).toBe(0n);
    expect(sum(shares.values())).toBe(1n);
  });

  it('three players, points [10, 5, 1] — remainder lands on the points winner', () => {
    // pot=100, total=16. Floors: 10*100/16=62, 5*100/16=31, 1*100/16=6 → sum 99, remainder 1.
    const ranked = rankPlayersForSettlement(
      [ranking('p3', 1), ranking('p2', 5), ranking('p1', 10)],
      ['p1', 'p2', 'p3'],
    );
    expect(ranked.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    const shares = distributePot(100n, ranked);
    expect(shares.get('p1')).toBe(63n); // 62 floor + 1 remainder
    expect(shares.get('p2')).toBe(31n);
    expect(shares.get('p3')).toBe(6n);
    expect(sum(shares.values())).toBe(100n);
  });

  it('tied points + tied join order → final tiebreak is playerId lex (lower lex wins)', () => {
    // Both joined at index 0/1, but 'aaa' < 'bbb' lex. With identical balances
    // joinOrder is the primary tiebreak, so we put the lex-smaller id later
    // in joinOrder to prove lex isn't reached unnecessarily; then test pure
    // lex by passing an empty joinOrder.
    const ranked = rankPlayersForSettlement(
      [ranking('zeta', 5), ranking('alpha', 5), ranking('mu', 5)],
      [], // no join-order info → fall through to lex
    );
    expect(ranked.map((r) => r.id)).toEqual(['alpha', 'mu', 'zeta']);

    const shares = distributePot(7n, ranked);
    // 7/3 = 2 each, remainder 1 → goes to ranked[0] = 'alpha'
    expect(shares.get('alpha')).toBe(3n);
    expect(shares.get('mu')).toBe(2n);
    expect(shares.get('zeta')).toBe(2n);
    expect(sum(shares.values())).toBe(7n);
  });

  it('tied points → join order beats lex (earliest-joined gets remainder)', () => {
    // 'zeta' is first to join → highest-rank despite lex being last.
    const ranked = rankPlayersForSettlement(
      [ranking('alpha', 5), ranking('zeta', 5)],
      ['zeta', 'alpha'],
    );
    expect(ranked.map((r) => r.id)).toEqual(['zeta', 'alpha']);
    const shares = distributePot(1n, ranked);
    expect(shares.get('zeta')).toBe(1n);
    expect(shares.get('alpha')).toBe(0n);
  });

  it('all players bankrupt (total balance 0) → highest-rank gets the entire pot', () => {
    // joinOrder: 'a','b' → both balance 0, tiebreak by joinOrder, 'a' wins.
    const ranked = rankPlayersForSettlement([ranking('a', 0), ranking('b', 0)], ['a', 'b']);
    const shares = distributePot(4n, ranked);
    expect(shares.get('a')).toBe(4n);
    expect(shares.get('b')).toBe(0n);
    expect(sum(shares.values())).toBe(4n);
  });

  it('empty rankings → empty shares (defensive: no /0)', () => {
    const shares = distributePot(100n, []);
    expect(shares.size).toBe(0);
  });

  it('zero-pot game → every share is 0n; sum is 0n', () => {
    const ranked = rankPlayersForSettlement([ranking('a', 5), ranking('b', 3)], ['a', 'b']);
    const shares = distributePot(0n, ranked);
    expect(shares.get('a')).toBe(0n);
    expect(shares.get('b')).toBe(0n);
    expect(sum(shares.values())).toBe(0n);
  });
});

describe('OATH computePayouts — zero-sum invariant + entryCost subtraction', () => {
  it('returns BigInt deltas summing exactly to 0 (zero-sum law)', () => {
    const ids = ['p1', 'p2', 'p3', 'p4'];
    const outcome = makeOutcome([
      ranking('p1', 100),
      ranking('p2', 50),
      ranking('p3', 25),
      ranking('p4', 25),
    ]);
    const payouts = OathbreakerPlugin.computePayouts(outcome, ids, 1n);
    expect(sum(payouts.values())).toBe(0n);
    for (const id of ids) expect(typeof payouts.get(id)).toBe('bigint');
  });

  it('all-or-nothing winner: rest lose their stake, winner takes everything net', () => {
    const ids = ['p1', 'p2', 'p3', 'p4'];
    const outcome = makeOutcome([
      ranking('p1', 400),
      ranking('p2', 0),
      ranking('p3', 0),
      ranking('p4', 0),
    ]);
    const payouts = OathbreakerPlugin.computePayouts(outcome, ids, 10n);
    expect(payouts.get('p1')).toBe(30n); // 40 share - 10 entry
    expect(payouts.get('p2')).toBe(-10n);
    expect(payouts.get('p3')).toBe(-10n);
    expect(payouts.get('p4')).toBe(-10n);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('every delta ≥ -entryCost (no player loses more than their stake)', () => {
    const ids = ['p1', 'p2', 'p3', 'p4'];
    const entryCost = 5n;
    const outcome = makeOutcome([
      ranking('p1', 100),
      ranking('p2', 0),
      ranking('p3', 0),
      ranking('p4', 0),
    ]);
    const payouts = OathbreakerPlugin.computePayouts(outcome, ids, entryCost);
    for (const v of payouts.values()) expect(v).toBeGreaterThanOrEqual(-entryCost);
    expect(sum(payouts.values())).toBe(0n);
  });

  it('property: random valid balances → sum-of-deltas is always exactly 0n', () => {
    // Cheap deterministic LCG (matches mulberry32 vibe but no import needed)
    let seed = 0x12345678;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let trial = 0; trial < 200; trial++) {
      const playerCount = 2 + Math.floor(rand() * 18); // 2..19
      const ids = Array.from({ length: playerCount }, (_, i) => `p${i}`);
      const balances = ids.map(() => Math.floor(rand() * 1000));
      // Coin flip: zero out everyone (test the bankrupt branch too)
      const allZero = rand() < 0.05;
      const rankings = ids.map((id, i) => ranking(id, allZero ? 0 : (balances[i] ?? 0)));
      const outcome = makeOutcome(rankings);
      const entryCost = BigInt(1 + Math.floor(rand() * 100));
      const payouts = OathbreakerPlugin.computePayouts(outcome, ids, entryCost);
      expect(sum(payouts.values())).toBe(0n);
      for (const v of payouts.values()) expect(v).toBeGreaterThanOrEqual(-entryCost);
    }
  });

  it('payouts are stable across permutations of `playerIds` (anchored to join order)', () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta'];
    const outcome = makeOutcome([
      ranking('alpha', 30),
      ranking('beta', 30),
      ranking('gamma', 30),
      ranking('delta', 10),
    ]);
    // Same playerIds order → identical results regardless of how rankings
    // were originally sorted. The function must re-rank internally.
    const a = OathbreakerPlugin.computePayouts(outcome, ids, 1n);
    const reordered = makeOutcome([...outcome.rankings].reverse());
    const b = OathbreakerPlugin.computePayouts(reordered, ids, 1n);
    for (const id of ids) expect(a.get(id)).toBe(b.get(id));
  });
});
