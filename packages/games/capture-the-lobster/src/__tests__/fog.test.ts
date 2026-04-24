import { describe, expect, it } from 'vitest';
import { buildVisibleOccupants, type FogUnit, getUnitVision } from '../fog.js';
import { type Hex, hexesInRadius, hexToString } from '../hex.js';

function makeAllHexes(center: Hex, radius: number): Set<string> {
  return new Set(hexesInRadius(center, radius).map(hexToString));
}

function wallSet(...hexes: Hex[]): Set<string> {
  return new Set(hexes.map(hexToString));
}

const noFlags = {
  A: [{ position: { q: -10, r: 0 }, carried: false }],
  B: [{ position: { q: 10, r: 0 }, carried: false }],
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

    const expectedHexes = makeAllHexes({ q: 0, r: 0 }, 4);
    expect(visible.size).toBe(expectedHexes.size);
    for (const key of expectedHexes) {
      expect(visible.has(key)).toBe(true);
    }
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
    const walls = wallSet({ q: 1, r: 0 });
    const visible = getUnitVision(unit, walls, allHexes);

    expect(visible.has(hexToString({ q: 1, r: 0 }))).toBe(true);
    expect(visible.has(hexToString({ q: 2, r: 0 }))).toBe(false);
    expect(visible.has(hexToString({ q: 3, r: 0 }))).toBe(false);
  });
});

describe('buildVisibleOccupants', () => {
  const center = { q: 0, r: 0 };
  const validTiles = makeAllHexes(center, 4);

  it('allies show unit ID, enemies do not', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'mage',
      position: center,
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

    const { occupants } = buildVisibleOccupants(
      viewer,
      [viewer, ally, enemy],
      new Set(),
      validTiles,
      noFlags,
    );

    const allyOcc = occupants.find((o) => o.pos[0] === 1 && o.pos[1] === 0);
    expect(allyOcc?.unit?.id).toBe('a2');
    expect(allyOcc?.unit?.team).toBe('A');

    const enemyOcc = occupants.find((o) => o.pos[0] === 0 && o.pos[1] === -1);
    expect(enemyOcc?.unit?.id).toBeUndefined();
    expect(enemyOcc?.unit?.team).toBe('B');
  });

  it('dead units are not emitted as occupants', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'mage',
      position: center,
      alive: true,
    };
    const deadEnemy: FogUnit = {
      id: 'b1',
      team: 'B',
      unitClass: 'rogue',
      position: { q: 1, r: 0 },
      alive: false,
    };

    const { occupants } = buildVisibleOccupants(
      viewer,
      [viewer, deadEnemy],
      new Set(),
      validTiles,
      noFlags,
    );

    expect(occupants.find((o) => o.pos[0] === 1 && o.pos[1] === 0)).toBeUndefined();
  });

  it('loose flag on a visible hex shows up as occupant', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'mage',
      position: center,
      alive: true,
    };
    const flags = {
      A: [{ position: { q: -2, r: 0 }, carried: false }],
      B: [{ position: { q: 2, r: 0 }, carried: false }],
    };

    const { occupants } = buildVisibleOccupants(viewer, [viewer], new Set(), validTiles, flags);

    expect(occupants.find((o) => o.pos[0] === -2 && o.pos[1] === 0)?.flag).toEqual({ team: 'A' });
    expect(occupants.find((o) => o.pos[0] === 2 && o.pos[1] === 0)?.flag).toEqual({ team: 'B' });
  });

  it('carried flag rides on the carrier hex with carryingFlag:true', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'mage',
      position: center,
      alive: true,
    };
    const carrier: FogUnit = {
      id: 'a2',
      team: 'A',
      unitClass: 'rogue',
      position: { q: 1, r: 0 },
      alive: true,
    };
    const flags = {
      A: [{ position: { q: -5, r: 0 }, carried: false }],
      B: [{ position: { q: 5, r: 0 }, carried: true, carrierId: 'a2' }],
    };

    const { occupants } = buildVisibleOccupants(
      viewer,
      [viewer, carrier],
      new Set(),
      validTiles,
      flags,
    );

    const carrierOcc = occupants.find((o) => o.pos[0] === 1 && o.pos[1] === 0);
    expect(carrierOcc?.unit?.carryingFlag).toBe(true);
    expect(carrierOcc?.flag).toEqual({ team: 'B' });
  });

  it('visibleKeys excludes hexes outside the viewer radius', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'knight',
      position: center,
      alive: true,
    };
    const allTiles = makeAllHexes(center, 6);

    const { visibleKeys } = buildVisibleOccupants(viewer, [viewer], new Set(), allTiles, noFlags);

    expect(visibleKeys.has(hexToString({ q: 3, r: 0 }))).toBe(false);
    expect(visibleKeys.has(hexToString({ q: 2, r: 0 }))).toBe(true);
  });

  it('walls within vision are emitted; hexes behind them are not visible', () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'rogue',
      position: center,
      alive: true,
    };
    const walls = wallSet({ q: 1, r: 0 });
    const allTiles = makeAllHexes(center, 5);

    const { visibleKeys, walls: emittedWalls } = buildVisibleOccupants(
      viewer,
      [viewer],
      walls,
      allTiles,
      noFlags,
    );

    // Walls are emitted as `[q, r]` tuples on the agent envelope.
    expect(emittedWalls).toContainEqual([1, 0]);
    expect(visibleKeys.has(hexToString({ q: 1, r: 0 }))).toBe(true);
    expect(visibleKeys.has(hexToString({ q: 2, r: 0 }))).toBe(false);
  });

  it("viewer's own hex is emitted as an occupant (self)", () => {
    const viewer: FogUnit = {
      id: 'a1',
      team: 'A',
      unitClass: 'knight',
      position: { q: 3, r: 2 },
      alive: true,
    };
    const allTiles = makeAllHexes({ q: 3, r: 2 }, 5);

    const { occupants } = buildVisibleOccupants(viewer, [viewer], new Set(), allTiles, noFlags);

    const self = occupants.find((o) => o.pos[0] === 3 && o.pos[1] === 2);
    expect(self?.unit?.id).toBe('a1');
    expect(self?.unit?.team).toBe('A');
  });
});
