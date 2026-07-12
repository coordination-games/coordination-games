import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  DEFAULT_GENIUS_MAX_ROUNDS,
  deriveGeniusSequence,
  GeniusConfigError,
} from '../index.js';

describe('Genius deterministic sequence and config boundary', () => {
  it('Given a fixed seed, when eight colors are derived, then the canonical vector is stable', () => {
    // Given / When
    const sequence = deriveGeniusSequence('vector-seed', 8);

    // Then
    expect(sequence).toEqual(['green', 'blue', 'red', 'red', 'green', 'yellow', 'blue', 'yellow']);
  });

  it('Given no maxRounds override, when state is created, then the default is eight', () => {
    // Given / When
    const state = createInitialState({ playerIds: ['alpha', 'beta'], seed: 'seed' });

    // Then
    expect(state.maxRounds).toBe(DEFAULT_GENIUS_MAX_ROUNDS);
    expect(state.sequence).toEqual(deriveGeniusSequence('seed', 1));
  });

  it.each([
    [{ playerIds: ['alpha'], seed: 'seed' }, '2 to 4'],
    [{ playerIds: ['a', 'b', 'c', 'd', 'e'], seed: 'seed' }, '2 to 4'],
    [{ playerIds: ['alpha', 'alpha'], seed: 'seed' }, 'unique'],
    [{ playerIds: ['alpha', 'beta'], seed: '' }, 'non-empty'],
    [{ playerIds: ['alpha', 'beta'], seed: 'seed', maxRounds: 0 }, '1 to 32'],
    [{ playerIds: ['alpha', 'beta'], seed: 'seed', maxRounds: 33 }, '1 to 32'],
    [{ playerIds: ['alpha', 'beta'], seed: 'seed', maxRounds: 1.5 }, 'integer'],
  ])('Given invalid config %j, when state creation is attempted, then it fails with a typed error', (config, message) => {
    // Given / When / Then
    expect(() => createInitialState(config)).toThrowError(GeniusConfigError);
    expect(() => createInitialState(config)).toThrow(message);
  });
});
