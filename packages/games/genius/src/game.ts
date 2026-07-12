import type { ActionResult } from '@coordination-games/engine';
import { normalizeGeniusConfig } from './config.js';
import { rankGeniusPlayers, winnerIdsFromRankings } from './ranking.js';
import { deriveGeniusSequence } from './sequence.js';
import {
  GENIUS_COLORS,
  type GeniusAction,
  type GeniusConfigInput,
  type GeniusPlayerState,
  type GeniusState,
} from './types.js';

export function createInitialState(input: GeniusConfigInput): GeniusState {
  const config = normalizeGeniusConfig(input);
  return {
    phase: 'playing',
    round: 1,
    maxRounds: config.maxRounds,
    seed: config.seed,
    sequence: deriveGeniusSequence(config.seed, 1),
    currentPlayerId: config.playerIds[0] ?? null,
    inputIndex: 0,
    completedThisRound: [],
    players: config.playerIds.map((id) => ({
      id,
      score: 0,
      active: true,
      eliminatedRound: null,
    })),
    winnerIds: [],
  };
}

function isActionShape(action: unknown): action is GeniusAction {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) return false;
  const entries = Object.entries(action);
  if (entries.length !== 2) return false;
  const record = Object.fromEntries(entries);
  return (
    record.type === 'press_color' &&
    typeof record.color === 'string' &&
    GENIUS_COLORS.some((color) => color === record.color)
  );
}

export function validateAction(
  state: GeniusState,
  playerId: string | null,
  action: unknown,
): action is GeniusAction {
  if (state.phase !== 'playing' || playerId === null || playerId !== state.currentPlayerId) {
    return false;
  }
  const player = state.players.find((candidate) => candidate.id === playerId);
  return player?.active === true && isActionShape(action);
}

function nextPendingPlayer(
  players: readonly GeniusPlayerState[],
  completed: readonly string[],
  afterPlayerId: string,
): string | null {
  const start = players.findIndex((player) => player.id === afterPlayerId);
  for (let offset = 1; offset <= players.length; offset += 1) {
    const player = players[(start + offset) % players.length];
    if (player?.active === true && !completed.includes(player.id)) return player.id;
  }
  return null;
}

function finish(state: GeniusState, players: readonly GeniusPlayerState[]): GeniusState {
  const rankings = rankGeniusPlayers(
    players,
    state.players.map((player) => player.id),
  );
  return {
    ...state,
    phase: 'finished',
    currentPlayerId: null,
    inputIndex: 0,
    players,
    winnerIds: winnerIdsFromRankings(rankings),
  };
}

function advanceRound(state: GeniusState, players: readonly GeniusPlayerState[]): GeniusState {
  if (state.round >= state.maxRounds) return finish(state, players);
  const round = state.round + 1;
  const currentPlayerId = players.find((player) => player.active)?.id ?? null;
  return {
    ...state,
    round,
    sequence: deriveGeniusSequence(state.seed, round),
    currentPlayerId,
    inputIndex: 0,
    completedThisRound: [],
    players,
  };
}

function eliminateCurrent(state: GeniusState, playerId: string): GeniusState {
  const players = state.players.map((player) =>
    player.id === playerId ? { ...player, active: false, eliminatedRound: state.round } : player,
  );
  if (players.filter((player) => player.active).length <= 1) return finish(state, players);
  const currentPlayerId = nextPendingPlayer(players, state.completedThisRound, playerId);
  if (currentPlayerId === null) return advanceRound(state, players);
  return { ...state, players, currentPlayerId, inputIndex: 0 };
}

function completeCurrent(state: GeniusState, playerId: string): GeniusState {
  const players = state.players.map((player) =>
    player.id === playerId ? { ...player, score: player.score + 1 } : player,
  );
  const completedThisRound = [...state.completedThisRound, playerId];
  const currentPlayerId = nextPendingPlayer(players, completedThisRound, playerId);
  if (currentPlayerId === null) {
    return advanceRound({ ...state, completedThisRound }, players);
  }
  return { ...state, players, completedThisRound, currentPlayerId, inputIndex: 0 };
}

export function applyAction(
  state: GeniusState,
  playerId: string | null,
  action: unknown,
): ActionResult<GeniusState, GeniusAction> {
  if (playerId === null || !validateAction(state, playerId, action)) return { state };
  const expected = state.sequence[state.inputIndex];
  if (action.color !== expected) return { state: eliminateCurrent(state, playerId) };
  if (state.inputIndex + 1 === state.sequence.length) {
    return { state: completeCurrent(state, playerId) };
  }
  return { state: { ...state, inputIndex: state.inputIndex + 1 } };
}
