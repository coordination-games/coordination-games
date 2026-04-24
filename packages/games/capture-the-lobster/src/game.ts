/**
 * Capture the Lobster — Stateless Game Engine
 *
 * All game logic is expressed as pure functions: state in, state out.
 * No mutable classes, no caching. The framework (GameRoomDO) holds the state
 * and passes it to these functions each turn.
 */

import { mustFind } from '@coordination-games/engine';
import { CLASS_RANGE, CLASS_VISION, type CombatUnit, resolveCombat } from './combat.js';
import { buildVisibleOccupants, type FogUnit, type VisibleOccupant } from './fog.js';
import { type Direction, type Hex, hexEquals, hexToString } from './hex.js';
import type { GameMap } from './map.js';
import {
  type MoveSubmission,
  type MoveUnit,
  resolveMovements,
  type UnitClass,
  validatePath,
} from './movement.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GameUnit {
  id: string;
  team: 'A' | 'B';
  unitClass: UnitClass;
  position: Hex;
  alive: boolean;
  carryingFlag: boolean;
  /** Turn number when this unit will respawn (undefined = not dead) */
  respawnTurn?: number;
}

export interface FlagState {
  team: 'A' | 'B';
  position: Hex;
  carried: boolean;
  carrierId?: string;
}

export interface TurnRecord {
  turn: number;
  moves: Map<string, Direction[]>;
  unitPositionsBefore: Map<string, Hex>;
  unitPositionsAfter: Map<string, Hex>;
  kills: { killerId: string; victimId: string; reason: string }[];
  flagEvents: string[];
}

export type GamePhase = 'pre_game' | 'in_progress' | 'finished';

/**
 * Static per-game map data — same value every turn, so the agent envelope's
 * top-level diff collapses it into `_unchangedKeys` after the first
 * observation. Walls are NOT here because they're fog-filtered per-turn;
 * see `visibleWalls` on `GameState`. Bases are public (CtF convention —
 * you always know where both teams' bases are).
 */
export interface AgentMapStatic {
  radius: number;
  bases: {
    A: { flag: Hex; spawns: Hex[] }[];
    B: { flag: Hex; spawns: Hex[] }[];
  };
}

/**
 * Condensed at-a-glance read for the agent — everything you need to make
 * a decision this turn, without parsing `map`/`visibleOccupants`. Dedupes
 * via the top-level `_unchangedKeys` diff when nothing actionable changed.
 */
export type YourFlagStatus = 'at_base' | 'carried' | 'unknown';
export type EnemyFlagStatus = 'at_base' | 'carried_by_you' | 'carried_by_ally' | 'unknown';

export interface AgentSummary {
  turn: number;
  phase: GamePhase;
  pos: Hex;
  carrying: boolean;
  alive: boolean;
  moveSubmitted: boolean;
  score: { yourTeam: number; enemyTeam: number };
  yourFlag: YourFlagStatus;
  enemyFlag: EnemyFlagStatus;
  /** Visible enemy units this turn (no ID for fog reasons). */
  enemies: { q: number; r: number; unitClass: UnitClass }[];
  /** Visible loose/carried flags this turn. */
  flags: { q: number; r: number; team: 'A' | 'B' }[];
}

export interface GameState {
  /** Lean at-a-glance summary — read this first; parse `map`/`visibleOccupants` only if you need terrain or positions. */
  summary: AgentSummary;
  turn: number;
  phase: GamePhase;
  yourUnit: {
    id: string;
    unitClass: UnitClass;
    position: Hex;
    carryingFlag: boolean;
    alive: boolean;
    respawnTurn?: number;
    /** Hex radius you can see (class-specific: rogue=4, knight=2, mage=3). */
    visionRange: number;
    /** Hex radius you can attack from (class-specific: rogue=1, knight=1, mage=2). */
    attackRange: number;
  };
  /** Static map info (radius + bases). Dedupes via _unchangedKeys after turn 0. */
  mapStatic: AgentMapStatic;
  /**
   * Walls currently within your vision. Fog-filtered per turn — walls you
   * haven't seen yet are not revealed. A hex you can see that isn't in
   * `visibleWalls` and isn't a base tile is walkable ground.
   */
  visibleWalls: Hex[];
  /** Per-turn: only visible hexes that contain a unit or flag. Tiny. */
  visibleOccupants: VisibleOccupant[];
  yourFlag: { status: YourFlagStatus };
  enemyFlag: { status: EnemyFlagStatus };
  timeRemainingSeconds: number;
  moveSubmitted: boolean;
  score: { yourTeam: number; enemyTeam: number };
}

export interface GameConfig {
  turnLimit?: number;
  turnTimerSeconds?: number;
  teamSize?: number;
}

/**
 * The full game state — a plain, serializable object.
 * This is the single source of truth passed between turns.
 */
export interface CtlGameState {
  turn: number;
  phase: GamePhase;
  units: GameUnit[];
  flags: { A: FlagState[]; B: FlagState[] };
  score: { A: number; B: number };
  winner: 'A' | 'B' | null;
  config: Required<GameConfig>;
  /** Serialized map for state portability */
  mapTiles: [string, string][];
  mapRadius: number;
  mapBases: {
    A: { flag: Hex; spawns: Hex[] }[];
    B: { flag: Hex; spawns: Hex[] }[];
  };
  /** Current turn's move submissions (cleared after resolution) */
  moveSubmissions: [string, Direction[]][];
  /** All kills across all turns (cumulative, for replay snapshots) */
  allKills: { killerId: string; victimId: string; reason: string; turn: number }[];
  /** Post-move positions for units that died this turn (for animation: move → die → respawn) */
  lastDeathPositions?: Record<string, { q: number; r: number }>;
  /**
   * Absolute ms timestamp (Date.now() scale) when the current turn's timer
   * expires. Set by the plugin's action handlers whenever a new
   * `turnTimeoutDeadline` is scheduled; used by `getStateForAgent` to derive
   * `timeRemainingSeconds`. Undefined before the game is in progress.
   */
  turnDeadlineMs?: number;
}

/** Compute turn limit based on map radius */
export function getTurnLimitForRadius(radius: number): number {
  return 20 + radius * 2;
}

const DEFAULT_CONFIG: Required<GameConfig> = {
  turnLimit: 30,
  turnTimerSeconds: 30,
  teamSize: 4,
};

// ---------------------------------------------------------------------------
// Helper: compute wall/valid tile sets from map data
// ---------------------------------------------------------------------------

function computeTileSets(mapTiles: [string, string][]): {
  wallSet: Set<string>;
  walkableTiles: Set<string>;
  allHexes: Set<string>;
} {
  const wallSet = new Set<string>();
  const walkableTiles = new Set<string>();
  const allHexes = new Set<string>();
  for (const [key, type] of mapTiles) {
    allHexes.add(key);
    if (type === 'wall') wallSet.add(key);
    else walkableTiles.add(key);
  }
  return { wallSet, walkableTiles, allHexes };
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Create the initial game state from a map and player assignments.
 */
export function createGameState(
  map: GameMap,
  players: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[],
  config?: GameConfig,
): CtlGameState {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...config };

  // Place units at spawn positions
  const spawnIndexA = { current: 0 };
  const spawnIndexB = { current: 0 };
  const allSpawnsA = map.bases.A.flatMap((b) => b.spawns);
  const allSpawnsB = map.bases.B.flatMap((b) => b.spawns);

  // @ts-expect-error TS2322: Type '{ id: string; team: "A" | "B"; unitClass: UnitClass; position: { q?: numbe — TODO(2.3-followup)
  const units: GameUnit[] = players.map((p) => {
    const spawns = p.team === 'A' ? allSpawnsA : allSpawnsB;
    const spawnIdx = p.team === 'A' ? spawnIndexA : spawnIndexB;
    const position = spawns[spawnIdx.current % spawns.length];
    spawnIdx.current++;

    return {
      id: p.id,
      team: p.team,
      unitClass: p.unitClass,
      position: { ...position },
      alive: true,
      carryingFlag: false,
    };
  });

  const flags = {
    A: map.bases.A.map((base) => ({
      team: 'A' as const,
      position: { ...base.flag },
      carried: false,
    })),
    B: map.bases.B.map((base) => ({
      team: 'B' as const,
      position: { ...base.flag },
      carried: false,
    })),
  };

  return {
    turn: 0,
    phase: 'pre_game',
    units,
    flags,
    score: { A: 0, B: 0 },
    winner: null,
    config: resolvedConfig,
    mapTiles: [...map.tiles.entries()] as [string, string][],
    mapRadius: map.radius,
    mapBases: map.bases,
    moveSubmissions: [],
    allKills: [],
  };
}

/**
 * Validate a move for a player. Returns { success, error? }.
 */
export function validateMoveForPlayer(
  state: CtlGameState,
  playerId: string,
  path: Direction[],
): { valid: boolean; error?: string } {
  if (state.phase !== 'in_progress') {
    return { valid: false, error: 'Game is not in progress' };
  }

  const unit = state.units.find((u) => u.id === playerId);
  if (!unit) return { valid: false, error: `Unknown agent: ${playerId}` };
  if (!unit.alive) return { valid: false, error: 'Dead units cannot move' };

  const moveUnit: MoveUnit = {
    id: unit.id,
    team: unit.team,
    unitClass: unit.unitClass,
    position: unit.position,
  };
  const validation = validatePath(moveUnit, path);
  // @ts-expect-error TS2375: Type '{ valid: false; error: string | undefined; }' is not assignable to type '{ — TODO(2.3-followup)
  if (!validation.valid) return { valid: false, error: validation.error };

  return { valid: true };
}

/**
 * Submit a move — returns a new state with the move recorded.
 */
export function submitMove(
  state: CtlGameState,
  playerId: string,
  path: Direction[],
): { state: CtlGameState; success: boolean; error?: string } {
  const validation = validateMoveForPlayer(state, playerId, path);
  if (!validation.valid) {
    // @ts-expect-error TS2375: Type '{ state: CtlGameState; success: false; error: string | undefined; }' is no — TODO(2.3-followup)
    return { state, success: false, error: validation.error };
  }

  // Add move to submissions (replace if already submitted)
  const submissions = new Map(state.moveSubmissions);
  submissions.set(playerId, path);

  return {
    state: { ...state, moveSubmissions: [...submissions.entries()] },
    success: true,
  };
}

/**
 * Check if all alive units have submitted moves.
 */
export function allMovesSubmitted(state: CtlGameState): boolean {
  const submissions = new Map(state.moveSubmissions);
  const aliveUnits = state.units.filter((u) => u.alive);
  return aliveUnits.every((u) => submissions.has(u.id));
}

/**
 * THE CORE LOOP — resolve a turn. Pure function: state in, state + record out.
 */
export function resolveTurn(state: CtlGameState): { state: CtlGameState; record: TurnRecord } {
  const currentTurn = state.turn;
  const { wallSet, walkableTiles } = computeTileSets(state.mapTiles);
  const submissions = new Map(state.moveSubmissions);

  // Deep-copy mutable parts
  const units: GameUnit[] = state.units.map((u) => ({ ...u, position: { ...u.position } }));
  const flags = {
    A: state.flags.A.map((f) => ({ ...f, position: { ...f.position } })),
    B: state.flags.B.map((f) => ({ ...f, position: { ...f.position } })),
  };
  const score = { ...state.score };
  let phase: GamePhase = state.phase;
  let winner: 'A' | 'B' | null = state.winner;

  // 0. Respawn units whose respawnTurn has arrived
  for (const unit of units) {
    if (!unit.alive && unit.respawnTurn === currentTurn) {
      unit.alive = true;
      // @ts-expect-error TS2412: Type 'undefined' is not assignable to type 'number' with 'exactOptionalPropertyT — TODO(2.3-followup)
      unit.respawnTurn = undefined;
    }
  }

  // 1. Record pre-move positions
  const unitPositionsBefore = new Map<string, Hex>();
  for (const unit of units) {
    unitPositionsBefore.set(unit.id, { ...unit.position });
  }

  // 2. Build move data
  const moveUnits: MoveUnit[] = [];
  const moveSubmissions: MoveSubmission[] = [];

  for (const unit of units) {
    if (!unit.alive) continue;
    moveUnits.push({
      id: unit.id,
      team: unit.team,
      unitClass: unit.unitClass,
      position: { ...unit.position },
    });
    const path = submissions.get(unit.id) ?? [];
    moveSubmissions.push({ unitId: unit.id, path });
  }

  const moves = new Map<string, Direction[]>();
  for (const [id, path] of submissions) {
    moves.set(id, [...path]);
  }

  // 3. Resolve movements
  const moveResults = resolveMovements(moveUnits, moveSubmissions, walkableTiles);

  // 4. Update unit positions
  for (const result of moveResults) {
    const unit = mustFind(units, (u) => u.id === result.unitId, 'moveResult.unitId');
    unit.position = { ...result.to };

    if (unit.carryingFlag) {
      const enemyTeam: 'A' | 'B' = unit.team === 'A' ? 'B' : 'A';
      const carriedFlag = flags[enemyTeam].find((f) => f.carrierId === unit.id);
      if (carriedFlag) {
        carriedFlag.position = { ...result.to };
      }
    }
  }

  // 5. Resolve combat
  const combatUnits: CombatUnit[] = units
    .filter((u) => u.alive)
    .map((u) => ({
      id: u.id,
      team: u.team,
      unitClass: u.unitClass,
      position: { ...u.position },
    }));

  const combatResult = resolveCombat(combatUnits, wallSet);

  // 6. Process deaths — dead units sit out 1 turn, then respawn
  // Capture post-move positions for dead units (before teleport to spawn)
  const deathPositions: Record<string, { q: number; r: number }> = {};
  for (const deadId of combatResult.deaths) {
    const unit = mustFind(units, (u) => u.id === deadId, 'deadId');
    deathPositions[deadId] = { q: unit.position.q, r: unit.position.r };
  }

  const flagEvents: string[] = [];
  const mapBases = state.mapBases;
  const allSpawnsA = mapBases.A.flatMap((b: { spawns: Hex[] }) => b.spawns);
  const allSpawnsB = mapBases.B.flatMap((b: { spawns: Hex[] }) => b.spawns);
  const spawnCountA = { current: 0 };
  const spawnCountB = { current: 0 };

  for (const deadId of combatResult.deaths) {
    const unit = mustFind(units, (u) => u.id === deadId, 'deadId');
    unit.alive = false;
    // Respawn 2 turns later (skip next turn entirely)
    unit.respawnTurn = currentTurn + 2;

    // Move to spawn position immediately (so spectators see where they'll respawn)
    const spawns = unit.team === 'A' ? allSpawnsA : allSpawnsB;
    const counter = unit.team === 'A' ? spawnCountA : spawnCountB;
    if (spawns && spawns.length > 0) {
      // @ts-expect-error TS2322: Type '{ q?: number; r?: number; }' is not assignable to type 'Hex'. — TODO(2.3-followup)
      unit.position = { ...spawns[counter.current % spawns.length] };
      counter.current++;
    }
    // If no spawns available, position remains unchanged (unit stays in place)

    if (unit.carryingFlag) {
      unit.carryingFlag = false;
      const enemyTeam: 'A' | 'B' = unit.team === 'A' ? 'B' : 'A';
      const droppedFlag = flags[enemyTeam].find((f) => f.carrierId === unit.id);
      if (droppedFlag) {
        droppedFlag.carried = false;
        // @ts-expect-error TS2412: Type 'undefined' is not assignable to type 'string' with 'exactOptionalPropertyT — TODO(2.3-followup)
        droppedFlag.carrierId = undefined;
        const baseIdx = flags[enemyTeam].indexOf(droppedFlag);
        // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
        droppedFlag.position = { ...mapBases[enemyTeam][baseIdx].flag };
        flagEvents.push(`${unit.id} died carrying ${enemyTeam}'s flag — flag returned to base`);
      }
    }
  }

  // 7. Check flag pickups
  for (const unit of units) {
    if (!unit.alive || unit.carryingFlag) continue;

    const enemyTeam: 'A' | 'B' = unit.team === 'A' ? 'B' : 'A';
    for (const enemyFlag of flags[enemyTeam]) {
      if (!enemyFlag.carried && hexEquals(unit.position, enemyFlag.position)) {
        enemyFlag.carried = true;
        enemyFlag.carrierId = unit.id;
        unit.carryingFlag = true;
        flagEvents.push(`${unit.id} picked up ${enemyTeam}'s flag`);
        break;
      }
    }
  }

  // 8. Check win condition
  let scored = false;
  for (const unit of units) {
    if (!unit.alive || !unit.carryingFlag) continue;

    const homeBases = mapBases[unit.team];
    const atHome = homeBases.some((base: { flag: Hex }) => hexEquals(unit.position, base.flag));
    if (atHome) {
      score[unit.team]++;
      flagEvents.push(`${unit.id} captured the flag! Team ${unit.team} scores!`);

      const enemyTeam: 'A' | 'B' = unit.team === 'A' ? 'B' : 'A';
      const capturedFlag = flags[enemyTeam].find((f) => f.carrierId === unit.id);
      if (capturedFlag) {
        const baseIdx = flags[enemyTeam].indexOf(capturedFlag);
        capturedFlag.carried = false;
        // @ts-expect-error TS2412: Type 'undefined' is not assignable to type 'string' with 'exactOptionalPropertyT — TODO(2.3-followup)
        capturedFlag.carrierId = undefined;
        // @ts-expect-error TS2532: Object is possibly 'undefined'. — TODO(2.3-followup)
        capturedFlag.position = { ...mapBases[enemyTeam][baseIdx].flag };
      }
      unit.carryingFlag = false;

      phase = 'finished';
      winner = unit.team;
      scored = true;
      break;
    }
  }

  // Record post-move positions
  const unitPositionsAfter = new Map<string, Hex>();
  for (const unit of units) {
    unitPositionsAfter.set(unit.id, { ...unit.position });
  }

  const record: TurnRecord = {
    turn: currentTurn,
    moves,
    unitPositionsBefore,
    unitPositionsAfter,
    kills: combatResult.kills,
    flagEvents,
  };

  const newTurn = currentTurn + 1;

  // Check turn limit (draw)
  if (!scored && newTurn > state.config.turnLimit) {
    phase = 'finished';
    winner = null;
  }

  // @ts-expect-error TS2375: Type '{ turn: number; phase: GamePhase; units: GameUnit[]; flags: { A: { positio — TODO(2.3-followup)
  const newState: CtlGameState = {
    turn: newTurn,
    phase,
    units,
    flags,
    score,
    winner,
    config: state.config,
    mapTiles: state.mapTiles,
    mapRadius: state.mapRadius,
    mapBases: state.mapBases,
    moveSubmissions: [], // cleared after resolution
    allKills: [...state.allKills, ...combatResult.kills.map((k) => ({ ...k, turn: currentTurn }))],
    lastDeathPositions: Object.keys(deathPositions).length > 0 ? deathPositions : undefined,
  };

  return { state: newState, record };
}

/**
 * Build the fog-of-war filtered state for a specific agent.
 */
export function getStateForAgent(
  state: CtlGameState,
  agentId: string,
  /** Moves already submitted this turn (may be tracked externally) */
  submittedMoves?: Set<string>,
): GameState {
  const unit = state.units.find((u) => u.id === agentId);
  if (!unit) throw new Error(`Unknown agent: ${agentId}`);

  const team = unit.team;
  const enemyTeam: 'A' | 'B' = team === 'A' ? 'B' : 'A';
  const { wallSet, allHexes } = computeTileSets(state.mapTiles);

  const fogUnits: FogUnit[] = state.units.map((u) => ({
    id: u.id,
    team: u.team,
    unitClass: u.unitClass,
    position: u.position,
    alive: u.alive,
  }));

  const {
    occupants: visibleOccupants,
    visibleKeys,
    walls: visibleWalls,
  } = buildVisibleOccupants(
    mustFind(fogUnits, (u) => u.id === agentId),
    fogUnits,
    wallSet,
    allHexes,
    state.flags,
  );

  const mapStatic: AgentMapStatic = {
    radius: state.mapRadius,
    bases: state.mapBases,
  };

  let yourFlagStatus: YourFlagStatus = 'at_base';
  for (const f of state.flags[team]) {
    if (f.carried) {
      yourFlagStatus = 'carried';
      break;
    }
  }

  let enemyFlagStatus: EnemyFlagStatus = 'unknown';
  for (const ef of state.flags[enemyTeam]) {
    if (ef.carried && ef.carrierId === agentId) {
      enemyFlagStatus = 'carried_by_you';
      break;
    } else if (ef.carried && ef.carrierId) {
      const carrier = state.units.find((u) => u.id === ef.carrierId);
      if (carrier?.team === team) enemyFlagStatus = 'carried_by_ally';
    } else if (!ef.carried && enemyFlagStatus === 'unknown') {
      if (visibleKeys.has(hexToString(ef.position))) enemyFlagStatus = 'at_base';
    }
  }

  const moveSubmitted = submittedMoves
    ? submittedMoves.has(agentId)
    : state.moveSubmissions.some(([id]) => id === agentId);

  const score = { yourTeam: state.score[team], enemyTeam: state.score[enemyTeam] };

  const enemies: AgentSummary['enemies'] = [];
  const flags: AgentSummary['flags'] = [];
  for (const o of visibleOccupants) {
    if (o.unit && o.unit.team !== team) {
      enemies.push({ q: o.q, r: o.r, unitClass: o.unit.unitClass });
    }
    if (o.flag) flags.push({ q: o.q, r: o.r, team: o.flag.team });
  }

  const summary: AgentSummary = {
    turn: state.turn,
    phase: state.phase,
    pos: { ...unit.position },
    carrying: unit.carryingFlag,
    alive: unit.alive,
    moveSubmitted,
    score,
    yourFlag: yourFlagStatus,
    enemyFlag: enemyFlagStatus,
    enemies,
    flags,
  };

  return {
    summary,
    turn: state.turn,
    phase: state.phase,
    // @ts-expect-error TS2375: Type '{ id: string; unitClass: UnitClass; position: { q: number; r: number; }; c — TODO(2.3-followup)
    yourUnit: {
      id: unit.id,
      unitClass: unit.unitClass,
      position: { ...unit.position },
      carryingFlag: unit.carryingFlag,
      alive: unit.alive,
      respawnTurn: unit.respawnTurn,
      visionRange: CLASS_VISION[unit.unitClass],
      attackRange: CLASS_RANGE[unit.unitClass],
    },
    mapStatic,
    visibleWalls,
    visibleOccupants,
    yourFlag: { status: yourFlagStatus },
    enemyFlag: { status: enemyFlagStatus },
    timeRemainingSeconds:
      state.turnDeadlineMs === undefined
        ? 0
        : Math.max(0, Math.floor((state.turnDeadlineMs - Date.now()) / 1000)),
    moveSubmitted,
    score,
  };
}

/**
 * Is the game over?
 */
export function isGameOver(state: CtlGameState): boolean {
  return state.phase === 'finished';
}
