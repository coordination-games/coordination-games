import { describe, expect, it } from 'vitest';
import { applyV2Action, createV2InitialState, validateV2Action } from '../game.js';
import { TragedyOfTheCommonsV2Plugin } from '../plugin.js';
import { DEFAULT_V2_CONFIG, type TragedyV2Action, type TragedyV2State } from '../types.js';

// Two players is enough to drive setup + one round; matches the
// non-adjacent starter-camp combo used elsewhere in this suite
// (northWest / north share exactly one hex).
const PLAYERS = ['alpha', 'beta'];
const PLACEMENTS: Record<string, string> = { alpha: 'northWest', beta: 'north' };
const OIL_TILE_ID = '1,-1'; // adjacent to the 'north' starter intersection

function createState(pressure?: number): TragedyV2State {
  return createV2InitialState(
    DEFAULT_V2_CONFIG({
      seed: 'pressure-test-seed',
      playerIds: PLAYERS,
      maxRounds: 4,
      ...(pressure === undefined ? {} : { pressure }),
    }),
  );
}

function applyValidated(
  state: TragedyV2State,
  playerId: string | null,
  action: TragedyV2Action,
): TragedyV2State {
  expect(validateV2Action(state, playerId, action)).toBe(true);
  return applyV2Action(state, playerId, action).state;
}

function placeStartingCamps(state: TragedyV2State): TragedyV2State {
  let nextState = state;
  while (nextState.phase === 'waiting') {
    const currentPlayer = nextState.players[nextState.currentPlayerIndex];
    if (!currentPlayer) throw new Error('missing current setup player');
    const intersectionId = PLACEMENTS[currentPlayer.id];
    if (!intersectionId) throw new Error(`missing setup placement for ${currentPlayer.id}`);
    nextState = applyValidated(nextState, currentPlayer.id, {
      type: 'place_starting_camp',
      intersectionId,
    });
  }
  return nextState;
}

function tileHealth(state: TragedyV2State, tileId: string): number {
  const tile = state.tiles.find((item) => item.id === tileId);
  if (!tile) throw new Error(`missing tile ${tileId}`);
  return tile.health;
}

function tileStatus(state: TragedyV2State, tileId: string): string {
  const tile = state.tiles.find((item) => item.id === tileId);
  if (!tile) throw new Error(`missing tile ${tileId}`);
  return tile.status;
}

/** Plays round 1: alpha passes, beta does one 'low' extraction on the oil tile. */
function playExtractionRound(state: TragedyV2State): TragedyV2State {
  const startingRound = state.round;
  let nextState = state;
  while (nextState.phase === 'playing' && nextState.round === startingRound) {
    const currentPlayer = nextState.players[nextState.currentPlayerIndex];
    if (!currentPlayer) throw new Error('missing current player');
    const action: TragedyV2Action =
      currentPlayer.id === 'beta'
        ? { type: 'extract_tile', tileId: OIL_TILE_ID, resource: 'energy', level: 'low' }
        : { type: 'pass' };
    nextState = applyValidated(nextState, currentPlayer.id, action);
  }
  return nextState;
}

describe('pressure dial — default-off invariant', () => {
  it('omitted pressure and explicit pressure: 0 produce byte-identical initial tiles', () => {
    const omitted = createState(undefined);
    const explicitZero = createState(0);
    expect(explicitZero.tiles).toEqual(omitted.tiles);
  });

  it('omitted pressure reproduces the exact starting tile health used before the pressure dial existed', () => {
    const state = createState(undefined);
    expect(tileHealth(state, OIL_TILE_ID)).toBe(12); // east-oil-field base health
    expect(tileHealth(state, '-1,0')).toBe(16); // old-growth-ring base health
    expect(tileHealth(state, '1,0')).toBe(14); // silver-tide-wetland base health
  });

  it('omitted pressure reproduces the exact extraction yield/decay used before the pressure dial existed', () => {
    let state = placeStartingCamps(createState(undefined));
    const oilBefore = tileHealth(state, OIL_TILE_ID);
    state = playExtractionRound(state);
    const beta = state.players.find((p) => p.id === 'beta');
    expect(beta?.resources.energy).toBe(3); // matches v2-gameplay-flow.test.ts's pre-existing fixture
    expect(tileHealth(state, OIL_TILE_ID)).toBeLessThan(oilBefore);
    expect(tileHealth(state, OIL_TILE_ID)).toBe(8);
  });

  it("createConfig leaves pressure unset when the lobby options don't provide one", () => {
    const players = PLAYERS.map((id) => ({ id, handle: id }));
    const setup = TragedyOfTheCommonsV2Plugin.createConfig?.(players, 'seed', {});
    expect(setup?.config.pressure).toBeUndefined();
  });
});

describe('pressure dial — monotonic scarcity', () => {
  it('scales starting tile health down strictly monotonically as pressure rises', () => {
    const healthByPressure = [0, 1, 2, 3].map((pressure) =>
      tileHealth(createState(pressure), OIL_TILE_ID),
    );
    expect(healthByPressure).toEqual([12, 10, 7, 5]);
    for (let i = 1; i < healthByPressure.length; i += 1) {
      expect(healthByPressure[i]).toBeLessThan(healthByPressure[i - 1] ?? Number.POSITIVE_INFINITY);
    }
  });

  it('scales every V2_TILE_SPECS tile down (non-increasing) as pressure rises, never below 1', () => {
    const states = [0, 1, 2, 3].map((pressure) => createState(pressure));
    for (const tile of states[0]?.tiles ?? []) {
      const healths = states.map(
        (state) => state.tiles.find((item) => item.id === tile.id)?.health ?? -1,
      );
      for (let i = 1; i < healths.length; i += 1) {
        expect(healths[i]).toBeLessThanOrEqual(healths[i - 1] ?? Number.POSITIVE_INFINITY);
      }
      expect(healths.every((h) => h >= 1)).toBe(true);
    }
  });

  it('raises the private payoff of the same extraction action strictly monotonically', () => {
    const energyByPressure = [0, 1, 2, 3].map((pressure) => {
      let state = placeStartingCamps(createState(pressure));
      state = playExtractionRound(state);
      return state.players.find((p) => p.id === 'beta')?.resources.energy ?? -1;
    });
    expect(energyByPressure).toEqual([3, 4, 5, 6]);
    for (let i = 1; i < energyByPressure.length; i += 1) {
      expect(energyByPressure[i]).toBeGreaterThan(
        energyByPressure[i - 1] ?? Number.NEGATIVE_INFINITY,
      );
    }
  });

  it('raises commons decay from the same extraction action (non-increasing tile health), tipping the tile into collapse', () => {
    const healthAfterByPressure = [0, 1, 2, 3].map((pressure) => {
      let state = placeStartingCamps(createState(pressure));
      state = playExtractionRound(state);
      return tileHealth(state, OIL_TILE_ID);
    });
    expect(healthAfterByPressure).toEqual([8, 4, 0, 0]);
    for (let i = 1; i < healthAfterByPressure.length; i += 1) {
      expect(healthAfterByPressure[i]).toBeLessThanOrEqual(
        healthAfterByPressure[i - 1] ?? Number.POSITIVE_INFINITY,
      );
    }
    expect(healthAfterByPressure[3] ?? Number.POSITIVE_INFINITY).toBeLessThan(
      healthAfterByPressure[0] ?? Number.NEGATIVE_INFINITY,
    );

    // At pressure 0 the tile merely gets strained by one low extraction; by
    // pressure 1 the same single action already collapses it. This is the
    // instrument-v2 finding the calibration protocol exploits: a no-chat
    // opportunist table extracting freely can drive the commons to collapse
    // well before a cooperative table would.
    let baseline = placeStartingCamps(createState(0));
    baseline = playExtractionRound(baseline);
    expect(tileStatus(baseline, OIL_TILE_ID)).toBe('strained');

    let pressured = placeStartingCamps(createState(1));
    pressured = playExtractionRound(pressured);
    expect(tileStatus(pressured, OIL_TILE_ID)).toBe('collapsed');
  });

  it('does not change per-round extraction capacity — a starter camp can still only extract once per round at any pressure', () => {
    for (const pressure of [0, 1, 2, 3]) {
      let state = placeStartingCamps(createState(pressure));
      state = playExtractionRound(state);
      const structure = state.structures.find((s) => s.ownerId === 'beta');
      // extractionsThisRound resets at the start of the next round via
      // applyV2Production, so by the time round 2 begins it should be back
      // to 0 regardless of pressure.
      expect(structure?.extractionsThisRound).toBe(0);
    }
  });

  it('threads pressure from lobby options into config the same way maxRounds does', () => {
    const players = PLAYERS.map((id) => ({ id, handle: id }));
    for (const pressure of [0, 1, 2, 3]) {
      const setup = TragedyOfTheCommonsV2Plugin.createConfig?.(players, 'seed', { pressure });
      expect(setup?.config.pressure).toBe(pressure);
    }
  });

  it('clamps out-of-range pressure into 0..3 instead of throwing', () => {
    expect(() => createState(-5)).not.toThrow();
    expect(() => createState(99)).not.toThrow();
    expect(tileHealth(createState(-5), OIL_TILE_ID)).toBe(tileHealth(createState(0), OIL_TILE_ID));
    expect(tileHealth(createState(99), OIL_TILE_ID)).toBe(tileHealth(createState(3), OIL_TILE_ID));
  });
});
