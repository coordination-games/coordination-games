/**
 * Capture the Lobster — CoordinationGame plugin.
 *
 * Implements the CoordinationGame interface using the pure game functions
 * from game.ts. State in, state out.
 */

import type {
  CoordinationGame,
  EIP712TypeDef,
  GameLobbyConfig,
} from '@coordination-games/engine';

import {
  CtlGameState,
  createGameState,
  validateMoveForPlayer,
  submitMove as gameSubmitMove,
  resolveTurn,
  isGameOver,
} from './game.js';
import { generateMap, MapConfig } from './map.js';
import { Direction } from './hex.js';
import { UnitClass } from './movement.js';

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

/** A single player's move in CtL. */
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
// The plugin
// ---------------------------------------------------------------------------

export const CaptureTheLobsterPlugin: CoordinationGame<
  CtlConfig,
  CtlGameState,
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

  validateMove(state: CtlGameState, playerId: string, move: CtlMove): boolean {
    return validateMoveForPlayer(state, playerId, move.path).valid;
  },

  resolveTurn(state: CtlGameState, moves: Map<string, CtlMove>): CtlGameState {
    let current = state;

    for (const [playerId, move] of moves) {
      const result = gameSubmitMove(current, playerId, move.path);
      current = result.state;
    }

    // Submit empty moves for players who didn't submit
    for (const unit of current.units) {
      if (unit.alive && !new Map(current.moveSubmissions).has(unit.id)) {
        const result = gameSubmitMove(current, unit.id, []);
        current = result.state;
      }
    }

    return resolveTurn(current).state;
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
