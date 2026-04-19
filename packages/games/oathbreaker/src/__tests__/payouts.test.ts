import { describe, it, expect } from 'vitest';
import { OathbreakerPlugin } from '../plugin.js';
import type { OathOutcome } from '../types.js';

function outcome(values: Record<string, number>): OathOutcome {
  return {
    rankings: Object.entries(values).map(([id, dollarValue]) => ({
      id,
      finalBalance: 0,
      dollarValue,
      oathsKept: 0,
      oathsBroken: 0,
      cooperationRate: 1,
    })),
    dollarPerPoint: 1,
    roundsPlayed: 12,
    totalPrinted: 0,
    totalBurned: 0,
    finalSupply: 0,
  };
}

describe('Oathbreaker computePayouts', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];

  it('subtracts entryCost from dollarValue', () => {
    const entryCost = 1;
    // 4 players, each entered $1, pool $4. Distribution: 2, 1, 0.5, 0.5
    const p = OathbreakerPlugin.computePayouts(
      outcome({ p1: 2, p2: 1, p3: 0.5, p4: 0.5 }),
      ids,
      entryCost,
    );
    expect(p.get('p1')).toBe(1);
    expect(p.get('p2')).toBe(0);
    expect(p.get('p3')).toBe(-0.5);
    expect(p.get('p4')).toBe(-0.5);
    expect([...p.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
  });

  it('scales with larger entryCost', () => {
    // 4 players × $10 = $40 pool. Winner takes it all.
    const p = OathbreakerPlugin.computePayouts(
      outcome({ p1: 40, p2: 0, p3: 0, p4: 0 }),
      ids,
      10,
    );
    expect(p.get('p1')).toBe(30);
    expect(p.get('p2')).toBe(-10);
    expect(p.get('p3')).toBe(-10);
    expect(p.get('p4')).toBe(-10);
    expect([...p.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('never sets a delta below -entryCost when dollarValue ≥ 0', () => {
    const entryCost = 5;
    const p = OathbreakerPlugin.computePayouts(
      outcome({ p1: 20, p2: 0, p3: 0, p4: 0 }),
      ids,
      entryCost,
    );
    for (const v of p.values()) expect(v).toBeGreaterThanOrEqual(-entryCost);
  });
});
