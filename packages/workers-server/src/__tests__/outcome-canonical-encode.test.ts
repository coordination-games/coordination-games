/**
 * Outcome bytes — canonical encoding regression lock.
 *
 * OnChainRelay.submit encodes `payload.outcome` into the `outcomeBytes` field
 * that anchors the game result on-chain (via GameAnchor.settleGame). A prior
 * implementation used `JSON.stringify(outcome)` directly, which silently drops
 * Map/Set instances. CtlOutcome.playerStats was a Map, so every CtL outcome
 * was anchored on-chain with empty playerStats.
 *
 * The fix: (1) change CtlOutcome.playerStats to a POJO Record; (2) replace
 * JSON.stringify with canonicalEncode, which throws NonPojoValueError if
 * anyone re-introduces a Map. This test pins both sides.
 */

import { canonicalDecode, canonicalEncode } from '@coordination-games/engine';
import type { CtlOutcome } from '@coordination-games/game-ctl';
import { describe, expect, it } from 'vitest';

describe('CtL outcome → canonical bytes', () => {
  const outcome: CtlOutcome = {
    winner: 'A',
    score: { A: 3, B: 1 },
    turnCount: 42,
    playerStats: {
      alice: { team: 'A', kills: 5, deaths: 2, flagCarries: 1, flagCaptures: 1 },
      bob: { team: 'B', kills: 1, deaths: 4, flagCarries: 0, flagCaptures: 0 },
    },
  };

  it('round-trips every field including playerStats', () => {
    const bytes = canonicalEncode(outcome);
    const decoded = canonicalDecode(bytes) as CtlOutcome;

    expect(decoded.winner).toBe('A');
    expect(decoded.score).toEqual({ A: 3, B: 1 });
    expect(decoded.turnCount).toBe(42);
    expect(decoded.playerStats).toEqual(outcome.playerStats);
  });

  it('produces non-empty bytes (regression lock for the Map bug)', () => {
    const bytes = canonicalEncode(outcome);
    const asString = new TextDecoder().decode(bytes);

    // Pre-fix symptom: JSON.stringify(Map) → "{}" → outcome on-chain is empty.
    expect(asString).toContain('alice');
    expect(asString).toContain('bob');
    expect(asString).toContain('flagCaptures');
  });

  it('is deterministic across key-insertion order', () => {
    const { alice, bob } = outcome.playerStats;
    if (!alice || !bob) throw new Error('test fixture missing players');
    const a = canonicalEncode(outcome);
    const b = canonicalEncode({
      // Same values, reversed-ish key order.
      turnCount: 42,
      playerStats: { bob, alice },
      score: { B: 1, A: 3 },
      winner: 'A',
    } satisfies CtlOutcome);
    expect(a).toEqual(b);
  });

  it('rejects Map in playerStats (loud failure, not silent drop)', () => {
    // Belt-and-braces: if anyone ever reintroduces a Map into playerStats
    // (despite the typed Record signature), canonicalEncode throws instead
    // of silently anchoring `{}` on-chain.
    const withMap = {
      ...outcome,
      playerStats: new Map([
        ['alice', outcome.playerStats.alice],
      ]) as unknown as CtlOutcome['playerStats'],
    };
    expect(() => canonicalEncode(withMap)).toThrow();
  });
});
