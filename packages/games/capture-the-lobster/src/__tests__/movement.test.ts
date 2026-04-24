import { describe, expect, it } from 'vitest';
import { type Hex, hexEquals, hexToString } from '../hex.js';
import {
  CLASS_SPEED,
  type MoveSubmission,
  type MoveUnit,
  resolveMovements,
  validatePath,
} from '../movement.js';

// Helper: build a set of valid tile strings from an array of hexes
function tileSet(hexes: Hex[]): Set<string> {
  return new Set(hexes.map(hexToString));
}

// Helper: a small 3-radius hex grid centered at origin (plenty of room)
function makeGrid(radius = 3): Set<string> {
  const tiles: Hex[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      tiles.push({ q, r });
    }
  }
  return tileSet(tiles);
}

function findResult(results: ReturnType<typeof resolveMovements>, unitId: string) {
  const r = results.find((x) => x.unitId === unitId);
  if (!r) throw new Error(`expected movement result for ${unitId}`);
  return r;
}

// ─── validatePath ───────────────────────────────────────────────────────────

describe('validatePath', () => {
  const rogue: MoveUnit = { id: 'r1', team: 'A', unitClass: 'rogue', position: { q: 0, r: 0 } };
  const knight: MoveUnit = { id: 'k1', team: 'A', unitClass: 'knight', position: { q: 0, r: 0 } };
  const mage: MoveUnit = { id: 'm1', team: 'A', unitClass: 'mage', position: { q: 0, r: 0 } };

  it('accepts path within speed limit', () => {
    expect(validatePath(rogue, ['N', 'NE', 'SE'])).toEqual({ valid: true });
    expect(validatePath(knight, ['N', 'S'])).toEqual({ valid: true });
    expect(validatePath(mage, ['N'])).toEqual({ valid: true });
  });

  it('accepts empty path (hold position)', () => {
    expect(validatePath(rogue, [])).toEqual({ valid: true });
    expect(validatePath(knight, [])).toEqual({ valid: true });
    expect(validatePath(mage, [])).toEqual({ valid: true });
  });

  it('rejects path exceeding speed limit', () => {
    const result = validatePath(mage, ['N', 'S']);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects rogue path exceeding speed 3', () => {
    const result = validatePath(rogue, ['N', 'NE', 'SE', 'S']);
    expect(result.valid).toBe(false);
  });

  it('rejects knight path exceeding speed 2', () => {
    const result = validatePath(knight, ['N', 'NE', 'SE']);
    expect(result.valid).toBe(false);
  });

  it('has correct class speeds', () => {
    expect(CLASS_SPEED.rogue).toBe(3);
    expect(CLASS_SPEED.knight).toBe(2);
    expect(CLASS_SPEED.mage).toBe(1);
  });
});

// ─── resolveMovements ───────────────────────────────────────────────────────

describe('resolveMovements', () => {
  it('empty path = hold position', () => {
    const unit: MoveUnit = { id: 'u1', team: 'A', unitClass: 'knight', position: { q: 0, r: 0 } };
    const results = resolveMovements([unit], [], makeGrid());
    const r = findResult(results, 'u1');

    expect(hexEquals(r.from, { q: 0, r: 0 })).toBe(true);
    expect(hexEquals(r.to, { q: 0, r: 0 })).toBe(true);
    expect(r.pathTaken).toHaveLength(1);
    expect(r.stopped).toBe(false);
  });

  it('unit with no submission stays in place', () => {
    const unit: MoveUnit = { id: 'u1', team: 'A', unitClass: 'knight', position: { q: 1, r: -1 } };
    const results = resolveMovements([unit], [], makeGrid());
    const r = findResult(results, 'u1');

    expect(hexEquals(r.to, { q: 1, r: -1 })).toBe(true);
    expect(r.stopped).toBe(false);
  });

  it('valid single-step movement succeeds', () => {
    const unit: MoveUnit = { id: 'u1', team: 'A', unitClass: 'mage', position: { q: 0, r: 0 } };
    const sub: MoveSubmission = { unitId: 'u1', path: ['NE'] };
    const results = resolveMovements([unit], [sub], makeGrid());
    const r = findResult(results, 'u1');

    expect(hexEquals(r.to, { q: 1, r: -1 })).toBe(true);
    expect(r.pathTaken).toHaveLength(2); // start + 1 step
    expect(r.stopped).toBe(false);
  });

  it('multi-step path succeeds on open grid', () => {
    const unit: MoveUnit = { id: 'u1', team: 'A', unitClass: 'rogue', position: { q: 0, r: 0 } };
    const sub: MoveSubmission = { unitId: 'u1', path: ['N', 'NE', 'SE'] };
    const results = resolveMovements([unit], [sub], makeGrid());
    const r = findResult(results, 'u1');

    // N: (0,-1), NE: (1,-2), SE: (2,-2)
    expect(hexEquals(r.to, { q: 2, r: -2 })).toBe(true);
    expect(r.pathTaken).toHaveLength(4);
    expect(r.stopped).toBe(false);
  });

  it('movement into wall stops at last valid hex', () => {
    // Grid is only the origin and N neighbor
    const tiles = tileSet([
      { q: 0, r: 0 },
      { q: 0, r: -1 },
    ]);
    const unit: MoveUnit = { id: 'u1', team: 'A', unitClass: 'knight', position: { q: 0, r: 0 } };
    // Try to move N then N again — second step goes off valid tiles
    const sub: MoveSubmission = { unitId: 'u1', path: ['N', 'N'] };
    const results = resolveMovements([unit], [sub], tiles);
    const r = findResult(results, 'u1');

    expect(hexEquals(r.to, { q: 0, r: -1 })).toBe(true);
    expect(r.pathTaken).toHaveLength(2); // start + 1 valid step
    expect(r.stopped).toBe(true);
  });

  it('movement off-map (first step invalid) stays at start', () => {
    // Only the origin is valid
    const tiles = tileSet([{ q: 0, r: 0 }]);
    const unit: MoveUnit = { id: 'u1', team: 'A', unitClass: 'mage', position: { q: 0, r: 0 } };
    const sub: MoveSubmission = { unitId: 'u1', path: ['S'] };
    const results = resolveMovements([unit], [sub], tiles);
    const r = findResult(results, 'u1');

    expect(hexEquals(r.to, { q: 0, r: 0 })).toBe(true);
    expect(r.pathTaken).toHaveLength(1);
    expect(r.stopped).toBe(true);
  });

  it('multi-step path hits wall mid-way: stops at correct hex', () => {
    // A line of 3 valid hexes going N from origin: (0,0), (0,-1), (0,-2)
    const tiles = tileSet([
      { q: 0, r: 0 },
      { q: 0, r: -1 },
      { q: 0, r: -2 },
    ]);
    const unit: MoveUnit = { id: 'u1', team: 'A', unitClass: 'rogue', position: { q: 0, r: 0 } };
    // Move N, N, N — third step goes to (0,-3) which is off-map
    const sub: MoveSubmission = { unitId: 'u1', path: ['N', 'N', 'N'] };
    const results = resolveMovements([unit], [sub], tiles);
    const r = findResult(results, 'u1');

    expect(hexEquals(r.to, { q: 0, r: -2 })).toBe(true);
    expect(r.pathTaken).toHaveLength(3); // (0,0) → (0,-1) → (0,-2)
    expect(r.stopped).toBe(true);
  });

  it('simultaneous movement: two units move to different hexes, both succeed', () => {
    const u1: MoveUnit = { id: 'u1', team: 'A', unitClass: 'knight', position: { q: 0, r: 0 } };
    const u2: MoveUnit = { id: 'u2', team: 'A', unitClass: 'knight', position: { q: 1, r: 0 } };
    const subs: MoveSubmission[] = [
      { unitId: 'u1', path: ['N'] },
      { unitId: 'u2', path: ['S'] },
    ];
    const results = resolveMovements([u1, u2], subs, makeGrid());

    const r1 = findResult(results, 'u1');
    const r2 = findResult(results, 'u2');

    expect(hexEquals(r1.to, { q: 0, r: -1 })).toBe(true);
    expect(hexEquals(r2.to, { q: 1, r: 1 })).toBe(true);
    expect(r1.stopped).toBe(false);
    expect(r2.stopped).toBe(false);
  });

  it('friendly stacking prevented: two teammates targeting same hex, one backtracks', () => {
    // u1 starts at (0,0), u2 starts at (1,-1). Both try to reach (0,-1) via N / SW.
    const _u1: MoveUnit = { id: 'u1', team: 'A', unitClass: 'knight', position: { q: 0, r: 0 } };
    const _u2: MoveUnit = { id: 'u2', team: 'A', unitClass: 'knight', position: { q: 1, r: -1 } };
    const _subs: MoveSubmission[] = [
      { unitId: 'u1', path: ['N'] }, // (0,0) → (0,-1)
      { unitId: 'u2', path: ['NW', 'S'] }, // (1,-1) → (0,-1) → (0,0)... wait
    ];
    // Simpler: both move 1 step to same hex
    const u3: MoveUnit = { id: 'u3', team: 'B', unitClass: 'mage', position: { q: 0, r: -2 } };
    const u4: MoveUnit = { id: 'u4', team: 'B', unitClass: 'mage', position: { q: -1, r: -1 } };
    // u3 moves S to (0,-1), u4 moves SE to (0,-1)
    const subs2: MoveSubmission[] = [
      { unitId: 'u3', path: ['S'] },
      { unitId: 'u4', path: ['SE'] },
    ];
    const results = resolveMovements([u3, u4], subs2, makeGrid());

    const r3 = findResult(results, 'u3');
    const r4 = findResult(results, 'u4');

    // Both try to reach (0,-1). One should get it, the other backtracks to start.
    // They both moved 1 step, so the first in the array keeps it (tied on steps).
    // The loser stays at their start.
    const to3 = hexToString(r3.to);
    const to4 = hexToString(r4.to);

    // They should NOT be on the same hex (same team)
    expect(to3 === to4 && to3 === hexToString({ q: 0, r: -1 })).toBe(false);

    // One of them is at (0,-1), the other at their start
    const target = hexToString({ q: 0, r: -1 });
    const oneAtTarget = to3 === target || to4 === target;
    expect(oneAtTarget).toBe(true);
  });

  it('enemy units CAN end up on same hex', () => {
    const u1: MoveUnit = { id: 'u1', team: 'A', unitClass: 'mage', position: { q: 0, r: -2 } };
    const u2: MoveUnit = { id: 'u2', team: 'B', unitClass: 'mage', position: { q: -1, r: -1 } };
    // u1 moves S → (0,-1), u2 moves SE → (0,-1)
    const subs: MoveSubmission[] = [
      { unitId: 'u1', path: ['S'] },
      { unitId: 'u2', path: ['SE'] },
    ];
    const results = resolveMovements([u1, u2], subs, makeGrid());

    const r1 = findResult(results, 'u1');
    const r2 = findResult(results, 'u2');

    // Both should be at (0,-1) — different teams, so stacking is allowed
    expect(hexEquals(r1.to, { q: 0, r: -1 })).toBe(true);
    expect(hexEquals(r2.to, { q: 0, r: -1 })).toBe(true);
    expect(r1.stopped).toBe(false);
    expect(r2.stopped).toBe(false);
  });

  it('mixed scenario: some units move, some hold, walls block some', () => {
    // Valid tiles: a small L-shape
    //   (0,0) — (0,-1) — (0,-2)
    //             |
    //           (1,-1)
    const tiles = tileSet([
      { q: 0, r: 0 },
      { q: 0, r: -1 },
      { q: 0, r: -2 },
      { q: 1, r: -1 },
    ]);

    const units: MoveUnit[] = [
      { id: 'a1', team: 'A', unitClass: 'knight', position: { q: 0, r: 0 } }, // will move N
      { id: 'a2', team: 'A', unitClass: 'mage', position: { q: 0, r: -2 } }, // holds
      { id: 'b1', team: 'B', unitClass: 'rogue', position: { q: 1, r: -1 } }, // tries NE (wall), stops
    ];

    const subs: MoveSubmission[] = [
      { unitId: 'a1', path: ['N'] }, // (0,0) → (0,-1) ✓
      // a2 has no submission — holds at (0,-2)
      { unitId: 'b1', path: ['NE'] }, // (1,-1) → (2,-2) — not in tiles, blocked
    ];

    const results = resolveMovements(units, subs, tiles);

    const ra1 = findResult(results, 'a1');
    const ra2 = findResult(results, 'a2');
    const rb1 = findResult(results, 'b1');

    // a1 moves N successfully
    expect(hexEquals(ra1.to, { q: 0, r: -1 })).toBe(true);
    expect(ra1.stopped).toBe(false);

    // a2 holds position
    expect(hexEquals(ra2.to, { q: 0, r: -2 })).toBe(true);
    expect(ra2.stopped).toBe(false);

    // b1 blocked by wall
    expect(hexEquals(rb1.to, { q: 1, r: -1 })).toBe(true);
    expect(rb1.stopped).toBe(true);
  });

  it('friendly stacking: unit that moved fewer steps keeps position', () => {
    // u1 moves 1 step to (0,-1), u2 moves 2 steps to (0,-1)
    // u1 should keep it, u2 backtracks
    const u1: MoveUnit = { id: 'u1', team: 'A', unitClass: 'knight', position: { q: 0, r: 0 } };
    const u2: MoveUnit = { id: 'u2', team: 'A', unitClass: 'knight', position: { q: 1, r: 0 } };
    const subs: MoveSubmission[] = [
      { unitId: 'u1', path: ['N'] }, // (0,0) → (0,-1)
      { unitId: 'u2', path: ['NW', 'N'] }, // (1,0) → (0,0) → (0,-1)
    ];
    const results = resolveMovements([u1, u2], subs, makeGrid());

    const r1 = findResult(results, 'u1');
    const r2 = findResult(results, 'u2');

    // u1 moved 1 step, u2 moved 2 — u1 keeps (0,-1)
    expect(hexEquals(r1.to, { q: 0, r: -1 })).toBe(true);
    expect(r1.stopped).toBe(false);

    // u2 must backtrack — but not to (0,0) if u1 was also there... wait, u1 moved away from (0,0).
    // u2's path: (1,0) → (0,0) → (0,-1). u2 backtracks from (0,-1) to (0,0).
    // (0,0) is u1's start, but u1 moved away. So (0,0) is free.
    expect(hexEquals(r2.to, { q: 0, r: 0 })).toBe(true);
    expect(r2.stopped).toBe(true);
  });

  it('stationary unit blocks teammate from landing on its hex', () => {
    // u1 holds at (0,-1), u2 tries to move to (0,-1)
    const u1: MoveUnit = { id: 'u1', team: 'A', unitClass: 'mage', position: { q: 0, r: -1 } };
    const u2: MoveUnit = { id: 'u2', team: 'A', unitClass: 'mage', position: { q: 0, r: 0 } };
    const subs: MoveSubmission[] = [
      // u1 holds (no submission)
      { unitId: 'u2', path: ['N'] }, // tries to go to (0,-1)
    ];
    const results = resolveMovements([u1, u2], subs, makeGrid());

    const r1 = findResult(results, 'u1');
    const r2 = findResult(results, 'u2');

    // u1 stays at (0,-1), u2 bounces back to (0,0)
    expect(hexEquals(r1.to, { q: 0, r: -1 })).toBe(true);
    expect(hexEquals(r2.to, { q: 0, r: 0 })).toBe(true);
    expect(r2.stopped).toBe(true);
  });
});
