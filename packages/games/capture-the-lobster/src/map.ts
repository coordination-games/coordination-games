// Procedural map generator for Capture the Lobster
// Generates rotationally symmetric hex maps with bases, walls, and chokepoints

import {
  getNeighbors,
  type Hex,
  hexDistance,
  hexesInRadius,
  hexToString,
  stringToHex,
} from './hex.js';

export type TileType = 'ground' | 'wall' | 'base_a' | 'base_b';

export interface BaseLocation {
  flag: Hex;
  spawns: Hex[];
}

export interface GameMap {
  tiles: Map<string, TileType>;
  radius: number;
  bases: {
    A: BaseLocation[];
    B: BaseLocation[];
  };
}

export interface MapConfig {
  radius?: number;
  wallDensity?: number;
  seed?: string;
  teamSize?: number;
}

// --- Team size scaling ---

/** Map radius (internal, before border ring) for a given team size */
export function getMapRadiusForTeamSize(teamSize: number): number {
  const table: Record<number, number> = { 2: 5, 3: 6, 4: 7, 5: 8, 6: 9 };
  return table[teamSize] ?? Math.max(5, teamSize + 3);
}

/** Number of flags per team for a given team size */
export function getFlagCountForTeamSize(teamSize: number): number {
  return teamSize >= 5 ? 2 : 1;
}

// --- Seeded PRNG (mulberry32) ---

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Hex rotation (180°): (q,r) -> (-q,-r) ---

function rotate180(hex: Hex): Hex {
  return { q: -hex.q, r: -hex.r };
}

// --- BFS connectivity check ---

function bfsReachable(
  start: string,
  passable: (key: string) => boolean,
  allKeys: Set<string>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [start];
  visited.add(start);
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
    const current = queue.shift()!;
    const hex = stringToHex(current);
    for (const neighbor of getNeighbors(hex)) {
      const key = hexToString(neighbor);
      if (!visited.has(key) && allKeys.has(key) && passable(key)) {
        visited.add(key);
        queue.push(key);
      }
    }
  }
  return visited;
}

// --- Main generator ---

export function generateMap(config?: MapConfig): GameMap {
  const radius = config?.radius ?? 8;
  const wallDensity = config?.wallDensity ?? 0.15;
  const seedStr = config?.seed ?? String(Date.now());
  const rng = mulberry32(hashSeed(seedStr));

  // 1. Create all hexes as ground
  const allHexes = hexesInRadius({ q: 0, r: 0 }, radius);
  const tiles = new Map<string, TileType>();
  for (const hex of allHexes) {
    tiles.set(hexToString(hex), 'ground');
  }
  const allKeys = new Set(tiles.keys());

  // 2. Place bases — flags inward by 1 hex so all 6 neighbors are in bounds
  const teamSize = config?.teamSize ?? 2;
  const flagCount = getFlagCountForTeamSize(teamSize);
  // Spawns per base = ceil(teamSize / flagCount) so all players can spawn
  const spawnsPerBase = Math.ceil(teamSize / flagCount);

  // Base positions: first pair on north/south axis, second pair (if needed) on diagonal
  const flagPositionsA: Hex[] = [{ q: 0, r: radius - 1 }];
  // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
  const flagPositionsB: Hex[] = [rotate180(flagPositionsA[0])];

  if (flagCount >= 2) {
    // Second flag pair on the NE/SW axis (60° rotation of the first)
    // Hex 60° rotation: (q,r) -> (-r, q+r)
    const rotated = { q: -(radius - 1), r: radius - 1 };
    flagPositionsA.push(rotated);
    flagPositionsB.push(rotate180(rotated));
  }

  // Mark base tiles and find spawns
  const baseAKeys = new Set<string>();
  const baseBKeys = new Set<string>();

  function pickSpawns(
    flag: Hex,
    baseType: TileType,
    baseKeySet: Set<string>,
    count: number,
  ): Hex[] {
    const neighbors = getNeighbors(flag).filter((n) => tiles.has(hexToString(n)));
    // Distribute spawns evenly around the flag by spacing indices
    // getNeighbors returns 6 directions: N, NE, SE, S, SW, NW (indices 0-5)
    // For count=2: pick indices 0,3 (opposite sides)
    // For count=3: pick indices 0,2,4 (every other)
    // For count=4: pick indices 0,1,3,4 (skip 2 and 5 — balanced)
    // For count=5: pick indices 0,1,2,3,4 (skip 5)
    // For count=6: all
    const available = neighbors.length;
    let indices: number[];
    if (count >= available) {
      indices = Array.from({ length: available }, (_, i) => i);
    } else if (count === 1) {
      indices = [0];
    } else {
      // Evenly space around the ring
      indices = [];
      for (let i = 0; i < count; i++) {
        indices.push(Math.round((i * available) / count) % available);
      }
    }
    const spawns = indices.map((i) => neighbors[i]);
    for (const s of spawns) {
      // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
      const key = hexToString(s);
      tiles.set(key, baseType);
      baseKeySet.add(key);
    }
    // @ts-expect-error TS2322: Type '(Hex | undefined)[]' is not assignable to type 'Hex[]'. — TODO(2.3-followup)
    return spawns;
  }

  const basesA: BaseLocation[] = [];
  const basesB: BaseLocation[] = [];

  for (let i = 0; i < flagCount; i++) {
    // Team A flag
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    tiles.set(hexToString(flagPositionsA[i]), 'base_a');
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    baseAKeys.add(hexToString(flagPositionsA[i]));
    // Mark ALL neighbors of the flag as base tiles (castle walls around the keep)
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    for (const n of getNeighbors(flagPositionsA[i])) {
      const nk = hexToString(n);
      if (tiles.has(nk) && !baseAKeys.has(nk)) {
        tiles.set(nk, 'base_a');
        baseAKeys.add(nk);
      }
    }
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    const spawnsA = pickSpawns(flagPositionsA[i], 'base_a', baseAKeys, spawnsPerBase);
    // @ts-expect-error TS2322: Type 'Hex | undefined' is not assignable to type 'Hex'. — TODO(2.3-followup)
    basesA.push({ flag: flagPositionsA[i], spawns: spawnsA });

    // Team B flag (180° mirror)
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    tiles.set(hexToString(flagPositionsB[i]), 'base_b');
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    baseBKeys.add(hexToString(flagPositionsB[i]));
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    for (const n of getNeighbors(flagPositionsB[i])) {
      const nk = hexToString(n);
      if (tiles.has(nk) && !baseBKeys.has(nk)) {
        tiles.set(nk, 'base_b');
        baseBKeys.add(nk);
      }
    }
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    const spawnsB = pickSpawns(flagPositionsB[i], 'base_b', baseBKeys, spawnsPerBase);
    // @ts-expect-error TS2322: Type 'Hex | undefined' is not assignable to type 'Hex'. — TODO(2.3-followup)
    basesB.push({ flag: flagPositionsB[i], spawns: spawnsB });
  }

  // Collect all protected hexes (bases + buffer around bases + corridor around center)
  const protectedKeys = new Set<string>();

  // Protect base hexes and a small buffer around them
  for (const key of baseAKeys) protectedKeys.add(key);
  for (const key of baseBKeys) protectedKeys.add(key);

  // Buffer: 1 hex around each base tile
  for (const key of [...baseAKeys, ...baseBKeys]) {
    const hex = stringToHex(key);
    for (const n of getNeighbors(hex)) {
      const nk = hexToString(n);
      if (tiles.has(nk)) protectedKeys.add(nk);
    }
  }

  // Protect a corridor around center (radius 2)
  for (const hex of hexesInRadius({ q: 0, r: 0 }, 2)) {
    protectedKeys.add(hexToString(hex));
  }

  // 3. Generate walls with seeded RNG and rotational symmetry
  const wallKeys = new Set<string>();

  // Skip wall generation entirely if density is 0
  if (wallDensity <= 0) {
    return {
      tiles,
      radius,
      bases: { A: basesA, B: basesB },
    };
  }

  // Calculate how many wall seed points we need.
  // Each seed will grow ~2-3 tiles, so we need fewer seeds than total desired walls.
  const totalTiles = tiles.size;
  const targetWalls = Math.floor(totalTiles * wallDensity);
  // Each seed pair (symmetric) produces ~4-6 wall tiles total
  const seedCount = Math.max(1, Math.floor(targetWalls / 5));

  // Collect candidate tiles (not protected)
  const candidates: string[] = [];
  for (const key of allKeys) {
    if (!protectedKeys.has(key)) {
      candidates.push(key);
    }
  }

  // Only consider candidates in one half (r > 0 or q > 0 when r == 0) for symmetry
  // We'll mirror each wall placement
  const halfCandidates = candidates.filter((key) => {
    const hex = stringToHex(key);
    return hex.r > 0 || (hex.r === 0 && hex.q > 0);
  });

  // Shuffle half candidates
  for (let i = halfCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    // @ts-expect-error TS2322: Type 'string | undefined' is not assignable to type 'string'. — TODO(2.3-followup)
    [halfCandidates[i], halfCandidates[j]] = [halfCandidates[j], halfCandidates[i]];
  }

  // Place wall seeds
  const wallSeeds: string[] = [];
  for (let i = 0; i < Math.min(seedCount, halfCandidates.length); i++) {
    const key = halfCandidates[i];
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    const hex = stringToHex(key);
    const mirrorKey = hexToString(rotate180(hex));

    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    if (!protectedKeys.has(key) && !protectedKeys.has(mirrorKey)) {
      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      wallKeys.add(key);
      wallKeys.add(mirrorKey);
      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      wallSeeds.push(key);
    }
  }

  // Grow walls from seeds (1-2 growth steps)
  for (const seedKey of wallSeeds) {
    const seedHex = stringToHex(seedKey);
    const neighbors = getNeighbors(seedHex);

    // Shuffle neighbors for randomness
    for (let i = neighbors.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      // @ts-expect-error TS2322: Type 'Hex | undefined' is not assignable to type 'Hex'. — TODO(2.3-followup)
      [neighbors[i], neighbors[j]] = [neighbors[j], neighbors[i]];
    }

    // Grow 1-2 neighbors into walls
    const growCount = 1 + Math.floor(rng() * 2);
    let grown = 0;
    for (const n of neighbors) {
      if (grown >= growCount) break;
      const nk = hexToString(n);
      const mirrorN = rotate180(n);
      const mirrorNk = hexToString(mirrorN);
      if (
        tiles.has(nk) &&
        tiles.has(mirrorNk) &&
        !protectedKeys.has(nk) &&
        !protectedKeys.has(mirrorNk) &&
        !wallKeys.has(nk)
      ) {
        wallKeys.add(nk);
        wallKeys.add(mirrorNk);
        grown++;
      }
    }
  }

  // 4. Create chokepoints: add some walls near the equator (r ≈ 0) to narrow passages
  // Find tiles near the horizontal midline but outside the center corridor
  const midCandidates = candidates.filter((key) => {
    const hex = stringToHex(key);
    const absR = Math.abs(hex.r);
    const dist = hexDistance(hex, { q: 0, r: 0 });
    return absR <= 2 && dist > 2 && dist <= radius - 1 && !protectedKeys.has(key);
  });

  // Shuffle and pick some for chokepoint walls
  for (let i = midCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    // @ts-expect-error TS2322: Type 'string | undefined' is not assignable to type 'string'. — TODO(2.3-followup)
    [midCandidates[i], midCandidates[j]] = [midCandidates[j], midCandidates[i]];
  }

  const chokepointCount = Math.max(1, Math.floor(radius * 0.4));
  for (let i = 0; i < Math.min(chokepointCount, midCandidates.length); i++) {
    const key = midCandidates[i];
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    const hex = stringToHex(key);
    const mirrorKey = hexToString(rotate180(hex));
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    if (!protectedKeys.has(key) && !protectedKeys.has(mirrorKey) && tiles.has(mirrorKey)) {
      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      wallKeys.add(key);
      wallKeys.add(mirrorKey);
    }
  }

  // 5. Apply walls to tile map
  for (const key of wallKeys) {
    tiles.set(key, 'wall');
  }

  // 6. Ensure connectivity: BFS from each flag A to each flag B
  for (const baseA of basesA) {
    for (const baseB of basesB) {
      ensureConnectivity(tiles, allKeys, baseA.flag, baseB.flag, wallKeys, protectedKeys);
    }
  }

  // 7. Add forest border ring around the playable area
  // All hexes at radius+1 become wall tiles (visual boundary)
  const borderHexes = hexesInRadius({ q: 0, r: 0 }, radius + 1).filter(
    (h) => hexDistance(h, { q: 0, r: 0 }) === radius + 1,
  );
  for (const hex of borderHexes) {
    const key = hexToString(hex);
    if (!tiles.has(key)) {
      tiles.set(key, 'wall');
    }
  }

  return {
    tiles,
    radius: radius + 1, // Include the border ring in the reported radius
    bases: { A: basesA, B: basesB },
  };
}

function ensureConnectivity(
  tiles: Map<string, TileType>,
  allKeys: Set<string>,
  flagA: Hex,
  flagB: Hex,
  wallKeys: Set<string>,
  _protectedKeys: Set<string>,
): void {
  const flagAKey = hexToString(flagA);
  const flagBKey = hexToString(flagB);

  const isPassable = (key: string) => tiles.get(key) !== 'wall';

  // Check if already connected
  let reachable = bfsReachable(flagAKey, isPassable, allKeys);
  if (reachable.has(flagBKey)) return;

  // Not connected — remove walls to create a path.
  // Strategy: BFS on ALL tiles (ignoring walls) from flagA, recording parent.
  // Then trace path from flagB and remove walls along it.
  const parent = new Map<string, string>();
  const visited = new Set<string>();
  const queue: string[] = [flagAKey];
  visited.add(flagAKey);

  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
    const current = queue.shift()!;
    if (current === flagBKey) break;
    const hex = stringToHex(current);
    const neighbors = getNeighbors(hex);

    // Prefer non-wall neighbors first (greedy: try to reuse existing ground)
    neighbors.sort((a, b) => {
      const aWall = tiles.get(hexToString(a)) === 'wall' ? 1 : 0;
      const bWall = tiles.get(hexToString(b)) === 'wall' ? 1 : 0;
      return aWall - bWall;
    });

    for (const n of neighbors) {
      const nk = hexToString(n);
      if (!visited.has(nk) && allKeys.has(nk)) {
        visited.add(nk);
        parent.set(nk, current);
        queue.push(nk);
      }
    }
  }

  // Trace path from flagB back to flagA and remove walls
  let current = flagBKey;
  while (current !== flagAKey && parent.has(current)) {
    if (tiles.get(current) === 'wall') {
      tiles.set(current, 'ground');
      wallKeys.delete(current);

      // Maintain symmetry: also remove the mirror wall
      const hex = stringToHex(current);
      const mirrorKey = hexToString(rotate180(hex));
      if (tiles.get(mirrorKey) === 'wall') {
        tiles.set(mirrorKey, 'ground');
        wallKeys.delete(mirrorKey);
      }
    }
    // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
    current = parent.get(current)!;
  }

  // Verify connectivity after fix
  reachable = bfsReachable(flagAKey, isPassable, allKeys);
  if (!reachable.has(flagBKey)) {
    // Last resort: clear all walls (should never happen with BFS path clearing)
    for (const key of wallKeys) {
      tiles.set(key, 'ground');
    }
    wallKeys.clear();
  }
}
