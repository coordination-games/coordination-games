import { describe, expect, it } from 'vitest';
import { type Hex, hexesInRadius, hexToString } from '../hex.js';
import { getVisibleHexes, hasLineOfSight } from '../los.js';

function wallSet(...hexes: Hex[]): Set<string> {
  return new Set(hexes.map(hexToString));
}

function allHexesInRadius(center: Hex, radius: number): Set<string> {
  return new Set(hexesInRadius(center, radius).map(hexToString));
}

describe('hasLineOfSight', () => {
  it('clear LoS with no walls', () => {
    const from: Hex = { q: 0, r: 0 };
    const to: Hex = { q: 3, r: 0 };
    expect(hasLineOfSight(from, to, new Set())).toBe(true);
  });

  it('LoS blocked by wall between two hexes', () => {
    const from: Hex = { q: 0, r: 0 };
    const to: Hex = { q: 3, r: 0 };
    // Wall at (1,0) or (2,0) should block
    const walls = wallSet({ q: 2, r: 0 });
    expect(hasLineOfSight(from, to, walls)).toBe(false);
  });

  it('LoS not blocked by wall at start position', () => {
    const from: Hex = { q: 0, r: 0 };
    const to: Hex = { q: 3, r: 0 };
    const walls = wallSet({ q: 0, r: 0 });
    expect(hasLineOfSight(from, to, walls)).toBe(true);
  });

  it('LoS not blocked by wall at end position', () => {
    const from: Hex = { q: 0, r: 0 };
    const to: Hex = { q: 3, r: 0 };
    const walls = wallSet({ q: 3, r: 0 });
    expect(hasLineOfSight(from, to, walls)).toBe(true);
  });

  it('LoS through diagonal with wall adjacent but not blocking', () => {
    // Line from (0,0) to (2,-2) goes through (1,-1)
    // Wall at (1,0) is adjacent but not on the line
    const from: Hex = { q: 0, r: 0 };
    const to: Hex = { q: 2, r: -2 };
    const walls = wallSet({ q: 1, r: 0 });
    expect(hasLineOfSight(from, to, walls)).toBe(true);
  });

  it('adjacent hexes always have LoS (no intermediate hexes to block)', () => {
    const from: Hex = { q: 0, r: 0 };
    const to: Hex = { q: 1, r: 0 };
    // Even if both from and to are "walls", there are no intermediate hexes
    const walls = wallSet({ q: 0, r: 0 }, { q: 1, r: 0 });
    expect(hasLineOfSight(from, to, walls)).toBe(true);
  });

  it('same hex always has LoS', () => {
    const hex: Hex = { q: 2, r: 3 };
    const walls = wallSet({ q: 2, r: 3 });
    expect(hasLineOfSight(hex, hex, walls)).toBe(true);
  });
});

describe('getVisibleHexes', () => {
  it('open area with no walls = all hexes in radius', () => {
    const pos: Hex = { q: 0, r: 0 };
    const radius = 2;
    const all = allHexesInRadius(pos, radius);
    const visible = getVisibleHexes(pos, radius, new Set(), all);
    expect(visible.size).toBe(all.size);
    for (const key of all) {
      expect(visible.has(key)).toBe(true);
    }
  });

  it('wall blocks hexes behind it', () => {
    const pos: Hex = { q: 0, r: 0 };
    const radius = 3;
    const all = allHexesInRadius(pos, radius);
    // Place a wall at (1,0) — should block (2,0) and (3,0)
    const walls = wallSet({ q: 1, r: 0 });
    const visible = getVisibleHexes(pos, radius, walls, all);

    // The wall itself should be visible
    expect(visible.has(hexToString({ q: 1, r: 0 }))).toBe(true);
    // Hex directly behind the wall should be blocked
    expect(visible.has(hexToString({ q: 2, r: 0 }))).toBe(false);
    expect(visible.has(hexToString({ q: 3, r: 0 }))).toBe(false);
  });

  it('walls themselves are visible', () => {
    const pos: Hex = { q: 0, r: 0 };
    const radius = 3;
    const all = allHexesInRadius(pos, radius);
    const walls = wallSet({ q: 2, r: 0 });
    const visible = getVisibleHexes(pos, radius, walls, all);

    // The wall hex should be visible (you can see a wall)
    expect(visible.has(hexToString({ q: 2, r: 0 }))).toBe(true);
    // But hex behind the wall is blocked
    expect(visible.has(hexToString({ q: 3, r: 0 }))).toBe(false);
  });

  it('radius 0 = just your own hex', () => {
    const pos: Hex = { q: 5, r: 3 };
    const all = allHexesInRadius(pos, 5); // big map
    const visible = getVisibleHexes(pos, 0, new Set(), all);
    expect(visible.size).toBe(1);
    expect(visible.has(hexToString(pos))).toBe(true);
  });

  it('position hex is always visible even if it is a wall', () => {
    const pos: Hex = { q: 0, r: 0 };
    const all = allHexesInRadius(pos, 2);
    const walls = wallSet({ q: 0, r: 0 });
    const visible = getVisibleHexes(pos, 2, walls, all);
    expect(visible.has(hexToString(pos))).toBe(true);
  });

  it('only includes hexes that exist in allHexes', () => {
    const pos: Hex = { q: 0, r: 0 };
    // Create a small map that doesn't include all hexes in radius
    const all = new Set([hexToString({ q: 0, r: 0 }), hexToString({ q: 1, r: 0 })]);
    const visible = getVisibleHexes(pos, 3, new Set(), all);
    expect(visible.size).toBe(2);
    expect(visible.has(hexToString({ q: 2, r: 0 }))).toBe(false);
  });
});
