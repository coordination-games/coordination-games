import {
  createHiddenHorizonPublicConfig,
  deriveStopRound,
  type HiddenHorizonPublicConfig,
  parseBytes32Hex,
} from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import {
  applyV2Action,
  buildV2PlayerView,
  buildV2SpectatorView,
  createV2InitialState,
} from '../game.js';
import { effectiveV2FinalRound, sealV2HiddenHorizon } from '../hidden-horizon.js';
import { TragedyOfTheCommonsV2Plugin } from '../plugin.js';
import { DEFAULT_V2_CONFIG, type TragedyV2State } from '../types.js';

const commitment = parseBytes32Hex(`0x${'31'.repeat(32)}`);
const policy = {
  seriesLength: 1,
  baseEntryCost: 1n,
  carryBps: 0,
  slashBps: 0,
  minRounds: 1,
  maxRounds: 9,
  hazardNumerator: 1,
  hazardDenominator: 2,
};

const hiddenHorizon: HiddenHorizonPublicConfig = createHiddenHorizonPublicConfig(
  commitment,
  policy,
);

function createTournamentState(): TragedyV2State {
  return sealV2HiddenHorizon(
    createV2InitialState(
      DEFAULT_V2_CONFIG({
        seed: 'sealed-horizon-seed',
        playerIds: ['alpha', 'beta'],
        maxRounds: 9,
        hiddenHorizon,
      }),
    ),
    3,
  );
}

function resolveRound(state: TragedyV2State): TragedyV2State {
  let next = state;
  while (next.phase === 'playing') {
    const player = next.players[next.currentPlayerIndex];
    if (!player) throw new Error('expected current player');
    next = applyV2Action(next, player.id, { type: 'pass' }).state;
    if (next.phase !== 'playing' || next.round !== state.round) return next;
  }
  return next;
}

describe('Tragedy V2 sealed tournament hidden horizon', () => {
  it('finishes only after all actions in the sealed final round resolve', () => {
    let state: TragedyV2State = { ...createTournamentState(), phase: 'playing', round: 1 };

    state = resolveRound(state);
    expect(state).toMatchObject({ round: 2, phase: 'playing' });
    expect(TragedyOfTheCommonsV2Plugin.isOver(state)).toBe(false);

    state = resolveRound(state);
    expect(state).toMatchObject({ round: 3, phase: 'playing' });
    expect(TragedyOfTheCommonsV2Plugin.isOver(state)).toBe(false);

    state = resolveRound(state);
    expect(state).toMatchObject({ round: 3, phase: 'finished' });
    expect(TragedyOfTheCommonsV2Plugin.isOver(state)).toBe(true);
    expect(TragedyOfTheCommonsV2Plugin.getOutcome(state).roundsPlayed).toBe(3);
  });

  it('projects only the exact public hidden-horizon configuration', () => {
    const state = createTournamentState();
    const spectator = buildV2SpectatorView(state);
    const player = buildV2PlayerView(state, 'alpha');

    expect(spectator.hiddenHorizon).toEqual(hiddenHorizon);
    expect(player).toMatchObject({ hiddenHorizon });
    expect(JSON.stringify({ spectator, player })).not.toContain('stopRound');
    expect(Object.isFrozen(state.sealedHiddenHorizon)).toBe(true);
  });

  it('fails closed for unsealed or malformed committed horizons', () => {
    const unsealed = createV2InitialState(
      DEFAULT_V2_CONFIG({
        seed: 'unsealed-horizon-seed',
        playerIds: ['alpha', 'beta'],
        maxRounds: 9,
        hiddenHorizon,
      }),
    );

    expect(() => effectiveV2FinalRound(unsealed)).toThrow();
    expect(() => TragedyOfTheCommonsV2Plugin.isOver(unsealed)).toThrow();
    expect(() => sealV2HiddenHorizon(unsealed, 10)).toThrow();
    expect(() =>
      sealV2HiddenHorizon(
        createV2InitialState(
          DEFAULT_V2_CONFIG({
            seed: 'mismatched-horizon-seed',
            playerIds: ['alpha', 'beta'],
            maxRounds: 8,
            hiddenHorizon,
          }),
        ),
        3,
      ),
    ).toThrow();
  });

  it('seals only an unsealed initial waiting state', () => {
    const initial = createV2InitialState(
      DEFAULT_V2_CONFIG({
        seed: 'initial-only-horizon-seed',
        playerIds: ['alpha', 'beta'],
        maxRounds: 9,
        hiddenHorizon,
      }),
    );
    const sealed = sealV2HiddenHorizon(initial, 3);

    expect(() => sealV2HiddenHorizon(sealed, 4)).toThrow();
    expect(() => sealV2HiddenHorizon({ ...initial, phase: 'playing' }, 3)).toThrow();
    expect(() => sealV2HiddenHorizon({ ...initial, phase: 'finished' }, 3)).toThrow();
    expect(() => sealV2HiddenHorizon({ ...initial, round: 1 }, 3)).toThrow();
  });

  it('rejects malformed, irrational, and private public-horizon shapes before sealing', () => {
    const initial = createV2InitialState(
      DEFAULT_V2_CONFIG({
        seed: 'strict-public-horizon-seed',
        playerIds: ['alpha', 'beta'],
        maxRounds: 9,
        hiddenHorizon,
      }),
    );
    const withHorizon = (value: unknown): unknown => ({
      ...initial,
      config: { ...initial.config, hiddenHorizon: value },
    });

    expect(() =>
      sealV2HiddenHorizon(withHorizon({ ...hiddenHorizon, commitment: 'not-bytes32' }), 3),
    ).toThrow();
    expect(() =>
      sealV2HiddenHorizon(withHorizon({ ...hiddenHorizon, policyHash: 'not-bytes32' }), 3),
    ).toThrow();
    expect(() =>
      sealV2HiddenHorizon(withHorizon({ ...hiddenHorizon, hazardDenominator: 0 }), 3),
    ).toThrow();
    expect(() =>
      sealV2HiddenHorizon(
        withHorizon({ ...hiddenHorizon, hazardNumerator: hiddenHorizon.hazardDenominator + 1 }),
        3,
      ),
    ).toThrow();
    expect(() => sealV2HiddenHorizon(withHorizon({ ...hiddenHorizon, stopRound: 3 }), 3)).toThrow();
    expect(() =>
      sealV2HiddenHorizon(withHorizon({ ...hiddenHorizon, player_entropy: 'private' }), 3),
    ).toThrow();
  });

  it('derives a deterministic in-bounds endpoint from the sealed Task 6 inputs', () => {
    const secret = parseBytes32Hex(`0x${'41'.repeat(32)}`);
    const firstEntropy = parseBytes32Hex(`0x${'42'.repeat(32)}`);
    const secondEntropy = parseBytes32Hex(`0x${'43'.repeat(32)}`);
    const first = deriveStopRound(secret, 'sealed-game', firstEntropy, policy);
    const repeated = deriveStopRound(secret, 'sealed-game', firstEntropy, policy);
    const changed = deriveStopRound(secret, 'sealed-game', secondEntropy, policy);

    expect(repeated).toBe(first);
    expect(first).toBeGreaterThanOrEqual(policy.minRounds);
    expect(first).toBeLessThanOrEqual(policy.maxRounds);
    expect(changed).toBeGreaterThanOrEqual(policy.minRounds);
    expect(changed).toBeLessThanOrEqual(policy.maxRounds);
    expect([first, changed]).not.toEqual([first, first]);
  });

  it('keeps non-tournament V2 termination at the advertised maximum', () => {
    let state: TragedyV2State = {
      ...createV2InitialState(
        DEFAULT_V2_CONFIG({
          seed: 'non-tournament-horizon-seed',
          playerIds: ['alpha', 'beta'],
          maxRounds: 2,
        }),
      ),
      phase: 'playing',
      round: 1,
    };

    state = resolveRound(state);
    expect(state).toMatchObject({ round: 2, phase: 'playing' });
    state = resolveRound(state);
    expect(state).toMatchObject({ round: 2, phase: 'finished' });
  });
});
