import { useCallback, useEffect, useRef, useState } from 'react';
import type { KillEvent, VisibleTile } from '../../types';

const SQRT3 = Math.sqrt(3);
const HEX_SIZE = 28;

/** Axial to pixel (flat-top) — must match HexGrid */
function axialToPixel(q: number, r: number): [number, number] {
  const x = HEX_SIZE * (3 / 2) * q;
  const y = HEX_SIZE * ((SQRT3 / 2) * q + SQRT3 * r);
  return [x, y];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FloatingUnit {
  id: string;
  team: 'A' | 'B';
  unitClass: 'rogue' | 'knight' | 'mage';
  carryingFlag: boolean;
  alive: boolean;
  x: number;
  y: number;
}

export interface KillEffect {
  victimId: string;
  /** Where the victim died (post-move position) */
  x: number;
  y: number;
  /** Where the victim respawns */
  respawnX: number;
  respawnY: number;
  killerX: number;
  killerY: number;
  killerId: string;
  /** 0..1 progress through kill animation (poof/skull at death spot) */
  progress: number;
  /** 0..1 progress through float-to-respawn */
  floatProgress: number;
}

type AnimPhase = 'idle' | 'vision-out' | 'moving' | 'combat' | 'done';

export interface AnimationState {
  phase: AnimPhase;
  floatingUnits: FloatingUnit[];
  killEffects: KillEffect[];
  hiddenUnitIds: Set<string>;
  visionOpacity: number;
  dyingUnitIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Diffing helpers
// ---------------------------------------------------------------------------

interface UnitSnapshot {
  id: string;
  team: 'A' | 'B';
  unitClass: 'rogue' | 'knight' | 'mage';
  carryingFlag: boolean;
  alive: boolean;
  q: number;
  r: number;
}

function extractUnits(tiles: VisibleTile[]): Map<string, UnitSnapshot> {
  const units = new Map<string, UnitSnapshot>();
  for (const tile of tiles) {
    if (tile.unit?.id) {
      units.set(tile.unit.id, {
        id: tile.unit.id,
        team: tile.unit.team,
        unitClass: tile.unit.unitClass,
        carryingFlag: tile.unit.carryingFlag ?? false,
        alive: tile.unit.alive !== false,
        q: tile.q,
        r: tile.r,
      });
    }
  }
  return units;
}

interface MovingUnit {
  id: string;
  team: 'A' | 'B';
  unitClass: 'rogue' | 'knight' | 'mage';
  carryingFlag: boolean;
  alive: boolean;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startDelay: number;
}

interface PendingKill {
  victimId: string;
  killerId: string;
  /** Where the victim died (post-move, pre-respawn) */
  deathX: number;
  deathY: number;
  /** Where the victim respawns (from currentTiles) */
  respawnX: number;
  respawnY: number;
  killerX: number;
  killerY: number;
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const VISION_FADE_OUT = 300;
const VISION_PAUSE = 150;
const VISION_FADE_IN = 300;
const MOVE_DURATION = 600;
const MOVE_STAGGER = 400;
const COMBAT_DELAY = 300;
const KILL_DURATION = 700;
const KILL_STAGGER = 250;
const FLOAT_DURATION = 500;

const IDLE_STATE: AnimationState = {
  phase: 'idle',
  floatingUnits: [],
  killEffects: [],
  hiddenUnitIds: new Set(),
  visionOpacity: 1,
  dyingUnitIds: new Set(),
};

export function useHexAnimations(
  prevTiles: VisibleTile[] | null,
  currentTiles: VisibleTile[],
  animate: boolean,
  kills: KillEvent[],
  /** Post-move positions for units killed this turn (from server) */
  deathPositions?: Record<string, { q: number; r: number }>,
): AnimationState {
  const [state, setState] = useState<AnimationState>(IDLE_STATE);

  const rafRef = useRef<number>(0);
  const animStartRef = useRef<number>(0);
  const movingUnitsRef = useRef<MovingUnit[]>([]);
  const pendingKillsRef = useRef<PendingKill[]>([]);
  const dyingIdsRef = useRef<Set<string>>(new Set());
  const animKeyRef = useRef<string>('');

  const cleanup = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  useEffect(() => {
    const prevTurn = prevTiles?.[0] ? `${prevTiles.length}` : 'none';
    const currTurn = `${currentTiles.length}`;
    const prevUnits = prevTiles ? extractUnits(prevTiles) : new Map();
    const currUnits = extractUnits(currentTiles);
    const posKey = Array.from(currUnits.values())
      .map((u) => `${u.id}:${u.q},${u.r}:${u.alive}`)
      .join('|');
    const newKey = `${prevTurn}-${currTurn}-${posKey}`;

    if (!animate || !prevTiles || newKey === animKeyRef.current) {
      cleanup();
      setState(IDLE_STATE);
      if (!animate) animKeyRef.current = '';
      return;
    }

    animKeyRef.current = newKey;

    // Identify dying units
    const dyingIds = new Set<string>();
    for (const kill of kills) {
      const victim = currUnits.get(kill.victimId);
      const prevVictim = prevUnits.get(kill.victimId);
      if (victim && prevVictim?.alive && !victim.alive) {
        dyingIds.add(kill.victimId);
      }
    }

    // ALL units that moved get movement animations — including dying ones
    // Dying units move from prevTiles → deathPosition (where they were killed)
    // Surviving units move from prevTiles → currentTiles position
    const movers: MovingUnit[] = [];
    let staggerIdx = 0;

    for (const [id, curr] of currUnits) {
      const prev = prevUnits.get(id);
      if (!prev) continue;

      let toQ: number, toR: number;
      if (dyingIds.has(id) && deathPositions?.[id]) {
        // Dying unit: move to where they died (post-move, pre-respawn)
        toQ = deathPositions[id].q;
        toR = deathPositions[id].r;
      } else {
        // Surviving unit: move to current position
        toQ = curr.q;
        toR = curr.r;
      }

      if (prev.q === toQ && prev.r === toR) continue; // didn't move

      const [fromX, fromY] = axialToPixel(prev.q, prev.r);
      const [toX, toY] = axialToPixel(toQ, toR);

      movers.push({
        id,
        team: curr.team,
        unitClass: curr.unitClass,
        carryingFlag: prev.carryingFlag,
        alive: true, // alive during movement
        fromX,
        fromY,
        toX,
        toY,
        startDelay: staggerIdx * MOVE_STAGGER,
      });
      staggerIdx++;
    }

    // Build kill data: death at deathPosition, respawn at currentTiles position
    const pendingKills: PendingKill[] = [];
    for (const kill of kills) {
      const victim = currUnits.get(kill.victimId);
      const killer = currUnits.get(kill.killerId);
      const prevVictim = prevUnits.get(kill.victimId);
      if (!victim || !prevVictim) continue;
      if (prevVictim.alive && !victim.alive) {
        // Death position: from server data, or fall back to prev position
        const deathPos = deathPositions?.[kill.victimId] ?? { q: prevVictim.q, r: prevVictim.r };
        const [deathX, deathY] = axialToPixel(deathPos.q, deathPos.r);
        const [respawnX, respawnY] = axialToPixel(victim.q, victim.r);
        const [kx, ky] = killer ? axialToPixel(killer.q, killer.r) : [deathX, deathY];
        pendingKills.push({
          victimId: kill.victimId,
          killerId: kill.killerId,
          deathX,
          deathY,
          respawnX,
          respawnY,
          killerX: kx,
          killerY: ky,
        });
      }
    }

    if (movers.length === 0 && pendingKills.length === 0) {
      setState(IDLE_STATE);
      return;
    }

    // Timeline:
    // vision-fade-out → pause → movement (all units incl dying) → combat (poof at death spot) → float-to-respawn → vision-fade-in
    const moveStart = VISION_FADE_OUT + VISION_PAUSE;
    const moveEndTime =
      movers.length > 0
        ? moveStart + (movers.length - 1) * MOVE_STAGGER + MOVE_DURATION
        : moveStart;
    const combatStartTime = moveEndTime + COMBAT_DELAY;
    const combatEndTime =
      pendingKills.length > 0
        ? combatStartTime + (pendingKills.length - 1) * KILL_STAGGER + KILL_DURATION
        : combatStartTime;
    const floatStartTime = combatEndTime + 100;
    const floatEndTime = pendingKills.length > 0 ? floatStartTime + FLOAT_DURATION : floatStartTime;
    const visionFadeInStart = floatEndTime + 50;
    const totalTime = visionFadeInStart + VISION_FADE_IN;

    movingUnitsRef.current = movers;
    pendingKillsRef.current = pendingKills;
    dyingIdsRef.current = dyingIds;

    cleanup();
    animStartRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - animStartRef.current;

      if (elapsed >= totalTime + 50) {
        setState(IDLE_STATE);
        return;
      }

      // Vision opacity
      let visionOpacity: number;
      if (elapsed < VISION_FADE_OUT) {
        visionOpacity = 1 - elapsed / VISION_FADE_OUT;
      } else if (elapsed < visionFadeInStart) {
        visionOpacity = 0;
      } else {
        visionOpacity = Math.min(1, (elapsed - visionFadeInStart) / VISION_FADE_IN);
      }

      // Movement phase — all units including dying ones
      const floating: FloatingUnit[] = [];
      for (const m of movingUnitsRef.current) {
        const unitElapsed = elapsed - moveStart - m.startDelay;
        if (unitElapsed < 0) {
          floating.push({
            id: m.id,
            team: m.team,
            unitClass: m.unitClass,
            carryingFlag: m.carryingFlag,
            alive: m.alive,
            x: m.fromX,
            y: m.fromY,
          });
        } else if (unitElapsed >= MOVE_DURATION) {
          // Dying units: stay floating at death position until kill anim starts
          if (dyingIdsRef.current.has(m.id) && elapsed < combatStartTime) {
            floating.push({
              id: m.id,
              team: m.team,
              unitClass: m.unitClass,
              carryingFlag: m.carryingFlag,
              alive: true,
              x: m.toX,
              y: m.toY,
            });
          }
          // Surviving units: tile rendering takes over
        } else {
          const t = easeOutBack(unitElapsed / MOVE_DURATION);
          floating.push({
            id: m.id,
            team: m.team,
            unitClass: m.unitClass,
            carryingFlag: m.carryingFlag,
            alive: m.alive,
            x: m.fromX + (m.toX - m.fromX) * t,
            y: m.fromY + (m.toY - m.fromY) * t,
          });
        }
      }

      // Kill effects
      const effects: KillEffect[] = [];
      for (let i = 0; i < pendingKillsRef.current.length; i++) {
        const k = pendingKillsRef.current[i];
        const killStart = combatStartTime + i * KILL_STAGGER;
        const killElapsed = elapsed - killStart;
        if (killElapsed < 0) continue;
        const progress = killElapsed >= KILL_DURATION ? 1 : killElapsed / KILL_DURATION;

        const floatElapsed = elapsed - floatStartTime;
        const floatProgress =
          floatElapsed < 0
            ? 0
            : floatElapsed >= FLOAT_DURATION
              ? 1
              : easeOutCubic(floatElapsed / FLOAT_DURATION);

        effects.push({
          // @ts-expect-error TS18048: 'k' is possibly 'undefined'. — TODO(2.3-followup)
          victimId: k.victimId,
          // @ts-expect-error TS18048: 'k' is possibly 'undefined'. — TODO(2.3-followup)
          killerId: k.killerId,
          // @ts-expect-error TS18048: 'k' is possibly 'undefined'. — TODO(2.3-followup)
          x: k.deathX,
          // @ts-expect-error TS18048: 'k' is possibly 'undefined'. — TODO(2.3-followup)
          y: k.deathY,
          // @ts-expect-error TS18048: 'k' is possibly 'undefined'. — TODO(2.3-followup)
          respawnX: k.respawnX,
          // @ts-expect-error TS18048: 'k' is possibly 'undefined'. — TODO(2.3-followup)
          respawnY: k.respawnY,
          // @ts-expect-error TS18048: 'k' is possibly 'undefined'. — TODO(2.3-followup)
          killerX: k.killerX,
          // @ts-expect-error TS18048: 'k' is possibly 'undefined'. — TODO(2.3-followup)
          killerY: k.killerY,
          progress,
          floatProgress,
        });
      }

      // Hidden IDs
      const hiddenIds = new Set<string>();
      for (const f of floating) hiddenIds.add(f.id);
      for (const e of effects) {
        if (e.floatProgress < 1) hiddenIds.add(e.victimId);
      }
      // Also hide dying units that finished moving but kill hasn't started yet
      // (they're in floating above, but also need to be hidden from tile rendering)

      const currentlyDying =
        elapsed >= combatStartTime && elapsed < totalTime ? dyingIdsRef.current : new Set<string>();

      const phase: AnimPhase =
        elapsed < VISION_FADE_OUT
          ? 'vision-out'
          : elapsed < moveEndTime
            ? 'moving'
            : elapsed < floatEndTime
              ? 'combat'
              : 'done';

      setState({
        phase,
        floatingUnits: floating,
        killEffects: effects,
        hiddenUnitIds: hiddenIds,
        visionOpacity: Math.max(0, Math.min(1, visionOpacity)),
        dyingUnitIds: currentlyDying,
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [prevTiles, currentTiles, animate, kills, deathPositions, cleanup]);

  return state;
}
