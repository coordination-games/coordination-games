import { describe, expect, it } from 'vitest';
import type { TragedyHexRef, TragedyV2Intersection } from '../types.js';

// ── Static board layout matching V2 canonical hex grid ──

const BOARD_TILES: Array<{ q: number; r: number }> = [
  { q: 0, r: -2 },
  { q: 1, r: -2 },
  { q: 2, r: -2 },
  { q: -1, r: -1 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
  { q: 2, r: -1 },
  { q: -2, r: 0 },
  { q: -1, r: 0 },
  { q: 0, r: 0 },
  { q: 1, r: 0 },
  { q: 2, r: 0 },
  { q: -2, r: 1 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
  { q: 1, r: 1 },
  { q: -2, r: 2 },
  { q: -1, r: 2 },
  { q: 0, r: 2 },
];

const BOARD_TILE_SET = new Set(BOARD_TILES.map((hex) => `${hex.q},${hex.r}`));

// ── Intersection helpers ──

function hexKey(hex: TragedyHexRef): string {
  return `${hex.q},${hex.r}`;
}

function sharedHexCount(left: TragedyHexRef[], right: TragedyHexRef[]): number {
  const leftKeys = new Set(left.map(hexKey));
  return right.filter((hex) => leftKeys.has(hexKey(hex))).length;
}

function allHexesValid(hexes: TragedyHexRef[]): boolean {
  return hexes.every((hex) => BOARD_TILE_SET.has(hexKey(hex)));
}

function makeIntersection(id: string, qr0: TragedyHexRef, qr1: TragedyHexRef, qr2: TragedyHexRef): TragedyV2Intersection {
  return { id, hexes: [qr0, qr1, qr2] };
}

// ── Adjacent intersections define a valid road edge ──

interface RoadEdge {
  id: string;
  from: string; // intersection id
  to: string;   // intersection id
}

// ── Tests ──

describe('V2 geometry invariants', () => {
  const intersections: TragedyV2Intersection[] = [
    makeIntersection('nw', { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 0, r: 0 }),
    makeIntersection('ne', { q: 0, r: -1 }, { q: 1, r: -1 }, { q: 0, r: 0 }),
    makeIntersection('n',  { q: 1, r: -1 }, { q: 0, r: 0 }, { q: 1, r: 0 }),
    makeIntersection('e',  { q: 0, r: 0 }, { q: 0, r: 1 }, { q: 1, r: 0 }),
    makeIntersection('s',  { q: 0, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }),
    makeIntersection('w',  { q: -1, r: 0 }, { q: 0, r: 0 }, { q: -1, r: 1 }),
  ];

  const intersectionById = new Map(intersections.map((ix) => [ix.id, ix]));

  const edges: RoadEdge[] = [
    { id: 'nw-ne', from: 'nw', to: 'ne' },
    { id: 'ne-n',  from: 'ne', to: 'n' },
    { id: 'n-e',   from: 'n',  to: 'e' },
    { id: 'e-s',   from: 'e',  to: 's' },
    { id: 's-w',   from: 's',  to: 'w' },
    { id: 'w-nw',  from: 'w',  to: 'nw' },
  ];

  it('every intersection has exactly 3 hexes', () => {
    for (const ix of intersections) {
      expect(ix.hexes).toHaveLength(3);
    }
  });

  it('every intersection hex is a real board tile', () => {
    for (const ix of intersections) {
      expect(allHexesValid(ix.hexes)).toBe(true);
    }
  });

  it('every configured road edge connects adjacent intersections (shared-hex count = 2)', () => {
    for (const edge of edges) {
      const from = intersectionById.get(edge.from);
      const to = intersectionById.get(edge.to);
      if (!from || !to) {
        throw new Error(`missing intersection for edge ${edge.id}`);
      }
      const shared = sharedHexCount(from.hexes, to.hexes);
      expect(shared).toBe(2);
    }
  });

  it('non-adjacent intersections share fewer than 2 hexes (negative control)', () => {
    const nw = intersectionById.get('nw');
    const e = intersectionById.get('e');
    if (!nw || !e) throw new Error('missing test intersections');
    expect(sharedHexCount(nw.hexes, e.hexes)).toBeLessThan(2);
  });

  it('every road endpoint is within the canonical intersection set', () => {
    for (const edge of edges) {
      expect(intersectionById.has(edge.from)).toBe(true);
      expect(intersectionById.has(edge.to)).toBe(true);
    }
  });
});
