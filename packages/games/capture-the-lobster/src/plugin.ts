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
} from '@coordination-games/engine';

import {
  CtlGameState,
  createGameState,
  validateMoveForPlayer,
  submitMove as gameSubmitMove,
  resolveTurn,
  isGameOver,
  allMovesSubmitted,
  getStateForAgent,
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
