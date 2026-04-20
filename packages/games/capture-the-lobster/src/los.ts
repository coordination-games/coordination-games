import { type Hex, hexEquals, hexesInRadius, hexesOnLine, hexToString } from './hex.js';

/**
 * Check if there's clear line of sight between two hexes.
 * LoS is blocked if any intermediate hex (not start or end) is a wall.
 */
export function hasLineOfSight(from: Hex, to: Hex, walls: Set<string>): boolean {
  if (hexEquals(from, to)) return true;

  const line = hexesOnLine(from, to);

  // Check intermediate hexes only (skip first and last)
  for (let i = 1; i < line.length - 1; i++) {
    // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
    if (walls.has(hexToString(line[i]))) {
      return false;
    }
  }

  return true;
}

/**
 * Get all hexes visible from a position within a given radius.
 * A hex is visible if it's within radius AND has clear LoS from the position.
 * Walls themselves ARE visible (you can see a wall) but block vision behind them.
 * The position hex itself is always visible.
 */
export function getVisibleHexes(
  position: Hex,
  radius: number,
  walls: Set<string>,
  allHexes: Set<string>,
): Set<string> {
  const visible = new Set<string>();
  const posKey = hexToString(position);

  // Position itself is always visible
  if (allHexes.has(posKey)) {
    visible.add(posKey);
  }

  if (radius === 0) return visible;

  // Check each hex within radius
  const candidates = hexesInRadius(position, radius);

  for (const hex of candidates) {
    const key = hexToString(hex);

    // Skip if not part of the map or already added
    if (!allHexes.has(key) || key === posKey) continue;

    // Get the line from position to this hex
    const line = hexesOnLine(position, hex);

    let blocked = false;
    // Check intermediate hexes (skip start and end)
    for (let i = 1; i < line.length - 1; i++) {
      // @ts-expect-error TS2345: Argument of type 'Hex | undefined' is not assignable to parameter of type 'Hex'. — TODO(2.3-followup)
      if (walls.has(hexToString(line[i]))) {
        blocked = true;
        break;
      }
    }

    if (!blocked) {
      visible.add(key);
    }
  }

  return visible;
}
