import { describe, expect, it } from 'vitest';
import {
  applyV2Action,
  buildV2PlayerView,
  buildV2SpectatorView,
  createV2InitialState,
  getV2Outcome,
  validateV2Action,
} from '../game.js';
import { DEFAULT_V2_CONFIG, type TragedyV2Action, type TragedyV2State } from '../types.js';

const PLAYERS = ['alpha', 'beta', 'gamma'];

function createState(maxRounds = 4): TragedyV2State {
  return createV2InitialState(
    DEFAULT_V2_CONFIG({
      seed: 'v2-gameplay-flow-seed',
      playerIds: PLAYERS,
      maxRounds,
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

function player(state: TragedyV2State, id: string) {
  const found = state.players.find((item) => item.id === id);
  if (!found) throw new Error(`missing player ${id}`);
  return found;
}

describe('Tragedy V2 gameplay flow', () => {
  it('starts camps on non-adjacent intersections and resolves V2 road, solar, and oil actions', () => {
    let state = createState();

    expect(state.phase).toBe('waiting');
    expect(state.tiles).toHaveLength(19);
    expect(state.intersections).toHaveLength(6);
    expect(state.structures).toHaveLength(PLAYERS.length);
    expect(state.roads).toHaveLength(0);
    expect('regions' in state).toBe(false);
    expect(validateV2Action(state, 'alpha', { type: 'pass' })).toBe(false);

    const starterIntersectionIds = state.structures.map((structure) => structure.intersectionId);
    expect(starterIntersectionIds).toEqual(['northWest', 'north', 'south']);

    state = applyValidated(state, null, { type: 'game_start' });
    expect(state.round).toBe(1);
    expect(state.phase).toBe('playing');

    const oilBefore = state.tiles.find((tile) => tile.id === '1,-1')?.health ?? 0;
    state = applyValidated(state, 'alpha', {
      type: 'build_road',
      fromIntersectionId: 'northWest',
      toIntersectionId: 'northEast',
    });
    state = applyValidated(state, 'beta', {
      type: 'extract_tile',
      tileId: '1,-1',
      resource: 'energy',
      level: 'low',
    });
    state = applyValidated(state, 'gamma', { type: 'pass' });

    expect(state.round).toBe(2);
    expect(state.roads).toHaveLength(1);
    expect(player(state, 'alpha').ownedRoadIds).toHaveLength(1);
    expect(player(state, 'beta').resources.energy).toBe(3);
    expect(state.tiles.find((tile) => tile.id === '1,-1')?.health).toBeLessThan(oilBefore);

    player(state, 'alpha').resources.energy = 2;
    state = applyValidated(state, 'alpha', {
      type: 'build_structure',
      intersectionId: 'northEast',
      structureType: 'solar-farm',
    });
    state = applyValidated(state, 'beta', { type: 'pass' });
    state = applyValidated(state, 'gamma', { type: 'pass' });

    expect(state.round).toBe(3);
    const solarFarm = state.structures.find((structure) => structure.type === 'solar-farm');
    expect(solarFarm?.ownerId).toBe('alpha');
    expect(player(state, 'alpha').resources.energy).toBe(1);
    expect(validateV2Action(state, 'alpha', {
      type: 'extract_tile',
      tileId: '1,-1',
      resource: 'energy',
      level: 'low',
    })).toBe(false);

    player(state, 'alpha').resources.ore = 2;
    player(state, 'alpha').resources.water = 2;
    player(state, 'alpha').resources.energy = 3;
    state = applyValidated(state, 'alpha', {
      type: 'upgrade_structure',
      structureId: solarFarm?.id ?? '',
    });
    state = applyValidated(state, 'beta', { type: 'pass' });
    state = applyValidated(state, 'gamma', { type: 'pass' });

    expect(state.round).toBe(4);
    expect(state.structures.find((structure) => structure.id === solarFarm?.id)?.type).toBe(
      'solar-array',
    );
    expect(player(state, 'alpha').resources.energy).toBe(2);

    const spectator = buildV2SpectatorView(state);
    expect(spectator.tiles).toHaveLength(19);
    expect(spectator.roads).toHaveLength(1);
    expect(spectator.structures.some((structure) => structure.type === 'solar-array')).toBe(true);
    expect(spectator.commonsHealthPercent).toBeGreaterThan(0);
    expect(buildV2PlayerView(state, 'alpha')).toBeTruthy();
    expect(getV2Outcome(state).averageTileHealthPercent).toBe(spectator.commonsHealthPercent);
  });

  it('enforces extraction capacity, settlement upgrades, and collapsed tile recovery', () => {
    let state = createState(3);
    state = applyValidated(state, null, { type: 'game_start' });

    expect(validateV2Action(state, 'alpha', {
      type: 'extract_tile',
      tileId: '-1,0',
      resource: 'timber',
      level: 'high',
    })).toBe(false);

    const alphaCamp = state.structures.find(
      (structure) => structure.ownerId === 'alpha' && structure.type === 'camp',
    );
    if (!alphaCamp) throw new Error('expected alpha starter camp');
    player(state, 'alpha').resources.timber = 2;
    player(state, 'alpha').resources.fish = 1;
    player(state, 'alpha').resources.water = 1;
    player(state, 'alpha').resources.energy = 2;

    state = applyValidated(state, 'alpha', {
      type: 'upgrade_structure',
      structureId: alphaCamp.id,
    });
    state = applyValidated(state, 'beta', { type: 'pass' });
    state = applyValidated(state, 'gamma', { type: 'pass' });

    expect(state.structures.find((structure) => structure.id === alphaCamp.id)?.type).toBe('village');
    expect(validateV2Action(state, 'alpha', {
      type: 'extract_tile',
      tileId: '-1,0',
      resource: 'timber',
      level: 'medium',
    })).toBe(true);
    expect(validateV2Action(state, 'alpha', {
      type: 'extract_tile',
      tileId: '-1,0',
      resource: 'timber',
      level: 'high',
    })).toBe(false);

    const forest = state.tiles.find((tile) => tile.id === '-1,0');
    if (!forest) throw new Error('expected forest tile');
    forest.health = forest.collapseThreshold;
    forest.status = 'collapsed';
    expect(validateV2Action(state, 'alpha', {
      type: 'extract_tile',
      tileId: '-1,0',
      resource: 'timber',
      level: 'low',
    })).toBe(false);

    state = applyValidated(state, 'alpha', { type: 'pass' });
    state = applyValidated(state, 'beta', { type: 'pass' });
    state = applyValidated(state, 'gamma', { type: 'pass' });

    const recoveredForest = state.tiles.find((tile) => tile.id === '-1,0');
    expect(recoveredForest?.health).toBe((forest.collapseThreshold ?? 0) + 2);
    expect(recoveredForest?.status).toBe('strained');
  });
});
