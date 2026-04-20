import { CLASS_VISION } from './combat.js';
import { type Hex, hexToString, stringToHex } from './hex.js';
import { getVisibleHexes } from './los.js';
import type { UnitClass } from './movement.js';

export interface FogUnit {
  id: string;
  team: 'A' | 'B';
  unitClass: UnitClass;
  position: Hex;
  alive: boolean;
}

export interface VisibleTile {
  q: number;
  r: number;
  type: 'ground' | 'wall' | 'base_a' | 'base_b';
  unit?: {
    id?: string; // only included for allies
    team: 'A' | 'B';
    unitClass: UnitClass;
    carryingFlag?: boolean;
  };
  flag?: {
    team: 'A' | 'B';
  };
}

/**
 * Get the set of hex keys visible to a specific unit.
 * Wraps the LoS system with the unit's class-specific vision radius.
 */
export function getUnitVision(
  unit: FogUnit,
  walls: Set<string>,
  allHexes: Set<string>,
): Set<string> {
  const radius = CLASS_VISION[unit.unitClass];
  return getVisibleHexes(unit.position, radius, walls, allHexes);
}

/**
 * Build the visible tile array for an agent's game state response.
 *
 * - Only includes tiles the viewer can see.
 * - Allies: include unit ID.
 * - Enemies: do NOT include unit ID (just team + class).
 * - Dead units are invisible.
 * - Flags are shown if they sit on a visible hex (either on the ground or
 *   carried by a unit standing on that hex).
 */
export function buildVisibleState(
  viewer: FogUnit,
  allUnits: FogUnit[],
  walls: Set<string>,
  tiles: Map<string, string>, // "q,r" -> tile type
  flags: {
    A:
      | { position: Hex; carried: boolean; carrierId?: string }[]
      | { position: Hex; carried: boolean; carrierId?: string };
    B:
      | { position: Hex; carried: boolean; carrierId?: string }[]
      | { position: Hex; carried: boolean; carrierId?: string };
  },
): VisibleTile[] {
  const visibleKeys = getUnitVision(viewer, walls, new Set(tiles.keys()));

  // Normalize flags to arrays
  const allFlags: { team: 'A' | 'B'; position: Hex; carried: boolean; carrierId?: string }[] = [];
  for (const team of ['A', 'B'] as const) {
    const f = flags[team];
    const arr = Array.isArray(f) ? f : [f];
    for (const flag of arr) {
      allFlags.push({ team, ...flag });
    }
  }

  // Index alive units by hex key for quick lookup
  const unitsByHex = new Map<string, FogUnit[]>();
  for (const u of allUnits) {
    if (!u.alive) continue;
    const key = hexToString(u.position);
    const list = unitsByHex.get(key) ?? [];
    list.push(u);
    unitsByHex.set(key, list);
  }

  // Index flags by hex key (multiple flags can be on different hexes)
  const flagsByHex = new Map<string, 'A' | 'B'>();
  for (const f of allFlags) {
    if (!f.carried) {
      flagsByHex.set(hexToString(f.position), f.team);
    } else if (f.carrierId) {
      const carrier = allUnits.find((u) => u.id === f.carrierId && u.alive);
      if (carrier) {
        flagsByHex.set(hexToString(carrier.position), f.team);
      }
    }
  }

  const result: VisibleTile[] = [];

  for (const key of visibleKeys) {
    const hex = stringToHex(key);
    const tileType = (tiles.get(key) ?? 'ground') as VisibleTile['type'];

    const tile: VisibleTile = {
      q: hex.q,
      r: hex.r,
      type: tileType,
    };

    // Check for units on this hex
    const unitsHere = unitsByHex.get(key);
    if (unitsHere && unitsHere.length > 0) {
      const u = unitsHere[0];
      // @ts-expect-error TS18048: 'u' is possibly 'undefined'. — TODO(2.3-followup)
      const isAlly = u.team === viewer.team;

      // @ts-expect-error TS18048: 'u' is possibly 'undefined'. — TODO(2.3-followup)
      const isCarrying = allFlags.some((f) => f.carrierId === u.id && f.carried);

      tile.unit = {
        // @ts-expect-error TS18048: 'u' is possibly 'undefined'. — TODO(2.3-followup)
        ...(isAlly ? { id: u.id } : {}),
        // @ts-expect-error TS18048: 'u' is possibly 'undefined'. — TODO(2.3-followup)
        team: u.team,
        // @ts-expect-error TS18048: 'u' is possibly 'undefined'. — TODO(2.3-followup)
        unitClass: u.unitClass,
        ...(isCarrying ? { carryingFlag: true } : {}),
      };
    }

    // Check for flag on this hex
    const flagTeam = flagsByHex.get(key);
    if (flagTeam !== undefined) {
      tile.flag = { team: flagTeam };
    }

    result.push(tile);
  }

  return result;
}
