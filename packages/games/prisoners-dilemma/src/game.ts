/**
 * Iterated Prisoner's Dilemma — Pure game functions
 *
 * All game logic is pure: state in, state out.
 */

import type { ActionResult } from '@coordination-games/engine';
import type {
  IPDAction,
  IPDConfig,
  IPDOutcome,
  IPDPlayer0View,
  IPDPlayer1View,
  IPDRound,
  IPDSpectatorView,
  IPDState,
} from './types.js';

// ---------------------------------------------------------------------------
// Payoff matrix
// ---------------------------------------------------------------------------

/**
 * Standard PD payoff matrix.
 * Returns [p0Payoff, p1Payoff] for the given pair of actions.
 *
 * Both cooperate: +2 / +2
 * Both defect:    +1 / +1
 * One defects:    defector gets +3, cooperator gets 0
 */
function payoff(a0: IPDAction, a1: IPDAction): [number, number] {
  if (a0 === 'cooperate' && a1 === 'cooperate') return [2, 2];
  if (a0 === 'defect' && a1 === 'defect')     return [1, 1];
  if (a0 === 'cooperate' && a1 === 'defect')   return [0, 3];
  if (a0 === 'defect' && a1 === 'cooperate')   return [3, 0];
  // Safety fallback — should never reach here
  return [0, 0];
}

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

/** Create initial game state. */
export function createInitialState(config: IPDConfig): IPDState {
  if (config.players.length !== 2) {
    throw new Error(`IPD requires exactly 2 players, got ${config.players.length}`);
  }
  return {
    round: 0,
    maxRounds: config.rounds,
    history: [],
    scores: [0, 0],
    playerIds: [config.players[0].id, config.players[1].id],
    playerHandles: [config.players[0].handle, config.players[1].handle],
    finished: false,
    winner: null,
  };
}

// ---------------------------------------------------------------------------
// Action validation
// ---------------------------------------------------------------------------

/** Validate that an action is legal in the current state. */
export function validateAction(
  state: IPDState,
  playerId: string | null,
  action: IPDAction,
): boolean {
  if (state.finished) return false;
  if (action !== 'cooperate' && action !== 'defect') return false;
  // Any player can submit — the framework tracks who submitted what
  return true;
}

// ---------------------------------------------------------------------------
// Core game logic — advance the state
// ---------------------------------------------------------------------------

/**
 * Record a round result.
 * Called when both players have submitted their actions.
 * The framework ensures both actions arrive before calling applyAction for resolution.
 */
function resolveRound(state: IPDState, a0: IPDAction, a1: IPDAction): IPDState {
  const [p0Payoff, p1Payoff] = payoff(a0, a1);
  const newRound: IPDRound = {
    round: state.round + 1,
    p0Action: a0,
    p1Action: a1,
    p0Payoff,
    p1Payoff,
  };
  const newScores: [number, number] = [
    state.scores[0] + p0Payoff,
    state.scores[1] + p1Payoff,
  ];
  const nextRound = state.round + 1;
  const finished = nextRound >= state.maxRounds;

  let winner: number | null = null;
  if (finished) {
    if (newScores[0] > newScores[1]) winner = 0;
    else if (newScores[1] > newScores[0]) winner = 1;
    else winner = null; // tie
  }

  return {
    ...state,
    round: nextRound,
    history: [...state.history, newRound],
    scores: newScores,
    finished,
    winner,
  };
}

// ---------------------------------------------------------------------------
// Action application
// ---------------------------------------------------------------------------

/** Apply an action to the state. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pendingActions = new Map<string, IPDAction>();

export function applyAction(
  state: IPDState,
  playerId: string | null,
  action: IPDAction,
): ActionResult<IPDState, IPDAction> {
  if (state.finished) {
    return { state };
  }

  if (!playerId) {
    // System action — not supported for IPD
    return { state };
  }

  const p0Id = state.playerIds[0];
  const p1Id = state.playerIds[1];

  // Record this player's action
  pendingActions.set(playerId, action);

  const p0Action = pendingActions.get(p0Id);
  const p1Action = pendingActions.get(p1Id);

  // Only resolve when both players have acted
  if (!p0Action || !p1Action) {
    // Wait for the other player
    return {
      state,
      deadline: { seconds: 60, action: 'cooperate' as IPDAction },
    };
  }

  // Clear pending actions for next round
  pendingActions.delete(p0Id);
  pendingActions.delete(p1Id);

  const newState = resolveRound(state, p0Action, p1Action);

  return {
    state: newState,
    progressIncrement: true,
  };
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/** Player 0's view of the state. */
function getPlayer0View(state: IPDState): IPDPlayer0View {
  return {
    you: {
      id: state.playerIds[0],
      handle: state.playerHandles[0],
      score: state.scores[0],
      history: state.history.map((r) => ({
        myAction: r.p0Action,
        theirAction: r.p1Action,
        myPayoff: r.p0Payoff,
      })),
    },
    opponent: {
      id: state.playerIds[1],
      handle: state.playerHandles[1],
      score: state.scores[1],
    },
    round: state.round,
    maxRounds: state.maxRounds,
    finished: state.finished,
  };
}

/** Player 1's view of the state. */
function getPlayer1View(state: IPDState): IPDPlayer1View {
  return {
    you: {
      id: state.playerIds[1],
      handle: state.playerHandles[1],
      score: state.scores[1],
      history: state.history.map((r) => ({
        myAction: r.p1Action,
        theirAction: r.p0Action,
        myPayoff: r.p1Payoff,
      })),
    },
    opponent: {
      id: state.playerIds[0],
      handle: state.playerHandles[0],
      score: state.scores[0],
    },
    round: state.round,
    maxRounds: state.maxRounds,
    finished: state.finished,
  };
}

/** Get the visible state for a given player. */
export function getVisibleState(state: IPDState, playerId: string | null): unknown {
  if (playerId === null) return getSpectatorView(state);
  if (playerId === state.playerIds[0]) return getPlayer0View(state);
  if (playerId === state.playerIds[1]) return getPlayer1View(state);
  return getSpectatorView(state);
}

/** Spectator sees everything. */
export function getSpectatorView(state: IPDState): IPDSpectatorView {
  let winner: string | null = null;
  if (state.winner !== null) {
    winner = state.playerIds[state.winner];
  }
  return {
    round: state.round,
    maxRounds: state.maxRounds,
    scores: state.scores,
    playerHandles: state.playerHandles,
    history: state.history,
    finished: state.finished,
    winner,
  };
}

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

/** Is the game over? */
export function isOver(state: IPDState): boolean {
  return state.finished;
}

/** Final outcome. Only valid when isOver() is true. */
export function getOutcome(state: IPDState): IPDOutcome {
  if (!state.finished) {
    throw new Error('Cannot get outcome of unfinished game');
  }
  return {
    winner: state.winner !== null ? state.playerIds[state.winner] : null,
    scores: state.scores,
    totalRounds: state.history.length,
    history: state.history,
  };
}