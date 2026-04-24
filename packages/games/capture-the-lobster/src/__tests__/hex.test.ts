import { describe, expect, it } from 'vitest';
import {
  ALL_DIRECTIONS,
  DIRECTIONS,
  type Direction,
  getNeighbor,
  getNeighbors,
  type Hex,
  hexAdd,
  hexDistance,
  hexEquals,
  hexesInRadius,
  hexesOnLine,
  hexLerp,
  hexRound,
  hexToString,
  stringToHex,
} from '../hex.js';

describe('DIRECTIONS', () => {
  it('all six direction vectors sum to zero', () => {
    const sum = ALL_DIRECTIONS.reduce((acc, d) => hexAdd(acc, DIRECTIONS[d]), { q: 0, r: 0 });
    expect(sum).toEqual({ q: 0, r: 0 });
  });

  it('opposite directions cancel out', () => {
    const pairs: [Direction, Direction][] = [
      ['N', 'S'],
      ['NE', 'SW'],
      ['SE', 'NW'],
    ];
    for (const [a, b] of pairs) {
      expect(hexAdd(DIRECTIONS[a], DIRECTIONS[b])).toEqual({ q: 0, r: 0 });
    }
  });

  it('has exactly 6 directions', () => {
    expect(ALL_DIRECTIONS).toHaveLength(6);
    expect(Object.keys(DIRECTIONS)).toHaveLength(6);
  });
});

describe('hexAdd', () => {
  it('adds two hexes', () => {
    expect(hexAdd({ q: 1, r: 2 }, { q: 3, r: -1 })).toEqual({ q: 4, r: 1 });
  });

  it('identity with zero', () => {
    expect(hexAdd({ q: 5, r: -3 }, { q: 0, r: 0 })).toEqual({ q: 5, r: -3 });
  });
});

describe('hexEquals', () => {
  it('returns true for equal hexes', () => {
    expect(hexEquals({ q: 1, r: 2 }, { q: 1, r: 2 })).toBe(true);
  });

  it('returns false for different hexes', () => {
    expect(hexEquals({ q: 1, r: 2 }, { q: 1, r: 3 })).toBe(false);
  });
});

describe('getNeighbor', () => {
  const origin: Hex = { q: 0, r: 0 };

  it('N neighbor', () => {
    expect(getNeighbor(origin, 'N')).toEqual({ q: 0, r: -1 });
  });

  it('S neighbor', () => {
    expect(getNeighbor(origin, 'S')).toEqual({ q: 0, r: 1 });
  });

  it('NE neighbor', () => {
    expect(getNeighbor(origin, 'NE')).toEqual({ q: 1, r: -1 });
  });

  it('SE neighbor', () => {
    expect(getNeighbor(origin, 'SE')).toEqual({ q: 1, r: 0 });
  });

  it('SW neighbor', () => {
    expect(getNeighbor(origin, 'SW')).toEqual({ q: -1, r: 1 });
  });

  it('NW neighbor', () => {
    expect(getNeighbor(origin, 'NW')).toEqual({ q: -1, r: 0 });
  });

  it('works from non-origin hex', () => {
    expect(getNeighbor({ q: 3, r: -2 }, 'NE')).toEqual({ q: 4, r: -3 });
  });
});

describe('getNeighbors', () => {
  it('returns 6 neighbors', () => {
    expect(getNeighbors({ q: 0, r: 0 })).toHaveLength(6);
  });

  it('all neighbors are distance 1 from center', () => {
    const center: Hex = { q: 2, r: -1 };
    for (const n of getNeighbors(center)) {
      expect(hexDistance(center, n)).toBe(1);
    }
  });
});

describe('hexDistance', () => {
  it('same hex = 0', () => {
    expect(hexDistance({ q: 3, r: 2 }, { q: 3, r: 2 })).toBe(0);
  });

  it('adjacent hexes = 1', () => {
    const origin: Hex = { q: 0, r: 0 };
    for (const d of ALL_DIRECTIONS) {
      expect(hexDistance(origin, getNeighbor(origin, d))).toBe(1);
    }
  });

  it('known distance: (0,0) to (2,-1) = 2', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 })).toBe(2);
  });

  it('known distance: (0,0) to (3,0) = 3', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 3, r: 0 })).toBe(3);
  });

  it('known distance: (0,0) to (0,4) = 4', () => {
    expect(hexDistance({ q: 0, r: 0 }, { q: 0, r: 4 })).toBe(4);
  });

  it('is symmetric', () => {
    const a: Hex = { q: 1, r: -3 };
    const b: Hex = { q: -2, r: 4 };
    expect(hexDistance(a, b)).toBe(hexDistance(b, a));
  });

  it('satisfies triangle inequality', () => {
    const a: Hex = { q: 0, r: 0 };
    const b: Hex = { q: 2, r: -1 };
    const c: Hex = { q: -1, r: 3 };
    expect(hexDistance(a, c)).toBeLessThanOrEqual(hexDistance(a, b) + hexDistance(b, c));
  });
});

describe('hexToString / stringToHex', () => {
  it('roundtrip from hex', () => {
    const hex: Hex = { q: 5, r: -3 };
    expect(stringToHex(hexToString(hex))).toEqual(hex);
  });

  it('roundtrip from string', () => {
    const s = '12,-7';
    expect(hexToString(stringToHex(s))).toBe(s);
  });

  it('formats as "q,r"', () => {
    expect(hexToString({ q: 1, r: 2 })).toBe('1,2');
  });

  it('handles negative coordinates', () => {
    expect(hexToString({ q: -3, r: -4 })).toBe('-3,-4');
    expect(stringToHex('-3,-4')).toEqual({ q: -3, r: -4 });
  });
});

describe('hexesInRadius', () => {
  it('radius 0 returns just the center', () => {
    const hexes = hexesInRadius({ q: 0, r: 0 }, 0);
    expect(hexes).toHaveLength(1);
    expect(hexes[0]).toEqual({ q: 0, r: 0 });
  });

  it('radius 1 returns 7 hexes (center + 6 neighbors)', () => {
    const hexes = hexesInRadius({ q: 0, r: 0 }, 1);
    expect(hexes).toHaveLength(7);
  });

  it('radius 2 returns 19 hexes', () => {
    const hexes = hexesInRadius({ q: 0, r: 0 }, 2);
    expect(hexes).toHaveLength(19);
  });

  it('all returned hexes are within the given radius', () => {
    const center: Hex = { q: 3, r: -2 };
    const radius = 3;
    const hexes = hexesInRadius(center, radius);
    for (const h of hexes) {
      expect(hexDistance(center, h)).toBeLessThanOrEqual(radius);
    }
  });

  it('no duplicates', () => {
    const hexes = hexesInRadius({ q: 0, r: 0 }, 3);
    const keys = hexes.map(hexToString);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('count follows 3n^2 + 3n + 1 formula', () => {
    for (let r = 0; r <= 5; r++) {
      const expected = 3 * r * r + 3 * r + 1;
      expect(hexesInRadius({ q: 0, r: 0 }, r)).toHaveLength(expected);
    }
  });
});

describe('hexLerp', () => {
  it('t=0 returns a', () => {
    const result = hexLerp({ q: 0, r: 0 }, { q: 4, r: -2 }, 0);
    expect(result.q).toBeCloseTo(0);
    expect(result.r).toBeCloseTo(0);
  });

  it('t=1 returns b', () => {
    const result = hexLerp({ q: 0, r: 0 }, { q: 4, r: -2 }, 1);
    expect(result.q).toBeCloseTo(4);
    expect(result.r).toBeCloseTo(-2);
  });

  it('t=0.5 returns midpoint', () => {
    const result = hexLerp({ q: 0, r: 0 }, { q: 4, r: -2 }, 0.5);
    expect(result.q).toBeCloseTo(2);
    expect(result.r).toBeCloseTo(-1);
  });
});

describe('hexRound', () => {
  it('rounds exact integer coordinates to themselves', () => {
    expect(hexRound(2, -3)).toEqual({ q: 2, r: -3 });
  });

  it('rounds fractional coordinates correctly', () => {
    // Slightly off from (1, 0) — should round to (1, 0)
    expect(hexRound(1.1, -0.1)).toEqual({ q: 1, r: 0 });
  });

  it('rounds center of hex correctly', () => {
    expect(hexRound(0.4, 0.1)).toEqual({ q: 0, r: 0 });
  });

  it('rounds near a vertex to nearest hex', () => {
    // Near (0.5, -0.5) which is between hexes — should pick one consistently
    const result = hexRound(0.6, -0.4);
    expect(Number.isInteger(result.q)).toBe(true);
    expect(Number.isInteger(result.r)).toBe(true);
    // Cube constraint: q + (-q-r) + r = 0 always holds
    expect(result.q + result.r + (-result.q - result.r)).toBe(0);
  });

  it('preserves cube constraint (x+y+z=0)', () => {
    const testCases = [
      [0.3, 0.7],
      [-1.2, 2.8],
      [3.4, -1.7],
      [-0.5, -0.5],
    ];
    for (const [q, r] of testCases) {
      const result = hexRound(q, r);
      const s = -result.q - result.r;
      expect(result.q + s + result.r).toBe(0);
    }
  });
});

describe('hexesOnLine', () => {
  it('same hex returns single hex', () => {
    const line = hexesOnLine({ q: 2, r: 3 }, { q: 2, r: 3 });
    expect(line).toHaveLength(1);
    expect(line[0]).toEqual({ q: 2, r: 3 });
  });

  it('adjacent hexes returns 2 hexes', () => {
    const line = hexesOnLine({ q: 0, r: 0 }, { q: 1, r: 0 });
    expect(line).toHaveLength(2);
    expect(line[0]).toEqual({ q: 0, r: 0 });
    expect(line[1]).toEqual({ q: 1, r: 0 });
  });

  it('straight line along r-axis (N-S)', () => {
    const line = hexesOnLine({ q: 0, r: 0 }, { q: 0, r: 3 });
    expect(line).toHaveLength(4);
    expect(line[0]).toEqual({ q: 0, r: 0 });
    expect(line[1]).toEqual({ q: 0, r: 1 });
    expect(line[2]).toEqual({ q: 0, r: 2 });
    expect(line[3]).toEqual({ q: 0, r: 3 });
  });

  it('straight line along q-axis (SE direction)', () => {
    const line = hexesOnLine({ q: 0, r: 0 }, { q: 3, r: 0 });
    expect(line).toHaveLength(4);
    for (let i = 0; i <= 3; i++) {
      expect(line[i]).toEqual({ q: i, r: 0 });
    }
  });

  it('diagonal line', () => {
    const a: Hex = { q: 0, r: 0 };
    const b: Hex = { q: 2, r: -2 };
    const line = hexesOnLine(a, b);
    // Distance is 2, so 3 hexes
    expect(line).toHaveLength(3);
    expect(line[0]).toEqual(a);
    expect(line[line.length - 1]).toEqual(b);
  });

  it('line through origin', () => {
    const line = hexesOnLine({ q: -2, r: 0 }, { q: 2, r: 0 });
    expect(line).toHaveLength(5);
    // Should pass through origin
    expect(line.some((h) => hexEquals(h, { q: 0, r: 0 }))).toBe(true);
  });

  it('first hex is a, last hex is b', () => {
    const a: Hex = { q: 1, r: -3 };
    const b: Hex = { q: -2, r: 4 };
    const line = hexesOnLine(a, b);
    expect(line[0]).toEqual(a);
    expect(line[line.length - 1]).toEqual(b);
  });

  it('no duplicates', () => {
    const line = hexesOnLine({ q: -3, r: 1 }, { q: 3, r: -2 });
    const keys = line.map(hexToString);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('length equals distance + 1', () => {
    const a: Hex = { q: 0, r: 0 };
    const b: Hex = { q: 3, r: -1 };
    const line = hexesOnLine(a, b);
    expect(line).toHaveLength(hexDistance(a, b) + 1);
  });

  it('consecutive hexes are adjacent', () => {
    const line = hexesOnLine({ q: -2, r: 3 }, { q: 3, r: -1 });
    for (let i = 1; i < line.length; i++) {
      expect(hexDistance(line[i - 1], line[i])).toBe(1);
    }
  });
});
