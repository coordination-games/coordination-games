import { describe, expect, it } from 'vitest';
import { buildVisibleState, type FogUnit, getUnitVision } from '../fog.js';
import { type Hex, hexesInRadius, hexToString } from '../hex.js';

function makeAllHexes(center: Hex, radius: number): Set<string> {
  return new Set(hexesInRadius(center, radius).map(hexToString));
}

function wallSet(...hexes: Hex[]): Set<string> {
  return new Set(hexes.map(hexToString));
}

function makeTiles(center: Hex, radius: number, walls: Set<string>): Map<string, string> {
  const tiles = new Map<string, string>();
  for (const hex of hexesInRadius(center, radius)) {
    const key = hexToString(hex);
    tiles.set(key, walls.has(key) ? 'wall' : 'ground');
  }
  return tiles;
}

const defaultFlags = {
  A: { position: { q: -10, r: 0 }, carried: false },
  B: { position: { q: 10, r: 0 }, carried: false },
};

describe('getUnitVision', () => {
  it('returns correct hexes for rogue (radius 4)', () => {
    const unit: FogUnit = {
      id: 'r1',
      team: 'A',
      unitClass: 'rogue',
      position: { q: 0, r: 0 },
      alive: true,
    };
    const allHexes = makeAllHexes({ q: 0, r: 0 }, 6);
    const visible = getUnitVision(unit, new Set(), allHexes);

    // Rogue vision = 4; all hexes within distance 4 should be visible (no walls)
    const expectedHexes = makeAllHexes({ q: 0, r: 0 }, 4);
    expect(visible.size).toBe(expectedHexes.size);
    for (const key of expectedHexes) {
      expect(visible.has(key)).toBe(true);
    }
    // Hex at distance 5 should NOT be visible
    expect(visible.has(hexToString({ q: 5, r: 0 }))).toBe(false);
  });

  it('returns correct hexes for knight (radius 2)', () => {
    const unit: FogUnit = {
      id: 'k1',
      team: 'A',
      unitClass: 'knight',
      position: { q: 0, r: 0 },
      alive: true,
    };
    const allHexes = makeAllHexes({ q: 0, r: 0 }, 5);
    const visible = getUnitVision(unit, new Set(), allHexes);

    const expectedHexes = makeAllHexes({ q: 0, r: 0 }, 2);
    expect(visible.size).toBe(expectedHexes.size);
    for (const key of expectedHexes) {
      expect(visible.has(key)).toBe(true);
    }
    // Hex at distance 3 should NOT be visible
    expect(visible.has(hexToString({ q: 3, r: 0 }))).toBe(false);
  });

  it('walls block vision', () => {
    const unit: FogUnit = {
      id: 'r1',
      team: 'A',
      unitClass: 'rogue',
      position: { q: 0, r: 0 },
      alive: true,
    };
    const allHexes = makeAllHexes({ q: 0, r: 0 }, 5);
    // Wall at (1,0) blocks vision along the SE axis
    const walls = wallSet({ q: 1, r: 0 });
    const visible = getUnitVision(unit, walls, allHexes);

    // Wall itself is visible
    expect(visible.has(hexToString({ q: 1, r: 0 }))).toBe(true);
    // Hex behind wall is blocked
    expect(visible.has(hexToString({ q: 2, r: 0 }))).toBe(false);
    expect(visible.has(hexToString({ q: 3, r: 0 }))).toBe(false);
  });
});

describe('buildVisibleState', () => {
  it('allies show unit ID, enemies do not', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'mage',
      position: { q: 0, r: 0 },
      alive: true,
    };
    const ally: FogUnit = {
      id: 'a2',
      team: 'A',
      unitClass: 'knight',
      position: { q: 1, r: 0 },
      alive: true,
    };
    const enemy: FogUnit = {
      id: 'b1',
      team: 'B',
      unitClass: 'rogue',
      position: { q: 0, r: -1 },
      alive: true,
    };

    const walls = new Set<string>();
    const tiles = makeTiles({ q: 0, r: 0 }, 4, walls);

    const result = buildVisibleState(viewer, [viewer, ally, enemy], walls, tiles, defaultFlags);

    const allyTile = result.find((t) => t.q === 1 && t.r === 0);
    expect(allyTile?.unit).toBeDefined();
    expect(allyTile?.unit?.id).toBe('a2');
    expect(allyTile?.unit?.team).toBe('A');
    expect(allyTile?.unit?.unitClass).toBe('knight');

    const enemyTile = result.find((t) => t.q === 0 && t.r === -1);
    expect(enemyTile?.unit).toBeDefined();
    expect(enemyTile?.unit?.id).toBeUndefined();
    expect(enemyTile?.unit?.team).toBe('B');
    expect(enemyTile?.unit?.unitClass).toBe('rogue');
  });

  it('dead units are not visible', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'mage',
      position: { q: 0, r: 0 },
      alive: true,
    };
    const deadEnemy: FogUnit = {
      id: 'b1',
      team: 'B',
      unitClass: 'rogue',
      position: { q: 1, r: 0 },
      alive: false,
    };

    const walls = new Set<string>();
    const tiles = makeTiles({ q: 0, r: 0 }, 4, walls);

    const result = buildVisibleState(viewer, [viewer, deadEnemy], walls, tiles, defaultFlags);

    const enemyTile = result.find((t) => t.q === 1 && t.r === 0);
    expect(enemyTile).toBeDefined();
    expect(enemyTile?.unit).toBeUndefined();
  });

  it('flag visible on its hex', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'mage',
      position: { q: 0, r: 0 },
      alive: true,
    };

    const walls = new Set<string>();
    const tiles = makeTiles({ q: 0, r: 0 }, 4, walls);

    const flags = {
      A: { position: { q: -2, r: 0 }, carried: false },
      B: { position: { q: 2, r: 0 }, carried: false },
    };

    const result = buildVisibleState(viewer, [viewer], walls, tiles, flags);

    const flagATile = result.find((t) => t.q === -2 && t.r === 0);
    expect(flagATile?.flag).toEqual({ team: 'A' });

    const flagBTile = result.find((t) => t.q === 2 && t.r === 0);
    expect(flagBTile?.flag).toEqual({ team: 'B' });
  });

  it('flag carried by visible unit shows on that unit tile', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'mage',
      position: { q: 0, r: 0 },
      alive: true,
    };
    const carrier: FogUnit = {
      id: 'a2',
      team: 'A',
      unitClass: 'rogue',
      position: { q: 1, r: 0 },
      alive: true,
    };

    const walls = new Set<string>();
    const tiles = makeTiles({ q: 0, r: 0 }, 4, walls);

    const flags = {
      A: { position: { q: -5, r: 0 }, carried: false },
      B: { position: { q: 5, r: 0 }, carried: true, carrierId: 'a2' },
    };

    const result = buildVisibleState(viewer, [viewer, carrier], walls, tiles, flags);

    const carrierTile = result.find((t) => t.q === 1 && t.r === 0);
    expect(carrierTile?.unit?.carryingFlag).toBe(true);
    expect(carrierTile?.flag).toEqual({ team: 'B' });
  });

  it('tiles outside vision are not included', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'knight', // vision = 2
      position: { q: 0, r: 0 },
      alive: true,
    };

    const walls = new Set<string>();
    const tiles = makeTiles({ q: 0, r: 0 }, 6, walls);

    const result = buildVisibleState(viewer, [viewer], walls, tiles, defaultFlags);

    // Knight vision = 2, so hex at distance 3 should not be in result
    const farTile = result.find((t) => t.q === 3 && t.r === 0);
    expect(farTile).toBeUndefined();

    // But hex at distance 2 should be present
    const nearTile = result.find((t) => t.q === 2 && t.r === 0);
    expect(nearTile).toBeDefined();
  });

  it('wall tiles are visible with type wall but block further vision', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'rogue', // vision = 4
      position: { q: 0, r: 0 },
      alive: true,
    };

    const walls = wallSet({ q: 1, r: 0 });
    const tiles = makeTiles({ q: 0, r: 0 }, 5, walls);

    const result = buildVisibleState(viewer, [viewer], walls, tiles, defaultFlags);

    // Wall tile itself is visible and has type 'wall'
    const wallTile = result.find((t) => t.q === 1 && t.r === 0);
    expect(wallTile).toBeDefined();
    expect(wallTile?.type).toBe('wall');

    // Tile behind wall is NOT visible
    const behindWall = result.find((t) => t.q === 2 && t.r === 0);
    expect(behindWall).toBeUndefined();
  });

  it("viewer's own tile is always included", () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'knight',
      position: { q: 3, r: 2 },
      alive: true,
    };

    const walls = new Set<string>();
    const tiles = makeTiles({ q: 3, r: 2 }, 5, walls);

    const result = buildVisibleState(viewer, [viewer], walls, tiles, defaultFlags);

    const ownTile = result.find((t) => t.q === 3 && t.r === 2);
    expect(ownTile).toBeDefined();
    expect(ownTile?.unit?.id).toBe('a1');
    expect(ownTile?.unit?.team).toBe('A');
  });
});
