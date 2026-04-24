import { type Hex, hexDistance } from './hex.js';
import { hasLineOfSight } from './los.js';
import type { UnitClass } from './movement.js';

export const CLASS_VISION: Record<UnitClass, number> = {
  rogue: 4,
  knight: 2,
  mage: 3,
};

export const CLASS_RANGE: Record<UnitClass, number> = {
  rogue: 1,
  knight: 1,
  mage: 2,
};

/** RPS triangle: rogue > mage > knight > rogue */
const BEATS: Record<UnitClass, UnitClass> = {
  rogue: 'mage',
  knight: 'rogue',
  mage: 'knight',
};

/** Returns true if attacker's class beats defender's class. */
export function beats(attacker: UnitClass, defender: UnitClass): boolean {
  return BEATS[attacker] === defender;
}

export interface CombatUnit {
  id: string;
  team: 'A' | 'B';
  unitClass: UnitClass;
  position: Hex;
}

export interface CombatResult {
  kills: { killerId: string; victimId: string; reason: string }[];
  deaths: Set<string>;
}

/**
 * Resolve all combat for a turn. All resolution is simultaneous —
 * units that die still get their attacks.
 *
 * @param units  All units on the board after movement.
 * @param walls  Set of "q,r" strings for LoS checks.
 */
export function resolveCombat(units: CombatUnit[], walls: Set<string>): CombatResult {
  const kills: { killerId: string; victimId: string; reason: string }[] = [];

  // Phase 1a: Melee — check every pair of opposing units within distance ≤ 1
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];

      // Skip same-team pairs
      // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
      if (a.team === b.team) continue;

      // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
      const dist = hexDistance(a.position, b.position);
      if (dist > 1) continue;

      // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
      if (a.unitClass === b.unitClass) {
        // Same class: mutual kill only on same hex (distance 0)
        if (dist === 0) {
          kills.push({
            // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
            killerId: a.id,
            // @ts-expect-error TS18048: 'b' is possibly 'undefined'. — TODO(2.3-followup)
            victimId: b.id,
            // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
            reason: `mutual kill (same class ${a.unitClass} on same hex)`,
          });
          kills.push({
            // @ts-expect-error TS18048: 'b' is possibly 'undefined'. — TODO(2.3-followup)
            killerId: b.id,
            // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
            victimId: a.id,
            // @ts-expect-error TS18048: 'b' is possibly 'undefined'. — TODO(2.3-followup)
            reason: `mutual kill (same class ${b.unitClass} on same hex)`,
          });
        }
        // Same class at distance 1: nothing happens
      } else {
        // Different classes: RPS resolution
        // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
        if (beats(a.unitClass, b.unitClass)) {
          kills.push({
            // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
            killerId: a.id,
            // @ts-expect-error TS18048: 'b' is possibly 'undefined'. — TODO(2.3-followup)
            victimId: b.id,
            // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
            reason: `${a.unitClass} beats ${b.unitClass} in melee`,
          });
        }
        // @ts-expect-error TS18048: 'b' is possibly 'undefined'. — TODO(2.3-followup)
        if (beats(b.unitClass, a.unitClass)) {
          kills.push({
            // @ts-expect-error TS18048: 'b' is possibly 'undefined'. — TODO(2.3-followup)
            killerId: b.id,
            // @ts-expect-error TS18048: 'a' is possibly 'undefined'. — TODO(2.3-followup)
            victimId: a.id,
            // @ts-expect-error TS18048: 'b' is possibly 'undefined'. — TODO(2.3-followup)
            reason: `${b.unitClass} beats ${a.unitClass} in melee`,
          });
        }
      }
    }
  }

  // Phase 1b: Mage ranged kills — mages kill enemy knights at distance exactly 2 with LoS
  for (const mage of units) {
    if (mage.unitClass !== 'mage') continue;

    for (const target of units) {
      // Only target enemy knights
      if (target.team === mage.team) continue;
      if (target.unitClass !== 'knight') continue;

      const dist = hexDistance(mage.position, target.position);
      // Only distance exactly 2 (distance 0 and 1 already handled in melee)
      if (dist !== 2) continue;

      if (hasLineOfSight(mage.position, target.position, walls)) {
        kills.push({
          killerId: mage.id,
          victimId: target.id,
          reason: `mage ranged kill on knight at distance 2`,
        });
      }
    }
  }

  // Phase 2: Compile deaths
  const deaths = new Set<string>();
  for (const kill of kills) {
    deaths.add(kill.victimId);
  }

  return { kills, deaths };
}
