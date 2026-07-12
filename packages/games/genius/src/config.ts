import type { GeniusConfig, GeniusConfigInput } from './types.js';

export const DEFAULT_GENIUS_MAX_ROUNDS = 8;
export const MIN_GENIUS_PLAYERS = 2;
export const MAX_GENIUS_PLAYERS = 4;
export const MAX_GENIUS_ROUNDS = 32;

export class GeniusConfigError extends Error {
  readonly name = 'GeniusConfigError';

  constructor(readonly reason: string) {
    super(`Invalid Genius config: ${reason}`);
  }
}

export function normalizeGeniusConfig(input: GeniusConfigInput): GeniusConfig {
  const playerIds = [...input.playerIds];
  if (playerIds.length < MIN_GENIUS_PLAYERS || playerIds.length > MAX_GENIUS_PLAYERS) {
    throw new GeniusConfigError('playerIds must contain exactly 2 to 4 players');
  }
  if (playerIds.some((playerId) => playerId.length === 0)) {
    throw new GeniusConfigError('playerIds must be non-empty');
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw new GeniusConfigError('playerIds must be unique');
  }
  if (input.seed.length === 0) {
    throw new GeniusConfigError('seed must be non-empty');
  }
  const maxRounds = input.maxRounds ?? DEFAULT_GENIUS_MAX_ROUNDS;
  if (!Number.isInteger(maxRounds)) {
    throw new GeniusConfigError('maxRounds must be an integer');
  }
  if (maxRounds < 1 || maxRounds > MAX_GENIUS_ROUNDS) {
    throw new GeniusConfigError('maxRounds must be bounded from 1 to 32');
  }
  return { playerIds, seed: input.seed, maxRounds };
}
