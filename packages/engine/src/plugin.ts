/**
 * Capture the Lobster — CoordinationGame plugin implementation.
 *
 * Wraps the existing game engine (hex, combat, fog, movement, map, game.ts)
 * to implement the shared CoordinationGame interface from @lobster/coordination.
 *
 * This allows CtL to be registered as a game plugin in the coordination
 * framework while keeping all existing game logic untouched.
 */

import type {
  CoordinationGame,
  EIP712TypeDef,
} from '@lobster/coordination';

import { GameManager, GameConfig, GameUnit, FlagState, TurnRecord } from './game.js';
import { generateMap, GameMap, MapConfig } from './map.js';
import { Direction, Hex, hexToString } from './hex.js';
import { UnitClass } from './movement.js';

// ---------------------------------------------------------------------------
// CtL-specific types
// ---------------------------------------------------------------------------

/** Configuration for creating a new CtL game. */
export interface CtlConfig {
  /** Map generation seed (for deterministic maps) */
  mapSeed: string;
  /** Map radius */
  mapRadius?: number;
  /** Wall density (0-1) */
  wallDensity?: number;
  /** Team size (players per team) */
  teamSize: number;
  /** Turn limit before draw */
  turnLimit?: number;
  /** Turn timer in seconds */
  turnTimerSeconds?: number;
  /** Player assignments: id -> { team, unitClass } */
  players: CtlPlayerConfig[];
}

export interface CtlPlayerConfig {
  id: string;
  team: 'A' | 'B';
  unitClass: UnitClass;
}

/**
 * CtL game state — a serializable snapshot of the full game state.
 * Wraps the GameManager's internal state into a plain object
 * that can be hashed, compared, and stored.
 */
export interface CtlState {
  turn: number;
  phase: 'pre_game' | 'in_progress' | 'finished';
  units: {
    id: string;
    team: 'A' | 'B';
    unitClass: UnitClass;
    position: Hex;
    alive: boolean;
    carryingFlag: boolean;
  }[];
  flags: {
    A: { position: Hex; carried: boolean; carrierId?: string };
    B: { position: Hex; carried: boolean; carrierId?: string };
  };
  score: { A: number; B: number };
  winner: 'A' | 'B' | null;
  /** Serialized map data for state reconstruction */
  mapTiles: [string, string][];
  mapRadius: number;
  mapBases: {
    A: { flag: Hex; spawns: Hex[] };
    B: { flag: Hex; spawns: Hex[] };
  };
  config: { turnLimit: number; turnTimerSeconds: number; teamSize: number };
  /** Move submissions for the current turn */
  moveSubmissions: [string, Direction[]][];
  /** Team messages */
  teamMessages: {
    A: { from: string; message: string; turn: number }[];
    B: { from: string; message: string; turn: number }[];
  };
}

/** A single player's move in CtL. */
export interface CtlMove {
  /** Direction path for the player's unit */
  path: Direction[];
  /** Optional chat message to teammates */
  chatMessage?: string;
}

/** CtL game outcome. */
export interface CtlOutcome {
  winner: 'A' | 'B' | null;  // null = draw
  score: { A: number; B: number };
  turnCount: number;
  /** Per-player stats */
  playerStats: Map<string, {
    team: 'A' | 'B';
    kills: number;
    deaths: number;
    flagCarries: number;
    flagCaptures: number;
  }>;
}

// ---------------------------------------------------------------------------
// Internal: GameManager wrapper
// ---------------------------------------------------------------------------

/**
 * We keep a mapping of CtlState -> live GameManager instances so the plugin
 * can work with the existing engine. The framework passes state objects around,
 * but internally we reconstruct GameManagers as needed.
 */
const managerCache = new WeakMap<CtlState, GameManager>();

function getOrCreateManager(state: CtlState): GameManager {
  const cached = managerCache.get(state);
  if (cached) return cached;

  // Reconstruct map
  const map: GameMap = {
    tiles: new Map(state.mapTiles.map(([k, v]) => [k, v as any])),
    radius: state.mapRadius,
    bases: state.mapBases,
  };

  // Reconstruct players for the constructor
  const players = state.units.map((u) => ({
    id: u.id,
    team: u.team,
    unitClass: u.unitClass,
  }));

  const gm = new GameManager('_reconstructed', map, players, state.config);

  // Override the constructed state with the actual state
  gm.turn = state.turn;
  gm.phase = state.phase;
  gm.winner = state.winner;
  gm.score = { ...state.score };

  for (const unit of state.units) {
    const gmUnit = gm.units.find((u) => u.id === unit.id);
    if (gmUnit) {
      gmUnit.position = { ...unit.position };
      gmUnit.alive = unit.alive;
      gmUnit.carryingFlag = unit.carryingFlag;
    }
  }

  gm.flags.A = {
    team: 'A',
    position: { ...state.flags.A.position },
    carried: state.flags.A.carried,
    carrierId: state.flags.A.carrierId,
  };
  gm.flags.B = {
    team: 'B',
    position: { ...state.flags.B.position },
    carried: state.flags.B.carried,
    carrierId: state.flags.B.carrierId,
  };

  // Restore move submissions
  gm.moveSubmissions.clear();
  for (const [id, path] of state.moveSubmissions) {
    gm.moveSubmissions.set(id, path);
  }

  // Restore team messages
  gm.teamMessages.A = state.teamMessages.A.map((m) => ({ ...m }));
  gm.teamMessages.B = state.teamMessages.B.map((m) => ({ ...m }));

  managerCache.set(state, gm);
  return gm;
}

function snapshotState(gm: GameManager, map: GameMap): CtlState {
  const state: CtlState = {
    turn: gm.turn,
    phase: gm.phase,
    units: gm.units.map((u) => ({
      id: u.id,
      team: u.team,
      unitClass: u.unitClass,
      position: { ...u.position },
      alive: u.alive,
      carryingFlag: u.carryingFlag,
    })),
    flags: {
      A: {
        position: { ...gm.flags.A.position },
        carried: gm.flags.A.carried,
        carrierId: gm.flags.A.carrierId,
      },
      B: {
        position: { ...gm.flags.B.position },
        carried: gm.flags.B.carried,
        carrierId: gm.flags.B.carrierId,
      },
    },
    score: { ...gm.score },
    winner: gm.winner,
    mapTiles: [...map.tiles.entries()],
    mapRadius: map.radius,
    mapBases: map.bases,
    config: {
      turnLimit: gm.config.turnLimit,
      turnTimerSeconds: gm.config.turnTimerSeconds,
      teamSize: gm.config.teamSize,
    },
    moveSubmissions: [...gm.moveSubmissions.entries()],
    teamMessages: {
      A: gm.teamMessages.A.map((m) => ({ ...m })),
      B: gm.teamMessages.B.map((m) => ({ ...m })),
    },
  };
  managerCache.set(state, gm);
  return state;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * Capture the Lobster game plugin.
 *
 * Implements CoordinationGame<CtlConfig, CtlState, CtlMove, CtlOutcome>.
 */
export const CaptureTheLobsterPlugin: CoordinationGame<
  CtlConfig,
  CtlState,
  CtlMove,
  CtlOutcome
> = {
  gameType: 'capture-the-lobster',
  version: '0.1.0',

  moveSchema: {
    Move: [
      { name: 'gameId', type: 'bytes32' },
      { name: 'turnNumber', type: 'uint16' },
      { name: 'units', type: 'UnitAction[]' },
    ],
    UnitAction: [
      { name: 'unitId', type: 'string' },
      { name: 'action', type: 'string' },
      { name: 'direction', type: 'string' },
    ],
  } as EIP712TypeDef,

  createInitialState(config: CtlConfig): CtlState {
    const mapConfig: MapConfig = {
      seed: config.mapSeed,
      radius: config.mapRadius,
      wallDensity: config.wallDensity,
    };
    const map = generateMap(mapConfig);

    const gameConfig: GameConfig = {
      teamSize: config.teamSize,
      turnLimit: config.turnLimit,
      turnTimerSeconds: config.turnTimerSeconds,
    };

    const gm = new GameManager(
      `game_${config.mapSeed}`,
      map,
      config.players.map((p) => ({
        id: p.id,
        team: p.team,
        unitClass: p.unitClass,
      })),
      gameConfig,
    );

    return snapshotState(gm, map);
  },

  validateMove(state: CtlState, playerId: string, move: CtlMove): boolean {
    const gm = getOrCreateManager(state);

    // Check the player exists and is alive
    const unit = gm.units.find((u) => u.id === playerId);
    if (!unit || !unit.alive) return false;

    // Validate the path
    const result = gm.submitMove(playerId, move.path);

    // Undo the submission (we just wanted to validate)
    if (result.success) {
      gm.moveSubmissions.delete(playerId);
    }

    return result.success;
  },

  resolveTurn(state: CtlState, moves: Map<string, CtlMove>): CtlState {
    const gm = getOrCreateManager(state);

    // Reconstruct the map for snapshotting
    const map: GameMap = {
      tiles: new Map(state.mapTiles.map(([k, v]) => [k, v as any])),
      radius: state.mapRadius,
      bases: state.mapBases,
    };

    // Submit all moves
    for (const [playerId, move] of moves) {
      // Submit chat messages first
      if (move.chatMessage) {
        gm.submitChat(playerId, move.chatMessage);
      }

      // Submit the movement path
      gm.submitMove(playerId, move.path);
    }

    // Submit empty moves for players who didn't submit
    for (const unit of gm.units) {
      if (unit.alive && !gm.moveSubmissions.has(unit.id)) {
        gm.submitMove(unit.id, []);
      }
    }

    // Resolve the turn
    gm.resolveTurn();

    // Return a new state snapshot
    return snapshotState(gm, map);
  },

  isOver(state: CtlState): boolean {
    return state.phase === 'finished';
  },

  getOutcome(state: CtlState): CtlOutcome {
    // Build basic per-player stats (kills, deaths could be derived from turn history)
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

  entryCost: 10, // 10 credits per player

  computePayouts(outcome: CtlOutcome, playerIds: string[]): Map<string, number> {
    const payouts = new Map<string, number>();

    if (!outcome.winner) {
      // Draw — everyone gets their entry back (zero delta)
      for (const id of playerIds) {
        payouts.set(id, 0);
      }
      return payouts;
    }

    // Winner team gets +entryCost, loser team gets -entryCost
    // This is zero-sum across all players
    const entryCost = 10;
    for (const id of playerIds) {
      const stats = outcome.playerStats.get(id);
      if (!stats) {
        payouts.set(id, 0);
        continue;
      }
      if (stats.team === outcome.winner) {
        payouts.set(id, entryCost);
      } else {
        payouts.set(id, -entryCost);
      }
    }

    return payouts;
  },
};

// ---------------------------------------------------------------------------
// Helper: create a GameManager from a CtlState (for the existing server)
// ---------------------------------------------------------------------------

/**
 * Get or reconstruct a GameManager from a CtlState.
 * Useful for the existing server to bridge between the framework
 * and the game-specific API surface.
 */
export function getGameManager(state: CtlState): GameManager {
  return getOrCreateManager(state);
}
