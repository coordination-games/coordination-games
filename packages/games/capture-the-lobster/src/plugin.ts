/**
 * Capture the Lobster — CoordinationGame plugin (v2 action-based).
 *
 * Implements the CoordinationGame interface using the pure game functions
 * from game.ts. State in, state out.
 */

import type {
  CoordinationGame,
  ActionResult,
  GameLobbyConfig,
  SpectatorContext,
} from '@coordination-games/engine';
import { registerGame } from '@coordination-games/engine';

import {
  CtlGameState,
  GameUnit,
  FlagState,
  GamePhase,
  createGameState,
  validateMoveForPlayer,
  submitMove as gameSubmitMove,
  resolveTurn,
  isGameOver,
  allMovesSubmitted,
  getStateForAgent,
} from './game.js';
import { generateMap, MapConfig, TileType } from './map.js';
import { Hex, Direction } from './hex.js';
import { UnitClass } from './movement.js';
import { getUnitVision } from './fog.js';

// ---------------------------------------------------------------------------
// CtL-specific types
// ---------------------------------------------------------------------------

/** Configuration for creating a new CtL game. */
export interface CtlConfig {
  mapSeed: string;
  mapRadius?: number;
  wallDensity?: number;
  teamSize: number;
  turnLimit?: number;
  turnTimerSeconds?: number;
  players: CtlPlayerConfig[];
}

export interface CtlPlayerConfig {
  id: string;
  team: 'A' | 'B';
  unitClass: UnitClass;
}

/** A single player's move in CtL (internal type, used by game.ts). */
export interface CtlMove {
  path: Direction[];
}

/** CtL game outcome. */
export interface CtlOutcome {
  winner: 'A' | 'B' | null;
  score: { A: number; B: number };
  turnCount: number;
  playerStats: Map<string, {
    team: 'A' | 'B';
    kills: number;
    deaths: number;
    flagCarries: number;
    flagCaptures: number;
  }>;
}

// ---------------------------------------------------------------------------
// v2 action type
// ---------------------------------------------------------------------------

/** Actions that can be applied to CtL game state. */
export type CtlAction =
  | { type: 'game_start' }
  | { type: 'move'; agentId: string; path: Direction[] }
  | { type: 'turn_timeout' };

// ---------------------------------------------------------------------------
// Spectator view types (consumed by the frontend)
// ---------------------------------------------------------------------------

export interface SpectatorTile {
  q: number;
  r: number;
  type: TileType;
  unit?: {
    id: string;
    team: 'A' | 'B';
    unitClass: UnitClass;
    carryingFlag?: boolean;
    alive: boolean;
    respawnTurn?: number;
  };
  units?: {
    id: string;
    team: 'A' | 'B';
    unitClass: UnitClass;
    carryingFlag?: boolean;
    alive: boolean;
    respawnTurn?: number;
  }[];
  flag?: { team: 'A' | 'B' };
}

export interface SpectatorState {
  turn: number;
  maxTurns: number;
  phase: GamePhase;
  tiles: SpectatorTile[];
  units: {
    id: string;
    team: 'A' | 'B';
    unitClass: UnitClass;
    position: Hex;
    alive: boolean;
    carryingFlag: boolean;
    respawnTurn?: number;
  }[];
  kills: { killerId: string; victimId: string; reason: string }[];
  chatA: { from: string; message: string; turn: number }[];
  chatB: { from: string; message: string; turn: number }[];
  flagA: { status: 'at_base' | 'carried'; carrier?: string };
  flagB: { status: 'at_base' | 'carried'; carrier?: string };
  score: { A: number; B: number };
  winner: 'A' | 'B' | null;
  mapRadius: number;
  visibleA: string[];
  visibleB: string[];
  visibleByUnit: Record<string, string[]>;
  turnTimeoutMs: number;
  turnStartedAt: number;
  handles: Record<string, string>;
  relayMessages?: any[];
}

// ---------------------------------------------------------------------------
// Build spectator view from raw game state
// ---------------------------------------------------------------------------

function buildCtlSpectatorView(
  state: CtlGameState,
  prevState: CtlGameState | null,
  context: SpectatorContext,
): SpectatorState {
  const map = { tiles: new Map<string, string>(state.mapTiles), radius: state.mapRadius, bases: state.mapBases };
  const { units, flags, turn, phase, config, score } = state;

  // Build full tile array (no fog -- spectators see everything)
  const tiles: SpectatorTile[] = [];
  const unitsByHex = new Map<string, GameUnit[]>();
  for (const u of units) {
    const key = `${u.position.q},${u.position.r}`;
    const list = unitsByHex.get(key) ?? [];
    list.push(u);
    unitsByHex.set(key, list);
  }

  const flagsByHex = new Map<string, 'A' | 'B'>();
  for (const team of ['A', 'B'] as const) {
    const teamFlags = flags[team];
    for (const f of teamFlags) {
      flagsByHex.set(`${f.position.q},${f.position.r}`, team);
    }
  }

  for (const [key, tileType] of map.tiles) {
    const [qStr, rStr] = key.split(',');
    const q = Number(qStr);
    const r = Number(rStr);
    const tile: SpectatorTile = { q, r, type: tileType as TileType };

    const unitsHere = unitsByHex.get(key);
    if (unitsHere && unitsHere.length > 0) {
      const primary = unitsHere[0];
      tile.unit = {
        id: primary.id,
        team: primary.team,
        unitClass: primary.unitClass,
        carryingFlag: primary.carryingFlag || undefined,
        alive: primary.alive,
        respawnTurn: primary.respawnTurn,
      };
      if (unitsHere.length > 1) {
        tile.units = unitsHere.map((u) => ({
          id: u.id,
          team: u.team,
          unitClass: u.unitClass,
          carryingFlag: u.carryingFlag || undefined,
          alive: u.alive,
          respawnTurn: u.respawnTurn,
        }));
      }
    }

    const flagTeam = flagsByHex.get(key);
    if (flagTeam !== undefined) {
      tile.flag = { team: flagTeam };
    }

    tiles.push(tile);
  }

  // Kills -- inferred by comparing alive status with previous state
  const kills: { killerId: string; victimId: string; reason: string }[] = [];
  if (prevState) {
    for (const unit of units) {
      const prevUnit = prevState.units.find((u: GameUnit) => u.id === unit.id);
      if (prevUnit && prevUnit.alive && !unit.alive) {
        kills.push({ killerId: 'unknown', victimId: unit.id, reason: 'combat' });
      }
    }
  }

  // Build flag status summaries
  function flagStatus(flagArr: FlagState[]): { status: 'at_base' | 'carried'; carrier?: string } {
    for (const f of flagArr) {
      if (f.carried && f.carrierId) {
        return { status: 'carried', carrier: f.carrierId };
      }
    }
    return { status: 'at_base' };
  }

  // Compute per-team fog of war
  const walls = new Set<string>();
  const allHexKeys = new Set<string>();
  for (const [key, tileType] of map.tiles) {
    allHexKeys.add(key);
    if (tileType === 'wall') walls.add(key);
  }

  const visibleA = new Set<string>();
  const visibleB = new Set<string>();
  const visibleByUnit: Record<string, string[]> = {};
  for (const u of units) {
    if (!u.alive) continue;
    const unitVision = getUnitVision(
      { id: u.id, position: u.position, unitClass: u.unitClass, team: u.team, alive: u.alive },
      walls,
      allHexKeys,
    );
    visibleByUnit[u.id] = [...unitVision];
    const targetSet = u.team === 'A' ? visibleA : visibleB;
    for (const hex of unitVision) {
      targetSet.add(hex);
    }
  }

  // Extract chat from relay messages
  const relayMessages = context.relayMessages ?? [];
  const chatA = relayMessages
    .filter((m: any) => m.type === 'messaging' && m.scope === 'team' && units.some(u => u.id === m.sender && u.team === 'A'))
    .map((m: any) => ({ from: m.sender, message: (m.data as { body?: string })?.body ?? '', turn: m.turn }));
  const chatB = relayMessages
    .filter((m: any) => m.type === 'messaging' && m.scope === 'team' && units.some(u => u.id === m.sender && u.team === 'B'))
    .map((m: any) => ({ from: m.sender, message: (m.data as { body?: string })?.body ?? '', turn: m.turn }));

  return {
    turn,
    maxTurns: config.turnLimit,
    phase,
    tiles,
    units: units.map((u) => ({
      id: u.id,
      team: u.team,
      unitClass: u.unitClass,
      position: { ...u.position },
      alive: u.alive,
      carryingFlag: u.carryingFlag,
      respawnTurn: u.respawnTurn,
    })),
    kills,
    chatA,
    chatB,
    flagA: flagStatus(flags.A),
    flagB: flagStatus(flags.B),
    score: { A: score.A, B: score.B },
    winner: state.winner ?? null,
    mapRadius: map.radius,
    visibleA: [...visibleA],
    visibleB: [...visibleB],
    visibleByUnit,
    turnTimeoutMs: 30000,
    turnStartedAt: Date.now(),
    handles: context.handles,
  };
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export const CaptureTheLobsterPlugin: CoordinationGame<
  CtlConfig,
  CtlGameState,
  CtlAction,
  CtlOutcome
> = {
  gameType: 'capture-the-lobster',
  version: '0.2.0',

  createInitialState(config: CtlConfig): CtlGameState {
    const mapConfig: MapConfig = {
      seed: config.mapSeed,
      radius: config.mapRadius,
      wallDensity: config.wallDensity,
    };
    const map = generateMap(mapConfig);

    return createGameState(
      map,
      config.players.map((p) => ({
        id: p.id,
        team: p.team,
        unitClass: p.unitClass,
      })),
      {
        teamSize: config.teamSize,
        turnLimit: config.turnLimit,
        turnTimerSeconds: config.turnTimerSeconds,
      },
    );
  },

  validateAction(state: CtlGameState, playerId: string | null, action: CtlAction): boolean {
    if (action.type === 'game_start') {
      return playerId === null && state.phase === 'pre_game';
    }
    if (action.type === 'turn_timeout') {
      return playerId === null && state.phase === 'in_progress';
    }
    if (action.type === 'move') {
      if (playerId === null) return false;
      return validateMoveForPlayer(state, action.agentId, action.path).valid;
    }
    return false;
  },

  applyAction(state: CtlGameState, playerId: string | null, action: CtlAction): ActionResult<CtlGameState, CtlAction> {
    // game_start: set phase to in_progress, return deadline for first turn
    if (action.type === 'game_start') {
      const started: CtlGameState = { ...state, phase: 'in_progress' as const };
      return {
        state: started,
        deadline: { seconds: state.config.turnTimerSeconds ?? 30, action: { type: 'turn_timeout' } },
      };
    }

    // turn_timeout: fill empty moves for alive units, resolve turn
    if (action.type === 'turn_timeout') {
      let current = state;
      // Fill empty moves for alive units that haven't submitted
      for (const unit of current.units) {
        const submissions = new Map(current.moveSubmissions);
        if (unit.alive && !submissions.has(unit.id)) {
          const result = gameSubmitMove(current, unit.id, []);
          current = result.state;
        }
      }
      // Resolve
      const { state: resolved } = resolveTurn(current);
      if (isGameOver(resolved)) {
        return { state: resolved, deadline: null, progressIncrement: true };
      }
      return {
        state: resolved,
        deadline: { seconds: resolved.config.turnTimerSeconds ?? 30, action: { type: 'turn_timeout' } },
        progressIncrement: true,
      };
    }

    // move: submit move, check if all submitted, maybe resolve
    if (action.type === 'move' && playerId !== null) {
      const result = gameSubmitMove(state, action.agentId, action.path);
      if (!result.success) return { state }; // invalid move, no state change

      let current = result.state;

      // Check if all alive units have submitted
      if (allMovesSubmitted(current)) {
        const { state: resolved } = resolveTurn(current);
        if (isGameOver(resolved)) {
          return { state: resolved, deadline: null, progressIncrement: true };
        }
        return {
          state: resolved,
          deadline: { seconds: resolved.config.turnTimerSeconds ?? 30, action: { type: 'turn_timeout' } },
          progressIncrement: true,
        };
      }

      return { state: current }; // no deadline change — timer keeps ticking
    }

    return { state };
  },

  getVisibleState(state: CtlGameState, playerId: string | null): unknown {
    if (playerId === null) {
      // Spectator view — return full state (server handles delay)
      return state;
    }
    // Agent view — fog-filtered
    const submitted = new Set(new Map(state.moveSubmissions).keys());
    return getStateForAgent(state, playerId, submitted);
  },

  buildSpectatorView(state: CtlGameState, prevState: CtlGameState | null, context: SpectatorContext): SpectatorState {
    return buildCtlSpectatorView(state, prevState, context);
  },

  isOver(state: CtlGameState): boolean {
    return isGameOver(state);
  },

  getOutcome(state: CtlGameState): CtlOutcome {
    const playerStats = new Map<string, {
      team: 'A' | 'B';
      kills: number;
      deaths: number;
      flagCarries: number;
      flagCaptures: number;
    }>();

    for (const unit of state.units) {
      playerStats.set(unit.id, {
        team: unit.team,
        kills: 0,
        deaths: 0,
        flagCarries: 0,
        flagCaptures: 0,
      });
    }

    return {
      winner: state.winner,
      score: { ...state.score },
      turnCount: state.turn,
      playerStats,
    };
  },

  spectatorDelay: 2,

  getPlayersNeedingAction(state: CtlGameState): string[] {
    if (state.phase !== 'in_progress') return [];
    const submitted = new Set(new Map(state.moveSubmissions).keys());
    return state.units
      .filter(u => u.alive && !submitted.has(u.id))
      .map(u => u.id);
  },

  entryCost: 10,

  lobby: {
    queueType: 'open',
    phases: [
      { phaseId: 'team-formation', config: {} },
      { phaseId: 'class-selection', config: {} },
    ],
    matchmaking: {
      minPlayers: 4,
      maxPlayers: 12,
      teamSize: 2,
      numTeams: 2,
      queueTimeoutMs: 120000,
    },
  } as GameLobbyConfig,

  requiredPlugins: ['basic-chat'],
  recommendedPlugins: ['elo'],

  computePayouts(outcome: CtlOutcome, playerIds: string[]): Map<string, number> {
    const payouts = new Map<string, number>();

    if (!outcome.winner) {
      for (const id of playerIds) payouts.set(id, 0);
      return payouts;
    }

    const entryCost = 10;
    for (const id of playerIds) {
      const stats = outcome.playerStats.get(id);
      if (!stats) { payouts.set(id, 0); continue; }
      payouts.set(id, stats.team === outcome.winner ? entryCost : -entryCost);
    }

    return payouts;
  },
};

// Self-register with the engine's game registry
registerGame(CaptureTheLobsterPlugin);
