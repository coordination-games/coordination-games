import { describe, expect, it } from 'vitest';
import { beats, type CombatUnit, resolveCombat } from '../combat.js';
import { hexToString } from '../hex.js';

// Helper to make units concisely
function unit(
  id: string,
  team: 'A' | 'B',
  unitClass: CombatUnit['unitClass'],
  q: number,
  r: number,
): CombatUnit {
  return { id, team, unitClass, position: { q, r } };
}

describe('beats()', () => {
  it('rogue beats mage', () => {
    expect(beats('rogue', 'mage')).toBe(true);
  });

  it('knight beats rogue', () => {
    expect(beats('knight', 'rogue')).toBe(true);
  });

  it('mage beats knight', () => {
    expect(beats('mage', 'knight')).toBe(true);
  });

  it('same class does not beat itself', () => {
    expect(beats('rogue', 'rogue')).toBe(false);
    expect(beats('knight', 'knight')).toBe(false);
    expect(beats('mage', 'mage')).toBe(false);
  });

  it('losers do not beat winners', () => {
    expect(beats('mage', 'rogue')).toBe(false);
    expect(beats('rogue', 'knight')).toBe(false);
    expect(beats('knight', 'mage')).toBe(false);
  });
});

describe('resolveCombat() — melee', () => {
  const noWalls = new Set<string>();

  it('rogue kills adjacent mage', () => {
    const units = [
      unit('r1', 'A', 'rogue', 0, 0),
      unit('m1', 'B', 'mage', 1, 0), // adjacent (SE)
    ];
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.has('m1')).toBe(true);
    expect(result.deaths.has('r1')).toBe(false);
    expect(result.kills).toHaveLength(1);
    expect(result.kills[0].killerId).toBe('r1');
    expect(result.kills[0].victimId).toBe('m1');
  });

  it('knight kills adjacent rogue', () => {
    const units = [
      unit('k1', 'A', 'knight', 0, 0),
      unit('r1', 'B', 'rogue', 0, -1), // adjacent (N)
    ];
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.has('r1')).toBe(true);
    expect(result.deaths.has('k1')).toBe(false);
  });

  it('mage kills adjacent knight', () => {
    const units = [
      unit('m1', 'A', 'mage', 0, 0),
      unit('k1', 'B', 'knight', -1, 0), // adjacent (NW)
    ];
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.has('k1')).toBe(true);
    expect(result.deaths.has('m1')).toBe(false);
  });

  it('same-class same-hex: both die', () => {
    const units = [unit('r1', 'A', 'rogue', 3, 3), unit('r2', 'B', 'rogue', 3, 3)];
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.has('r1')).toBe(true);
    expect(result.deaths.has('r2')).toBe(true);
    expect(result.kills).toHaveLength(2);
  });

  it('same-class adjacent (not same hex): nothing happens', () => {
    const units = [
      unit('k1', 'A', 'knight', 0, 0),
      unit('k2', 'B', 'knight', 1, 0), // adjacent but not same hex
    ];
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.size).toBe(0);
    expect(result.kills).toHaveLength(0);
  });
});

describe('resolveCombat() — mage ranged', () => {
  it('mage kills knight at distance 2 with clear LoS', () => {
    // distance 2: (0,0) -> (2,0) via SE twice
    const units = [unit('m1', 'A', 'mage', 0, 0), unit('k1', 'B', 'knight', 2, 0)];
    const noWalls = new Set<string>();
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.has('k1')).toBe(true);
    expect(result.deaths.has('m1')).toBe(false);
    const rangedKill = result.kills.find((k) => k.killerId === 'm1' && k.victimId === 'k1');
    expect(rangedKill).toBeDefined();
    expect(rangedKill?.reason).toContain('ranged');
  });

  it('mage ranged kill blocked by wall', () => {
    const units = [unit('m1', 'A', 'mage', 0, 0), unit('k1', 'B', 'knight', 2, 0)];
    // Wall at the intermediate hex (1,0)
    const walls = new Set<string>([hexToString({ q: 1, r: 0 })]);
    const result = resolveCombat(units, walls);

    expect(result.deaths.size).toBe(0);
    expect(result.kills).toHaveLength(0);
  });

  it('mage does NOT ranged-kill rogues at distance 2', () => {
    const units = [unit('m1', 'A', 'mage', 0, 0), unit('r1', 'B', 'rogue', 2, 0)];
    const noWalls = new Set<string>();
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.size).toBe(0);
  });

  it('mage does NOT ranged-kill other mages at distance 2', () => {
    const units = [unit('m1', 'A', 'mage', 0, 0), unit('m2', 'B', 'mage', 2, 0)];
    const noWalls = new Set<string>();
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.size).toBe(0);
  });
});

describe('resolveCombat() — simultaneous resolution', () => {
  it('mage dies in melee but still gets ranged kill on distant knight', () => {
    // Mage at (0,0), enemy rogue adjacent at (1,0), enemy knight at (2,-2) distance 2
    // Rogue kills mage in melee. But mage still gets ranged kill on knight.
    // distance from (0,0) to (0,-2): |0| + |-2| + |0+(-2)| / 2 = (0+2+2)/2 = 2 ✓
    const units = [
      unit('m1', 'A', 'mage', 0, 0),
      unit('r1', 'B', 'rogue', 1, 0), // adjacent, rogue beats mage → mage dies
      unit('k1', 'B', 'knight', 0, -2), // distance 2 from mage, no wall
    ];
    const noWalls = new Set<string>();
    const result = resolveCombat(units, noWalls);

    // Mage should die (rogue kills it)
    expect(result.deaths.has('m1')).toBe(true);
    // Knight should also die (mage ranged kill, simultaneous)
    expect(result.deaths.has('k1')).toBe(true);
    // Rogue should survive
    expect(result.deaths.has('r1')).toBe(false);
  });

  it('unit targeted by multiple enemies dies if any beat it', () => {
    // A rogue surrounded by two enemy knights
    const units = [
      unit('r1', 'A', 'rogue', 0, 0),
      unit('k1', 'B', 'knight', 1, 0), // adjacent
      unit('k2', 'B', 'knight', -1, 0), // adjacent
    ];
    const noWalls = new Set<string>();
    const result = resolveCombat(units, noWalls);

    // Both knights beat rogue
    expect(result.deaths.has('r1')).toBe(true);
    expect(result.deaths.has('k1')).toBe(false);
    expect(result.deaths.has('k2')).toBe(false);
    // Two kill entries (one from each knight)
    const rogueKills = result.kills.filter((k) => k.victimId === 'r1');
    expect(rogueKills).toHaveLength(2);
  });
});

describe('resolveCombat() — edge cases', () => {
  it('no friendly fire: same-team units adjacent do not fight', () => {
    const units = [
      unit('r1', 'A', 'rogue', 0, 0),
      unit('m1', 'A', 'mage', 1, 0), // same team, adjacent
    ];
    const noWalls = new Set<string>();
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.size).toBe(0);
    expect(result.kills).toHaveLength(0);
  });

  it('units not in range: no combat occurs', () => {
    const units = [
      unit('r1', 'A', 'rogue', 0, 0),
      unit('m1', 'B', 'mage', 5, 0), // far away
    ];
    const noWalls = new Set<string>();
    const result = resolveCombat(units, noWalls);

    expect(result.deaths.size).toBe(0);
    expect(result.kills).toHaveLength(0);
  });

  it('empty units list produces no kills', () => {
    const result = resolveCombat([], new Set());
    expect(result.deaths.size).toBe(0);
    expect(result.kills).toHaveLength(0);
  });
});
