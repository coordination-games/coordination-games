import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createInitialState,
  GENIUS_COLORS,
  type GeniusColor,
  type GeniusState,
  validateAction,
} from '../index.js';

function otherColor(color: GeniusColor): GeniusColor {
  const alternative = GENIUS_COLORS.find((candidate) => candidate !== color);
  if (alternative === undefined) throw new TypeError('fixture needs another color');
  return alternative;
}

function completeTurn(state: GeniusState): GeniusState {
  let next = state;
  for (const color of state.sequence) {
    const playerId = next.currentPlayerId;
    if (playerId === null) throw new TypeError('fixture expected current player');
    next = applyAction(next, playerId, { type: 'press_color', color }).state;
  }
  return next;
}

describe('Genius action validation', () => {
  it('Given a current turn, when malformed, wrong actor, color, and phase actions are checked, then all reject without mutation', () => {
    // Given
    const state = createInitialState({
      playerIds: ['alpha', 'beta'],
      seed: 'validation',
      maxRounds: 2,
    });
    const before = JSON.stringify(state);
    const wrongColor = otherColor(state.sequence[0] ?? 'red');

    // When
    const verdicts = [
      validateAction(state, 'beta', { type: 'press_color', color: state.sequence[0] }),
      validateAction(state, 'alpha', { type: 'press_color', color: 'purple' }),
      validateAction(state, 'alpha', { type: 'press_color' }),
      validateAction(state, 'alpha', { type: 'press_color', color: wrongColor, extra: true }),
      validateAction(state, null, { type: 'press_color', color: state.sequence[0] }),
      validateAction({ ...state, phase: 'finished' }, 'alpha', {
        type: 'press_color',
        color: state.sequence[0],
      }),
    ];

    // Then
    expect(verdicts).toEqual([false, false, false, false, false, false]);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('Genius round and elimination flow', () => {
  it('Given three active players, when each repeats round one, then round two starts at join-order first player', () => {
    // Given
    let state = createInitialState({
      playerIds: ['alpha', 'beta', 'gamma'],
      seed: 'rounds',
      maxRounds: 2,
    });

    // When
    state = completeTurn(state);
    state = completeTurn(state);
    state = completeTurn(state);

    // Then
    expect(state.round).toBe(2);
    expect(state.currentPlayerId).toBe('alpha');
    expect(state.inputIndex).toBe(0);
    expect(state.completedThisRound).toEqual([]);
    expect(state.sequence).toHaveLength(2);
    expect(state.players.map((player) => player.score)).toEqual([1, 1, 1]);
  });

  it('Given three players, when the current player presses a wrong color, then that actor is eliminated and play advances', () => {
    // Given
    const state = createInitialState({ playerIds: ['alpha', 'beta', 'gamma'], seed: 'eliminate' });
    const expected = state.sequence[0] ?? 'red';

    // When
    const next = applyAction(state, 'alpha', {
      type: 'press_color',
      color: otherColor(expected),
    }).state;

    // Then
    expect(next.players[0]).toMatchObject({ id: 'alpha', active: false, eliminatedRound: 1 });
    expect(next.currentPlayerId).toBe('beta');
    expect(next.phase).toBe('playing');
  });

  it('Given two players, when one makes a mistake, then the remaining player wins immediately', () => {
    // Given
    const state = createInitialState({ playerIds: ['alpha', 'beta'], seed: 'last-player' });
    const expected = state.sequence[0] ?? 'red';

    // When
    const next = applyAction(state, 'alpha', {
      type: 'press_color',
      color: otherColor(expected),
    }).state;

    // Then
    expect(next.phase).toBe('finished');
    expect(next.currentPlayerId).toBeNull();
    expect(next.winnerIds).toEqual(['beta']);
  });

  it('Given maxRounds one, when every active player completes the prefix, then tied active winners finish', () => {
    // Given
    let state = createInitialState({
      playerIds: ['alpha', 'beta'],
      seed: 'max-round',
      maxRounds: 1,
    });

    // When
    state = completeTurn(state);
    state = completeTurn(state);

    // Then
    expect(state.phase).toBe('finished');
    expect(state.winnerIds).toEqual(['alpha', 'beta']);
    expect(state.players.map((player) => player.score)).toEqual([1, 1]);
  });
});
