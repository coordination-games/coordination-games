/**
 * Capture the Lobster — Stateless Game Engine
 *
 * All game logic is expressed as pure functions: state in, state out.
 * No mutable classes, no caching. The framework (GameRoom) holds the state
 * and passes it to these functions each turn.
 */

import { Hex, Direction, hexEquals, hexToString } from './hex.js';
import { UnitClass, CLASS_SPEED, MoveUnit, MoveSubmission, validatePath, resolveMovements } from './movement.js';
import { GameMap, TileType, getMapRadiusForTeamSize } from './map.js';
import { VisibleTile, FogUnit, buildVisibleState } from './fog.js';
import { CombatUnit, resolveCombat } from './combat.js';

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

export interface GameState {
  turn: number;
  phase: GamePhase;
  yourUnit: {
    id: string;
    unitClass: UnitClass;
    position: Hex;
    carryingFlag: boolean;
    alive: boolean;
  };
  visibleTiles: VisibleTile[];
  yourFlag: { status: 'at_base' | 'carried' | 'unknown' };
  enemyFlag: { status: 'at_base' | 'carried_by_you' | 'carried_by_ally' | 'unknown' };
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
}

/** Compute turn limit based on map radius */
export function getTurnLimitForRadius(radius: number): number {
  return 20 + (radius * 2);
}

const DEFAULT_CONFIG: Required<GameConfig> = {
  turnLimit: 30,
  turnTimerSeconds: 30,
  teamSize: 4,
};

// ---------------------------------------------------------------------------
// Helper: compute wall/valid tile sets from map data
// ---------------------------------------------------------------------------

function computeTileSets(mapTiles: [string, string][]): { wallSet: Set<string>; validTiles: Set<string> } {
  const wallSet = new Set<string>();
  const validTiles = new Set<string>();
  for (const [key, type] of mapTiles) {
    if (type === 'wall') {
      wallSet.add(key);
    } else {
      validTiles.add(key);
    }
  }
  return { wallSet, validTiles };
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
  const allSpawnsA = map.bases.A.flatMap(b => b.spawns);
  const allSpawnsB = map.bases.B.flatMap(b => b.spawns);

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
    phase: 'in_progress',
    units,
    flags,
    score: { A: 0, B: 0 },
    winner: null,
    config: resolvedConfig,
    mapTiles: [...map.tiles.entries()] as [string, string][],
    mapRadius: map.radius,
    mapBases: map.bases as any,
    moveSubmissions: [],
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
  const { wallSet, validTiles } = computeTileSets(state.mapTiles);
  const submissions = new Map(state.moveSubmissions);

  // Deep-copy mutable parts
  const units: GameUnit[] = state.units.map(u => ({ ...u, position: { ...u.position } }));
  const flags = {
    A: state.flags.A.map(f => ({ ...f, position: { ...f.position } })),
    B: state.flags.B.map(f => ({ ...f, position: { ...f.position } })),
  };
  let score = { ...state.score };
  let phase: GamePhase = state.phase;
  let winner: 'A' | 'B' | null = state.winner;

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
  const moveResults = resolveMovements(moveUnits, moveSubmissions, validTiles);

  // 4. Update unit positions
  for (const result of moveResults) {
    const unit = units.find((u) => u.id === result.unitId)!;
    unit.position = { ...result.to };

    if (unit.carryingFlag) {
      const enemyTeam: 'A' | 'B' = unit.team === 'A' ? 'B' : 'A';
      const carriedFlag = flags[enemyTeam].find(f => f.carrierId === unit.id);
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

  // 6. Process deaths
  const flagEvents: string[] = [];
  const mapBases = state.mapBases;

  for (const deadId of combatResult.deaths) {
    const unit = units.find((u) => u.id === deadId)!;
    unit.alive = false;

    if (unit.carryingFlag) {
      unit.carryingFlag = false;
      const enemyTeam: 'A' | 'B' = unit.team === 'A' ? 'B' : 'A';
      const droppedFlag = flags[enemyTeam].find(f => f.carrierId === unit.id);
      if (droppedFlag) {
        droppedFlag.carried = false;
        droppedFlag.carrierId = undefined;
        const baseIdx = flags[enemyTeam].indexOf(droppedFlag);
        droppedFlag.position = { ...mapBases[enemyTeam][baseIdx].flag };
        flagEvents.push(
          `${unit.id} died carrying ${enemyTeam}'s flag — flag returned to base`,
        );
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
      const capturedFlag = flags[enemyTeam].find(f => f.carrierId === unit.id);
      if (capturedFlag) {
        const baseIdx = flags[enemyTeam].indexOf(capturedFlag);
        capturedFlag.carried = false;
        capturedFlag.carrierId = undefined;
        capturedFlag.position = { ...mapBases[enemyTeam][baseIdx].flag };
      }
      unit.carryingFlag = false;

      phase = 'finished';
      winner = unit.team;
      scored = true;
      break;
    }
  }

  // 9. Respawn dead units
  const spawnCountA = { current: 0 };
  const spawnCountB = { current: 0 };
  const allSpawnsA = mapBases.A.flatMap((b: { spawns: Hex[] }) => b.spawns);
  const allSpawnsB = mapBases.B.flatMap((b: { spawns: Hex[] }) => b.spawns);

  for (const unit of units) {
    if (unit.alive) continue;
    const spawns = unit.team === 'A' ? allSpawnsA : allSpawnsB;
    const counter = unit.team === 'A' ? spawnCountA : spawnCountB;
    unit.position = { ...spawns[counter.current % spawns.length] };
    counter.current++;
    unit.alive = true;
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
  const { wallSet } = computeTileSets(state.mapTiles);
  const tiles = new Map(state.mapTiles.map(([k, v]) => [k, v]));

  // Fog of war
  const fogUnits: FogUnit[] = state.units.map((u) => ({
    id: u.id,
    team: u.team,
    unitClass: u.unitClass,
    position: u.position,
    alive: u.alive,
  }));

  const viewer: FogUnit = {
    id: unit.id,
    team: unit.team,
    unitClass: unit.unitClass,
    position: unit.position,
    alive: unit.alive,
  };

  const flagsForFog = {
    A: state.flags.A.map(f => ({
      position: f.position,
      carried: f.carried,
      carrierId: f.carrierId,
    })),
    B: state.flags.B.map(f => ({
      position: f.position,
      carried: f.carried,
      carrierId: f.carrierId,
    })),
  };

  const visibleTiles = buildVisibleState(viewer, fogUnits, wallSet, tiles, flagsForFog);

  // Your flag status
  const yourFlags = state.flags[team];
  let yourFlagStatus: 'at_base' | 'carried' | 'unknown' = 'at_base';
  for (const f of yourFlags) {
    if (f.carried) { yourFlagStatus = 'carried'; break; }
  }

  // Enemy flag status
  const enemyFlags = state.flags[enemyTeam];
  let enemyFlagStatus: 'at_base' | 'carried_by_you' | 'carried_by_ally' | 'unknown' = 'unknown';
  for (const ef of enemyFlags) {
    if (ef.carried && ef.carrierId === agentId) {
      enemyFlagStatus = 'carried_by_you';
      break;
    } else if (ef.carried && ef.carrierId) {
      const carrier = state.units.find((u) => u.id === ef.carrierId);
      if (carrier && carrier.team === team) {
        enemyFlagStatus = 'carried_by_ally';
      }
    } else if (!ef.carried) {
      const enemyFlagKey = hexToString(ef.position);
      const isVisible = visibleTiles.some(
        (t) => hexToString({ q: t.q, r: t.r }) === enemyFlagKey,
      );
      if (isVisible && enemyFlagStatus === 'unknown') {
        enemyFlagStatus = 'at_base';
      }
    }
  }

  // Check if this agent has submitted a move
  const moveSubmitted = submittedMoves
    ? submittedMoves.has(agentId)
    : new Map(state.moveSubmissions).has(agentId);

  return {
    turn: state.turn,
    phase: state.phase,
    yourUnit: {
      id: unit.id,
      unitClass: unit.unitClass,
      position: { ...unit.position },
      carryingFlag: unit.carryingFlag,
      alive: unit.alive,
    },
    visibleTiles,
    yourFlag: { status: yourFlagStatus },
    enemyFlag: { status: enemyFlagStatus },
    timeRemainingSeconds: state.config.turnTimerSeconds,
    moveSubmitted,
    score: {
      yourTeam: state.score[team],
      enemyTeam: state.score[enemyTeam],
    },
  };
}

/**
 * Is the game over?
 */
export function isGameOver(state: CtlGameState): boolean {
  return state.phase === 'finished';
}
