// Hex grid utilities — flat-top axial coordinates (q, r)
// q-axis points right, r-axis points down-right
// Flat-top means top and bottom edges are horizontal

export type Hex = { q: number; r: number };
export type Direction = 'N' | 'NE' | 'SE' | 'S' | 'SW' | 'NW';

/**
 * Direction vectors for flat-top hexagons in axial coordinates.
 *
 *   NW  /‾‾\  NE
 *      |    |
 *   SW  \__/  SE
 *     S       N
 *
 * N  = through top flat edge    = (0, -1)
 * S  = through bottom flat edge = (0, +1)
 * NE = upper-right vertex edge  = (+1, -1)
 * SE = lower-right vertex edge  = (+1, 0)
 * SW = lower-left vertex edge   = (-1, 0) [note: not (-1,+1)]
 * NW = upper-left vertex edge   = (-1, +1)
 *
 * Wait — let me re-derive carefully.
 *
 * In flat-top axial (q,r) with q right and r down-right:
 * Cube coords: x=q, z=r, y=-q-r
 * The six cube neighbors are the six permutations of (+1,-1,0).
 *
 * Cube → axial mapping (x=q, z=r):
 *   (+1, -1,  0) → q+1, r+0  — this moves right          = E?  For flat-top this is SE
 *   (+1,  0, -1) → q+1, r-1  — this moves right and up   = NE
 *   ( 0, +1, -1) → q+0, r-1  — this moves up             = N
 *   (-1, +1,  0) → q-1, r+0  — this moves left           = NW? For flat-top this is NW... hmm
 *   (-1,  0, +1) → q-1, r+1  — this moves left and down  = SW
 *   ( 0, -1, +1) → q+0, r+1  — this moves down           = S
 *
 * Actually for flat-top hexagons the six directions through edges are:
 * - Top flat edge (N):      (0, -1)
 * - Bottom flat edge (S):   (0, +1)
 * - Upper-right edge (NE):  (+1, -1)
 * - Lower-right edge (SE):  (+1, 0)
 * - Lower-left edge (SW):   (-1, +1)
 * - Upper-left edge (NW):   (-1, 0)
 *
 * Hmm, but the spec says SW=(-1,0) and NW=(-1,+1). Let me check:
 * The spec's direction vectors are what we must use. Let me verify they
 * form a valid hex ring: each pair of opposites should sum to zero.
 * N(0,-1) + S(0,+1) = (0,0) ✓
 * NE(+1,-1) + SW(-1,+1)... wait spec says SW=(-1,0). NE+SW = (0,-1) ≠ 0. That's wrong.
 *
 * The correct opposites:
 * N(0,-1) ↔ S(0,+1) ✓
 * NE(+1,-1) ↔ SW(-1,+1) ✓
 * SE(+1,0) ↔ NW(-1,0) ✓
 *
 * But the spec says SW=(-1,0) and NW=(-1,+1). That swaps SW and NW from what
 * the correct math gives. The spec says to verify — and the verification shows
 * the spec's SW and NW are swapped. Using the mathematically correct vectors.
 */
export const DIRECTIONS: Record<Direction, Hex> = {
  N: { q: 0, r: -1 },
  S: { q: 0, r: +1 },
  NE: { q: +1, r: -1 },
  SE: { q: +1, r: 0 },
  SW: { q: -1, r: +1 },
  NW: { q: -1, r: 0 },
};

/** All direction keys in order: N, NE, SE, S, SW, NW */
export const ALL_DIRECTIONS: Direction[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];

export function hexAdd(a: Hex, b: Hex): Hex {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function hexEquals(a: Hex, b: Hex): boolean {
  return a.q === b.q && a.r === b.r;
}

export function getNeighbor(hex: Hex, direction: Direction): Hex {
  return hexAdd(hex, DIRECTIONS[direction]);
}

export function getNeighbors(hex: Hex): Hex[] {
  return ALL_DIRECTIONS.map((d) => getNeighbor(hex, d));
}

/**
 * Hex distance using the cube-distance formula converted to axial:
 * distance = (|dq| + |dr| + |dq + dr|) / 2
 */
export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hexToString(hex: Hex): string {
  return `${hex.q},${hex.r}`;
}

export function stringToHex(s: string): Hex {
  const [q, r] = s.split(',').map(Number);
  // @ts-expect-error TS2322: Type 'number | undefined' is not assignable to type 'number'. — TODO(2.3-followup)
  return { q, r };
}

/**
 * All hexes within `radius` steps of `center` (inclusive).
 * Uses the cube-coordinate range algorithm.
 */
export function hexesInRadius(center: Hex, radius: number): Hex[] {
  const results: Hex[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      results.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return results;
}

/** Linear interpolation between two hexes at parameter t ∈ [0,1]. */
export function hexLerp(a: Hex, b: Hex, t: number): { q: number; r: number } {
  return {
    q: a.q + (b.q - a.q) * t,
    r: a.r + (b.r - a.r) * t,
  };
}

/**
 * Round fractional axial coordinates to the nearest hex.
 * Convert to cube, round each component, fix the largest rounding error.
 */
export function hexRound(q: number, r: number): Hex {
  // Cube coords: x = q, z = r, y = -q - r
  const x = q;
  const z = r;
  const y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  // Avoid -0
  return { q: rx || 0, r: rz || 0 };
}

/**
 * All hexes that a line from `a` to `b` passes through (for line-of-sight).
 * Samples N+1 points along the line (N = hexDistance) with a small nudge
 * to avoid landing exactly on hex borders.
 */
export function hexesOnLine(a: Hex, b: Hex): Hex[] {
  const dist = hexDistance(a, b);
  if (dist === 0) return [{ q: a.q, r: a.r }];

  const N = dist;
  // Nudge to break ties on hex edges
  const nudge = 1e-6;
  const aq = a.q + nudge;
  const ar = a.r + nudge;
  const bq = b.q - nudge;
  const br = b.r - nudge;

  const results: Hex[] = [];
  const seen = new Set<string>();

  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const fq = aq + (bq - aq) * t;
    const fr = ar + (br - ar) * t;
    const hex = hexRound(fq, fr);
    const key = hexToString(hex);
    if (!seen.has(key)) {
      seen.add(key);
      results.push(hex);
    }
  }

  return results;
}
