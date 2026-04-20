import { describe, expect, it } from 'vitest';
import {
  getNeighbors,
  hexDistance,
  hexEquals,
  hexesInRadius,
  hexToString,
  stringToHex,
} from '../hex.js';
import { generateMap, type TileType } from '../map.js';

function bfsReachable(startKey: string, tiles: Map<string, TileType>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [startKey];
  visited.add(startKey);
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
    const current = queue.shift()!;
    const hex = stringToHex(current);
    for (const n of getNeighbors(hex)) {
      const key = hexToString(n);
      if (!visited.has(key) && tiles.has(key) && tiles.get(key) !== 'wall') {
        visited.add(key);
        queue.push(key);
      }
    }
  }
  return visited;
}

describe('generateMap', () => {
  it('creates all hexes within the given radius (plus border ring)', () => {
    const map = generateMap({ radius: 6, seed: 'radius-test' });
    // generateMap adds a border ring at radius+1 and reports radius+1
    const expected = hexesInRadius({ q: 0, r: 0 }, 7);
    expect(map.tiles.size).toBe(expected.length);
    for (const hex of expected) {
      expect(map.tiles.has(hexToString(hex))).toBe(true);
    }
    expect(map.radius).toBe(7); // includes border ring
  });

  it('uses default radius of 8 when not specified', () => {
    const map = generateMap({ seed: 'default-radius' });
    // Default radius 8 + border ring = 9
    const expected = hexesInRadius({ q: 0, r: 0 }, 9);
    expect(map.tiles.size).toBe(expected.length);
    expect(map.radius).toBe(9);
  });

  it('places bases on opposite sides (A south, B north)', () => {
    const map = generateMap({ radius: 8, seed: 'bases-test' });
    const A = map.bases.A[0];
    const B = map.bases.B[0];

    // A flag should have high r (south), B flag should have low r (north)
    expect(A.flag.r).toBeGreaterThan(0);
    expect(B.flag.r).toBeLessThan(0);

    // They should be rotationally symmetric
    expect(A.flag.q).toBe(-B.flag.q);
    expect(A.flag.r).toBe(-B.flag.r);
  });

  it('base tiles are never walls', () => {
    const map = generateMap({ radius: 8, seed: 'base-walls-test' });
    const A = map.bases.A[0];
    const B = map.bases.B[0];

    // Flag hexes
    expect(map.tiles.get(hexToString(A.flag))).toBe('base_a');
    expect(map.tiles.get(hexToString(B.flag))).toBe('base_b');

    // Spawn hexes
    for (const spawn of A.spawns) {
      const tile = map.tiles.get(hexToString(spawn));
      expect(tile).toBe('base_a');
      expect(tile).not.toBe('wall');
    }
    for (const spawn of B.spawns) {
      const tile = map.tiles.get(hexToString(spawn));
      expect(tile).toBe('base_b');
      expect(tile).not.toBe('wall');
    }
  });

  it('spawn hexes are ground tiles adjacent to the flag', () => {
    const map = generateMap({ radius: 8, seed: 'spawns-test' });
    const A = map.bases.A[0];
    const B = map.bases.B[0];

    // All spawns should be distance 1 from flag
    for (const spawn of A.spawns) {
      expect(hexDistance(A.flag, spawn)).toBe(1);
    }
    for (const spawn of B.spawns) {
      expect(hexDistance(B.flag, spawn)).toBe(1);
    }

    // Spawn count depends on teamSize (default: ceil(teamSize/flagCount))
    expect(A.spawns.length).toBeGreaterThanOrEqual(1);
    expect(A.spawns.length).toBeLessThanOrEqual(6);
    expect(B.spawns.length).toBeGreaterThanOrEqual(1);
    expect(B.spawns.length).toBeLessThanOrEqual(6);
  });

  it('map is rotationally symmetric (walls mirror at 180°)', () => {
    const map = generateMap({ radius: 8, seed: 'symmetry-test' });

    for (const [key, type] of map.tiles) {
      const hex = stringToHex(key);
      const mirrorKey = hexToString({ q: -hex.q, r: -hex.r });
      const mirrorType = map.tiles.get(mirrorKey);

      if (type === 'wall') {
        expect(mirrorType).toBe('wall');
      }
      if (type === 'base_a') {
        expect(mirrorType).toBe('base_b');
      }
      if (type === 'base_b') {
        expect(mirrorType).toBe('base_a');
      }
    }
  });

  it('map is connected (BFS from base A flag reaches base B flag)', () => {
    // Test with multiple seeds to be thorough
    const seeds = ['conn-1', 'conn-2', 'conn-3', 'conn-4', 'conn-5'];
    for (const seed of seeds) {
      const map = generateMap({ radius: 8, seed });
      const flagAKey = hexToString(map.bases.A[0].flag);
      const flagBKey = hexToString(map.bases.B[0].flag);
      const reachable = bfsReachable(flagAKey, map.tiles);
      expect(reachable.has(flagBKey)).toBe(true);
    }
  });

  it('same seed produces the same map', () => {
    const map1 = generateMap({ radius: 8, seed: 'deterministic' });
    const map2 = generateMap({ radius: 8, seed: 'deterministic' });

    expect(map1.tiles.size).toBe(map2.tiles.size);
    for (const [key, type] of map1.tiles) {
      expect(map2.tiles.get(key)).toBe(type);
    }

    expect(hexEquals(map1.bases.A[0].flag, map2.bases.A[0].flag)).toBe(true);
    expect(hexEquals(map1.bases.B[0].flag, map2.bases.B[0].flag)).toBe(true);
  });

  it('different seeds produce different maps', () => {
    const map1 = generateMap({ radius: 8, seed: 'seed-alpha' });
    const map2 = generateMap({ radius: 8, seed: 'seed-beta' });

    let differences = 0;
    for (const [key, type] of map1.tiles) {
      if (map2.tiles.get(key) !== type) differences++;
    }
    expect(differences).toBeGreaterThan(0);
  });

  it('wall density is roughly correct', () => {
    const density = 0.15;
    const map = generateMap({ radius: 8, wallDensity: density, seed: 'density-test' });

    let wallCount = 0;
    let totalCount = 0;
    for (const [, type] of map.tiles) {
      totalCount++;
      if (type === 'wall') wallCount++;
    }

    const actualDensity = wallCount / totalCount;
    // Allow generous tolerance — wall removal for connectivity and base protection
    // means actual density will often be lower than requested
    expect(actualDensity).toBeGreaterThan(0.02);
    expect(actualDensity).toBeLessThan(0.35);
  });

  it('works with small radius', () => {
    const map = generateMap({ radius: 3, seed: 'small-map' });
    // radius 3 + border ring = radius 4
    const expected = hexesInRadius({ q: 0, r: 0 }, 4);
    expect(map.tiles.size).toBe(expected.length);

    // Should still be connected
    const flagAKey = hexToString(map.bases.A[0].flag);
    const flagBKey = hexToString(map.bases.B[0].flag);
    const reachable = bfsReachable(flagAKey, map.tiles);
    expect(reachable.has(flagBKey)).toBe(true);
  });

  it('works with zero wall density', () => {
    const map = generateMap({ radius: 6, wallDensity: 0, seed: 'no-walls' });
    let wallCount = 0;
    for (const [, type] of map.tiles) {
      if (type === 'wall') wallCount++;
    }
    expect(wallCount).toBe(0);
  });

  it('connectivity holds under high wall density', () => {
    const map = generateMap({ radius: 8, wallDensity: 0.4, seed: 'dense-walls' });
    const flagAKey = hexToString(map.bases.A[0].flag);
    const flagBKey = hexToString(map.bases.B[0].flag);
    const reachable = bfsReachable(flagAKey, map.tiles);
    expect(reachable.has(flagBKey)).toBe(true);
  });
});
