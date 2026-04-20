import { describe, expect, it } from 'vitest';
import type { CtlOutcome } from '../plugin.js';
import { CaptureTheLobsterPlugin } from '../plugin.js';

function outcome(winner: 'A' | 'B' | null, roster: Record<string, 'A' | 'B'>): CtlOutcome {
  const playerStats: CtlOutcome['playerStats'] = {};
  for (const [id, team] of Object.entries(roster)) {
    playerStats[id] = { team, kills: 0, deaths: 0, flagCarries: 0, flagCaptures: 0 };
  }
  return { winner, playerStats, turnCount: 1, score: { A: 0, B: 0 } };
}

describe('CtL computePayouts', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const roster = { p1: 'A', p2: 'A', p3: 'B', p4: 'B' } as const;

  function totalSum(values: Iterable<bigint>): bigint {
    let s = 0n;
    for (const v of values) s += v;
    return s;
  }

  it('returns zero-sum with team winner', () => {
    const p = CaptureTheLobsterPlugin.computePayouts(outcome('A', roster), ids, 10n);
    expect(p.get('p1')).toBe(10n);
    expect(p.get('p2')).toBe(10n);
    expect(p.get('p3')).toBe(-10n);
    expect(p.get('p4')).toBe(-10n);
    expect(totalSum(p.values())).toBe(0n);
  });

  it('scales with entryCost', () => {
    const p = CaptureTheLobsterPlugin.computePayouts(outcome('B', roster), ids, 25n);
    expect(p.get('p3')).toBe(25n);
    expect(p.get('p1')).toBe(-25n);
    expect(totalSum(p.values())).toBe(0n);
  });

  it('returns all zeros on draw', () => {
    const p = CaptureTheLobsterPlugin.computePayouts(outcome(null, roster), ids, 10n);
    for (const id of ids) expect(p.get(id)).toBe(0n);
  });

  it('never sets a delta below -entryCost', () => {
    const entryCost = 10n;
    const p = CaptureTheLobsterPlugin.computePayouts(outcome('A', roster), ids, entryCost);
    for (const v of p.values()) expect(v).toBeGreaterThanOrEqual(-entryCost);
  });
});
