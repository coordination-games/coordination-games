import { describe, expect, it } from 'vitest';
import type { CtlOutcome } from '../plugin.js';
import { CaptureTheLobsterPlugin } from '../plugin.js';

function outcome(winner: 'A' | 'B' | null, roster: Record<string, 'A' | 'B'>): CtlOutcome {
  const playerStats: CtlOutcome['playerStats'] = new Map();
  for (const [id, team] of Object.entries(roster)) {
    playerStats.set(id, { team, kills: 0, deaths: 0, flagCarries: 0, flagCaptures: 0 });
  }
  return { winner, playerStats, turnCount: 1, score: { A: 0, B: 0 } };
}

describe('CtL computePayouts', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const roster = { p1: 'A', p2: 'A', p3: 'B', p4: 'B' } as const;

  it('returns zero-sum with team winner', () => {
    const p = CaptureTheLobsterPlugin.computePayouts(outcome('A', roster), ids, 10);
    expect(p.get('p1')).toBe(10);
    expect(p.get('p2')).toBe(10);
    expect(p.get('p3')).toBe(-10);
    expect(p.get('p4')).toBe(-10);
    expect([...p.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('scales with entryCost', () => {
    const p = CaptureTheLobsterPlugin.computePayouts(outcome('B', roster), ids, 25);
    expect(p.get('p3')).toBe(25);
    expect(p.get('p1')).toBe(-25);
    expect([...p.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('returns all zeros on draw', () => {
    const p = CaptureTheLobsterPlugin.computePayouts(outcome(null, roster), ids, 10);
    for (const id of ids) expect(p.get(id)).toBe(0);
  });

  it('never sets a delta below -entryCost', () => {
    const entryCost = 10;
    const p = CaptureTheLobsterPlugin.computePayouts(outcome('A', roster), ids, entryCost);
    for (const v of p.values()) expect(v).toBeGreaterThanOrEqual(-entryCost);
  });
});
