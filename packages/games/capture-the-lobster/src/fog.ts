import type { HexTuple } from '@coordination-games/engine';
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

/**
 * Occupant bits (unit/flag) on a single hex the viewer can see.
 *
 * Emit shape (agent envelope): `pos: [q, r]` tuple — this entry carries
 * optional `unit`/`flag` metadata alongside the coord, so we keep it as an
 * object (the "thing at a position" idiom). Pure-coord arrays like
 * `visibleWalls` skip the wrapper and go straight to `HexTuple[]`.
 */
export interface VisibleOccupant {
  pos: HexTuple;
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

export function getUnitVision(
  unit: FogUnit,
  walls: Set<string>,
  allHexes: Set<string>,
): Set<string> {
  const radius = CLASS_VISION[unit.unitClass];
  return getVisibleHexes(unit.position, radius, walls, allHexes);
}

/**
 * Agent-facing fog view: what the viewer can see this turn.
 *
 * Returns:
 * - `occupants`: only hexes with a unit or flag (empty ground elided — agent
 *   infers it). Allies include unit ID; enemies don't. Dead units hidden.
 * - `visibleKeys`: the full set of hex keys the viewer has LoS to.
 * - `walls`: walls within vision (subset of the map's wall set). Walls
 *   outside LoS are NOT revealed.
 *
 * Terrain that isn't a wall is inferable from `visibleKeys` − `walls` − base
 * tiles, so we don't emit it.
 */
export function buildVisibleOccupants(
  viewer: FogUnit,
  allUnits: FogUnit[],
  wallSet: Set<string>,
  allHexes: Set<string>,
  flags: {
    A: { position: Hex; carried: boolean; carrierId?: string }[];
    B: { position: Hex; carried: boolean; carrierId?: string }[];
  },
): { occupants: VisibleOccupant[]; visibleKeys: Set<string>; walls: HexTuple[] } {
  const visibleKeys = getUnitVision(viewer, wallSet, allHexes);

  const unitsById = new Map<string, FogUnit>();
  const unitsByHex = new Map<string, FogUnit>();
  for (const u of allUnits) {
    unitsById.set(u.id, u);
    if (u.alive) unitsByHex.set(hexToString(u.position), u);
  }

  const flagsByHex = new Map<string, 'A' | 'B'>();
  const carriersById = new Set<string>();
  for (const team of ['A', 'B'] as const) {
    for (const f of flags[team]) {
      if (!f.carried) {
        flagsByHex.set(hexToString(f.position), team);
      } else if (f.carrierId) {
        carriersById.add(f.carrierId);
        const carrier = unitsById.get(f.carrierId);
        if (carrier?.alive) flagsByHex.set(hexToString(carrier.position), team);
      }
    }
  }

  // Envelope-boundary coord conversion: walls and occupant `pos` go out as
  // tuples. `visibleKeys` stays as string keys (internal set semantics).
  const occupants: VisibleOccupant[] = [];
  const walls: HexTuple[] = [];
  for (const key of visibleKeys) {
    if (wallSet.has(key)) {
      const hex = stringToHex(key);
      walls.push([hex.q, hex.r]);
    }

    const u = unitsByHex.get(key);
    const flagTeam = flagsByHex.get(key);
    if (!u && flagTeam === undefined) continue;

    const hex = stringToHex(key);
    const occ: VisibleOccupant = { pos: [hex.q, hex.r] };
    if (u) {
      const isAlly = u.team === viewer.team;
      occ.unit = {
        ...(isAlly ? { id: u.id } : {}),
        team: u.team,
        unitClass: u.unitClass,
        ...(carriersById.has(u.id) ? { carryingFlag: true } : {}),
      };
    }
    if (flagTeam !== undefined) occ.flag = { team: flagTeam };
    occupants.push(occ);
  }

  return { occupants, visibleKeys, walls };
}
