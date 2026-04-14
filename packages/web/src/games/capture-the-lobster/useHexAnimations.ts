import { useState, useEffect, useRef, useCallback } from 'react';
import type { VisibleTile, KillEvent } from '../../types';

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
  /** Kill location (victim's position) */
  x: number;
  y: number;
  killerX: number;
  killerY: number;
  killerId: string;
  /** 0..1 progress through the kill animation */
  progress: number;
}

type AnimPhase = 'idle' | 'moving' | 'combat' | 'done';

interface AnimationState {
  phase: AnimPhase;
  /** Units currently being animated (rendered as floating, hidden from tiles) */
  floatingUnits: FloatingUnit[];
  /** Active kill effects */
  killEffects: KillEffect[];
  /** Unit IDs to hide from normal tile rendering */
  hiddenUnitIds: Set<string>;
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
  startDelay: number; // ms before this unit starts moving
}

interface PendingKill {
  victimId: string;
  killerId: string;
  victimX: number;
  victimY: number;
  killerX: number;
  killerY: number;
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/** Ease-out-back: slight overshoot then settle */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MOVE_DURATION = 600; // ms per unit movement
const MOVE_STAGGER = 200; // ms between unit start times
const COMBAT_DELAY = 150; // ms pause between movement and combat
const KILL_DURATION = 600; // ms per kill animation
const KILL_STAGGER = 200; // ms between kill start times

export function useHexAnimations(
  prevTiles: VisibleTile[] | null,
  currentTiles: VisibleTile[],
  animate: boolean,
  kills: KillEvent[],
): AnimationState {
  const [state, setState] = useState<AnimationState>({
    phase: 'idle',
    floatingUnits: [],
    killEffects: [],
    hiddenUnitIds: new Set(),
  });

  const rafRef = useRef<number>(0);
  const animStartRef = useRef<number>(0);
  const movingUnitsRef = useRef<MovingUnit[]>([]);
  const pendingKillsRef = useRef<PendingKill[]>([]);
  const moveEndTimeRef = useRef<number>(0);
  const totalAnimTimeRef = useRef<number>(0);
  // Track the turn pair we're animating to avoid re-triggering
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
    // Generate a key for this transition to avoid re-triggering
    const prevTurn = prevTiles?.[0] ? `${prevTiles.length}` : 'none';
    const currTurn = `${currentTiles.length}`;
    // Use the turn numbers from the state if available
    const prevUnits = prevTiles ? extractUnits(prevTiles) : new Map();
    const currUnits = extractUnits(currentTiles);
    const posKey = Array.from(currUnits.values())
      .map(u => `${u.id}:${u.q},${u.r}:${u.alive}`)
      .join('|');
    const newKey = `${prevTurn}-${currTurn}-${posKey}`;

    if (!animate || !prevTiles || newKey === animKeyRef.current) {
      // No animation — show current state as-is
      cleanup();
      setState({
        phase: 'idle',
        floatingUnits: [],
        killEffects: [],
        hiddenUnitIds: new Set(),
      });
      if (!animate) animKeyRef.current = '';
      return;
    }

    animKeyRef.current = newKey;

    // Diff units to find movers and kills
    const movers: MovingUnit[] = [];
    let staggerIdx = 0;

    for (const [id, curr] of currUnits) {
      const prev = prevUnits.get(id);
      if (!prev) continue; // new unit (respawn?) — just pop in
      if (prev.q === curr.q && prev.r === curr.r) continue; // didn't move

      const [fromX, fromY] = axialToPixel(prev.q, prev.r);
      const [toX, toY] = axialToPixel(curr.q, curr.r);

      movers.push({
        id,
        team: curr.team,
        unitClass: curr.unitClass,
        carryingFlag: curr.carryingFlag,
        alive: curr.alive,
        fromX,
        fromY,
        toX,
        toY,
        startDelay: staggerIdx * MOVE_STAGGER,
      });
      staggerIdx++;
    }

    // Find kills that happened this turn (units alive in prev, dead in current)
    const pendingKills: PendingKill[] = [];
    for (const kill of kills) {
      const victim = currUnits.get(kill.victimId);
      const killer = currUnits.get(kill.killerId);
      const prevVictim = prevUnits.get(kill.victimId);
      if (!victim || !prevVictim) continue;
      // Only animate kills that happened between these two snapshots
      if (prevVictim.alive && !victim.alive) {
        const [vx, vy] = axialToPixel(victim.q, victim.r);
        const [kx, ky] = killer
          ? axialToPixel(killer.q, killer.r)
          : [vx, vy];
        pendingKills.push({
          victimId: kill.victimId,
          killerId: kill.killerId,
          victimX: vx,
          victimY: vy,
          killerX: kx,
          killerY: ky,
        });
      }
    }

    // If nothing to animate, skip
    if (movers.length === 0 && pendingKills.length === 0) {
      setState({
        phase: 'idle',
        floatingUnits: [],
        killEffects: [],
        hiddenUnitIds: new Set(),
      });
      return;
    }

    // Calculate timing
    const moveEndTime = movers.length > 0
      ? (movers.length - 1) * MOVE_STAGGER + MOVE_DURATION
      : 0;
    const combatStartTime = moveEndTime + COMBAT_DELAY;
    const combatEndTime = pendingKills.length > 0
      ? combatStartTime + (pendingKills.length - 1) * KILL_STAGGER + KILL_DURATION
      : combatStartTime;

    movingUnitsRef.current = movers;
    pendingKillsRef.current = pendingKills;
    moveEndTimeRef.current = moveEndTime;
    totalAnimTimeRef.current = combatEndTime;

    // All animated unit IDs (movers + kill victims)
    const allAnimatedIds = new Set([
      ...movers.map(m => m.id),
      ...pendingKills.map(k => k.victimId),
    ]);

    // Start animation loop
    cleanup();
    animStartRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - animStartRef.current;

      if (elapsed >= combatEndTime + 100) {
        // Animation complete
        setState({
          phase: 'idle',
          floatingUnits: [],
          killEffects: [],
          hiddenUnitIds: new Set(),
        });
        return;
      }

      // Compute floating unit positions
      const floating: FloatingUnit[] = [];

      for (const m of movingUnitsRef.current) {
        const unitElapsed = elapsed - m.startDelay;
        if (unitElapsed < 0) {
          // Not started yet — show at start position
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
          // Done moving — don't float anymore (tile rendering takes over)
        } else {
          // Interpolating
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

      // Compute kill effects
      const effects: KillEffect[] = [];
      for (let i = 0; i < pendingKillsRef.current.length; i++) {
        const k = pendingKillsRef.current[i];
        const killStart = combatStartTime + i * KILL_STAGGER;
        const killElapsed = elapsed - killStart;

        if (killElapsed < 0) continue;
        const progress = killElapsed >= KILL_DURATION ? 1 : killElapsed / KILL_DURATION;
        effects.push({
          victimId: k.victimId,
          killerId: k.killerId,
          x: k.victimX,
          y: k.victimY,
          killerX: k.killerX,
          killerY: k.killerY,
          progress,
        });
      }

      // Determine which unit IDs are currently floating (should be hidden from tiles)
      const hiddenIds = new Set<string>();
      for (const f of floating) {
        hiddenIds.add(f.id);
      }
      // Also hide victims during their kill animation
      for (const e of effects) {
        if (e.progress < 1) hiddenIds.add(e.victimId);
      }

      const phase: AnimPhase = elapsed < moveEndTime ? 'moving'
        : elapsed < combatEndTime ? 'combat'
        : 'done';

      setState({
        phase,
        floatingUnits: floating,
        killEffects: effects,
        hiddenUnitIds: hiddenIds,
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [prevTiles, currentTiles, animate, kills, cleanup]);

  return state;
}
