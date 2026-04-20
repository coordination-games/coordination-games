import { type Direction, getNeighbor, type Hex, hexEquals, hexToString } from './hex.js';

export type UnitClass = 'rogue' | 'knight' | 'mage';

export const CLASS_SPEED: Record<UnitClass, number> = {
  rogue: 3,
  knight: 2,
  mage: 1,
};

export interface MoveUnit {
  id: string;
  team: 'A' | 'B';
  unitClass: UnitClass;
  position: Hex;
}

export interface MoveSubmission {
  unitId: string;
  path: Direction[];
}

export interface MoveResult {
  unitId: string;
  from: Hex;
  to: Hex;
  pathTaken: Hex[]; // actual positions stepped through (may be shorter than submitted if blocked)
  stopped: boolean; // true if path was truncated (wall/off-map/stacking)
}

/**
 * Validate a single path submission against the unit's class speed limit.
 */
export function validatePath(
  unit: MoveUnit,
  path: Direction[],
): { valid: boolean; error?: string } {
  const maxSpeed = CLASS_SPEED[unit.unitClass];
  if (path.length > maxSpeed) {
    return {
      valid: false,
      error: `Path length ${path.length} exceeds ${unit.unitClass} speed limit of ${maxSpeed}`,
    };
  }

  // Validate that each direction is valid (N, NE, SE, S, SW, NW)
  const validDirections = new Set(['N', 'NE', 'SE', 'S', 'SW', 'NW']);
  for (const dir of path) {
    if (!validDirections.has(dir)) {
      return {
        valid: false,
        error: `Invalid direction: ${dir}. Valid directions are: N, NE, SE, S, SW, NW`,
      };
    }
  }

  return { valid: true };
}

/**
 * Walk a unit along its path, stopping at the first invalid tile.
 * Returns the list of hexes visited (starting from the unit's position)
 * and whether the path was truncated.
 */
function walkPath(
  start: Hex,
  path: Direction[],
  validTiles: Set<string>,
): { positions: Hex[]; stopped: boolean } {
  // Guard: if start position is malformed (missing q/r), treat as no movement
  if (!start || typeof start.q !== 'number' || typeof start.r !== 'number') {
    return { positions: [start ?? { q: 0, r: 0 }], stopped: true };
  }

  const positions: Hex[] = [start];
  let current = start;
  let stopped = false;

  for (const dir of path) {
    const next = getNeighbor(current, dir);
    if (!validTiles.has(hexToString(next))) {
      stopped = true;
      break;
    }
    current = next;
    positions.push(current);
  }

  return { positions, stopped };
}

/**
 * Resolve all movements simultaneously.
 *
 * Algorithm:
 * 1. Walk each unit along its submitted path, stopping at walls/off-map.
 * 2. Units without submissions stay in place.
 * 3. After computing raw final positions, resolve friendly stacking:
 *    - If two same-team units land on the same hex, the one that moved
 *      fewer steps keeps the position; the other backtracks along its
 *      path to the last non-conflicting position.
 * 4. Enemy units CAN occupy the same hex (combat resolves later).
 */
export function resolveMovements(
  units: MoveUnit[],
  submissions: MoveSubmission[],
  validTiles: Set<string>,
): MoveResult[] {
  const submissionMap = new Map<string, MoveSubmission>();
  for (const sub of submissions) {
    submissionMap.set(sub.unitId, sub);
  }

  // Phase 1: Walk each unit along its path
  interface WalkState {
    unit: MoveUnit;
    positions: Hex[];
    stopped: boolean;
    finalIndex: number; // index into positions for current final position
  }

  const states: WalkState[] = units.map((unit) => {
    const sub = submissionMap.get(unit.id);
    const path = sub?.path ?? [];
    const { positions, stopped } = walkPath(unit.position, path, validTiles);
    return {
      unit,
      positions,
      stopped,
      finalIndex: positions.length - 1,
    };
  });

  // Phase 2: Resolve friendly stacking conflicts
  // Iterate until no more conflicts exist (backtracking can cause cascading conflicts)
  let changed = true;
  while (changed) {
    changed = false;

    // Group by team and final position
    const teamPositionMap = new Map<string, WalkState[]>();
    for (const state of states) {
      const finalHex = state.positions[state.finalIndex];
      // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
      const key = `${state.unit.team}:${hexToString(finalHex)}`;
      const group = teamPositionMap.get(key) ?? [];
      group.push(state);
      teamPositionMap.set(key, group);
    }

    for (const group of teamPositionMap.values()) {
      if (group.length <= 1) continue;

      // Conflict: multiple same-team units on same hex.
      // The one that moved fewer steps keeps it; others backtrack.
      // "Steps moved" = finalIndex (0 = didn't move from start).
      group.sort((a, b) => a.finalIndex - b.finalIndex);

      // The first (fewest steps) keeps position. Others backtrack.
      for (let i = 1; i < group.length; i++) {
        const state = group[i];
        // Backtrack: find last position in path not occupied by a friendly unit
        let backtracked = false;
        // @ts-expect-error TS18048: 'state' is possibly 'undefined'. — TODO(2.3-followup)
        for (let idx = state.finalIndex - 1; idx >= 0; idx--) {
          // @ts-expect-error TS18048: 'state' is possibly 'undefined'. — TODO(2.3-followup)
          const candidate = state.positions[idx];
          // Check if any same-team unit (other than this one) occupies this hex
          const occupied = states.some(
            (other) =>
              other !== state &&
              // @ts-expect-error TS18048: 'state' is possibly 'undefined'. — TODO(2.3-followup)
              other.unit.team === state.unit.team &&
              // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
              hexEquals(other.positions[other.finalIndex], candidate),
          );
          if (!occupied) {
            // @ts-expect-error TS18048: 'state' is possibly 'undefined'. — TODO(2.3-followup)
            state.finalIndex = idx;
            // @ts-expect-error TS18048: 'state' is possibly 'undefined'. — TODO(2.3-followup)
            state.stopped = true;
            backtracked = true;
            changed = true;
            break;
          }
        }
        // If couldn't backtrack at all, stay at start (index 0) — starting
        // positions are always valid and unique per unit.
        // @ts-expect-error TS18048: 'state' is possibly 'undefined'. — TODO(2.3-followup)
        if (!backtracked && state.finalIndex !== 0) {
          // @ts-expect-error TS18048: 'state' is possibly 'undefined'. — TODO(2.3-followup)
          state.finalIndex = 0;
          // @ts-expect-error TS18048: 'state' is possibly 'undefined'. — TODO(2.3-followup)
          state.stopped = true;
          changed = true;
        }
      }
    }
  }

  // Phase 3: Build results
  // @ts-expect-error TS2322: Type '{ unitId: string; from: Hex; to: Hex | undefined; pathTaken: Hex[]; stoppe — TODO(2.3-followup)
  return states.map((state) => {
    const from = state.unit.position;
    const to = state.positions[state.finalIndex];
    const pathTaken = state.positions.slice(0, state.finalIndex + 1);
    return {
      unitId: state.unit.id,
      from,
      to,
      pathTaken,
      stopped: state.stopped,
    };
  });
}
