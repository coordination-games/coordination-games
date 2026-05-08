import { describe, expect, it } from 'vitest';
import {
  applyV2Action,
  buildV2PlayerView,
  buildV2SpectatorView,
  createV2InitialState,
  getV2Outcome,
  validateV2Action,
} from '../game.js';
import { TragedyOfTheCommonsV2Plugin } from '../plugin.js';
import { DEFAULT_V2_CONFIG, type TragedyV2Action, type TragedyV2State } from '../types.js';

const PLAYERS = ['alpha', 'beta', 'gamma'];
const FOUR_PLAYERS = ['alpha', 'beta', 'gamma', 'delta'];

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

function placeStartingCamps(
  state: TragedyV2State,
  placements: Record<string, string> = {
    alpha: 'northWest',
    beta: 'north',
    gamma: 'south',
    delta: 'southOuter',
  },
): TragedyV2State {
  let nextState = state;
  while (nextState.phase === 'waiting') {
    const currentPlayer = nextState.players[nextState.currentPlayerIndex];
    if (!currentPlayer) throw new Error('missing current setup player');
    const intersectionId = placements[currentPlayer.id];
    if (!intersectionId) throw new Error(`missing setup placement for ${currentPlayer.id}`);
    nextState = applyValidated(nextState, currentPlayer.id, {
      type: 'place_starting_camp',
      intersectionId,
    });
  }
  return nextState;
}

function applyRoundActions(
  state: TragedyV2State,
  actionsByPlayer: Record<string, TragedyV2Action>,
): TragedyV2State {
  const startingRound = state.round;
  let nextState = state;
  while (nextState.phase === 'playing' && nextState.round === startingRound) {
    const currentPlayer = nextState.players[nextState.currentPlayerIndex];
    if (!currentPlayer) throw new Error('missing current player');
    nextState = applyValidated(
      nextState,
      currentPlayer.id,
      actionsByPlayer[currentPlayer.id] ?? { type: 'pass' },
    );
  }
  return nextState;
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
    expect(state.intersections.length).toBeGreaterThanOrEqual(6);
    expect(state.structures).toHaveLength(0);
    expect(state.roads).toHaveLength(0);
    expect('regions' in state).toBe(false);
    expect(validateV2Action(state, 'alpha', { type: 'pass' })).toBe(false);
    expect(validateV2Action(state, null, { type: 'game_start' })).toBe(true);
    expect(applyValidated(state, null, { type: 'game_start' }).phase).toBe('waiting');

    state = placeStartingCamps(state);
    expect(state.round).toBe(1);
    expect(state.phase).toBe('playing');

    const starterIntersectionIds = new Map(
      state.structures.map((structure) => [structure.ownerId, structure.intersectionId]),
    );
    expect(starterIntersectionIds.get('alpha')).toBe('northWest');
    expect(starterIntersectionIds.get('beta')).toBe('north');
    expect(starterIntersectionIds.get('gamma')).toBe('south');

    const oilBefore = state.tiles.find((tile) => tile.id === '1,-1')?.health ?? 0;
    state = applyRoundActions(state, {
      alpha: {
        type: 'build_road',
        fromIntersectionId: 'northWest',
        toIntersectionId: 'northEast',
      },
      beta: {
        type: 'extract_tile',
        tileId: '1,-1',
        resource: 'energy',
        level: 'low',
      },
      gamma: { type: 'pass' },
    });

    expect(state.round).toBe(2);
    expect(state.roads).toHaveLength(1);
    expect(player(state, 'alpha').ownedRoadIds).toHaveLength(1);
    expect(player(state, 'beta').resources.energy).toBe(3);
    expect(state.tiles.find((tile) => tile.id === '1,-1')?.health).toBeLessThan(oilBefore);

    player(state, 'alpha').resources.energy = 2;
    state = applyRoundActions(state, {
      alpha: {
        type: 'build_structure',
        intersectionId: 'northEast',
        structureType: 'solar-farm',
      },
      beta: { type: 'pass' },
      gamma: { type: 'pass' },
    });

    expect(state.round).toBe(3);
    const solarFarm = state.structures.find((structure) => structure.type === 'solar-farm');
    expect(solarFarm?.ownerId).toBe('alpha');
    expect(player(state, 'alpha').resources.energy).toBe(1);
    expect(
      validateV2Action(state, 'alpha', {
        type: 'extract_tile',
        tileId: '1,-1',
        resource: 'energy',
        level: 'low',
      }),
    ).toBe(false);

    player(state, 'alpha').resources.ore = 2;
    player(state, 'alpha').resources.water = 2;
    player(state, 'alpha').resources.energy = 3;
    state = applyRoundActions(state, {
      alpha: {
        type: 'upgrade_structure',
        structureId: solarFarm?.id ?? '',
      },
      beta: { type: 'pass' },
      gamma: { type: 'pass' },
    });

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

  it('lets four live-agent players choose non-adjacent starter camps in setup order', () => {
    let state = createV2InitialState(
      DEFAULT_V2_CONFIG({
        seed: 'v2-four-player-seed',
        playerIds: FOUR_PLAYERS,
        maxRounds: 2,
      }),
    );

    expect(state.phase).toBe('waiting');
    expect(state.structures).toHaveLength(0);
    const setupOrder = state.players.map((item) => item.id);
    expect(setupOrder).toHaveLength(FOUR_PLAYERS.length);

    const firstPlayer = state.players[state.currentPlayerIndex];
    if (!firstPlayer) throw new Error('missing first setup player');
    expect(
      TragedyOfTheCommonsV2Plugin.getCurrentGameTools?.(state, firstPlayer.id).map(
        (tool) => tool.name,
      ),
    ).toEqual(['place_starting_camp']);
    expect(
      TragedyOfTheCommonsV2Plugin.getCurrentGameTools?.(state, 'not-current').map(
        (tool) => tool.name,
      ),
    ).toEqual([]);
    expect(
      validateV2Action(state, firstPlayer.id, {
        type: 'place_starting_camp',
        intersectionId: 'northWest',
      }),
    ).toBe(true);

    const afterFirstPlacement = applyValidated(state, firstPlayer.id, {
      type: 'place_starting_camp',
      intersectionId: 'northWest',
    });
    const secondPlayer = afterFirstPlacement.players[afterFirstPlacement.currentPlayerIndex];
    if (!secondPlayer) throw new Error('missing second setup player');
    expect(
      validateV2Action(afterFirstPlacement, secondPlayer.id, {
        type: 'place_starting_camp',
        intersectionId: 'northEast',
      }),
    ).toBe(false);

    state = placeStartingCamps(state);

    expect(state.phase).toBe('playing');
    expect(state.round).toBe(1);
    const playingTools = TragedyOfTheCommonsV2Plugin.getCurrentGameTools?.(state, 'alpha').map(
      (tool) => tool.name,
    );
    expect(playingTools).toContain('pass');
    expect(playingTools).not.toContain('place_starting_camp');
    expect(state.structures).toHaveLength(FOUR_PLAYERS.length);
    expect(new Set(state.structures.map((structure) => structure.ownerId))).toEqual(
      new Set(FOUR_PLAYERS),
    );
    expect(state.structures.map((structure) => structure.intersectionId).sort()).toEqual(
      ['north', 'northWest', 'south', 'southOuter'].sort(),
    );

    const intersectionsById = new Map(
      state.intersections.map((intersection) => [intersection.id, intersection]),
    );
    for (let leftIndex = 0; leftIndex < state.structures.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < state.structures.length; rightIndex += 1) {
        const left = intersectionsById.get(state.structures[leftIndex]?.intersectionId ?? '');
        const right = intersectionsById.get(state.structures[rightIndex]?.intersectionId ?? '');
        if (!left || !right) throw new Error('missing starter intersection');
        const shared = left.hexes.filter((leftHex) =>
          right.hexes.some((rightHex) => rightHex.q === leftHex.q && rightHex.r === leftHex.r),
        );
        expect(shared.length).toBeLessThan(2);
      }
    }
  });

  it('enforces extraction capacity, settlement upgrades, and collapsed tile recovery', () => {
    let state = createState(3);
    state = placeStartingCamps(state);

    expect(
      validateV2Action(state, 'alpha', {
        type: 'extract_tile',
        tileId: '-1,0',
        resource: 'timber',
        level: 'high',
      }),
    ).toBe(false);

    const alphaCamp = state.structures.find(
      (structure) => structure.ownerId === 'alpha' && structure.type === 'camp',
    );
    if (!alphaCamp) throw new Error('expected alpha starter camp');
    player(state, 'alpha').resources.timber = 2;
    player(state, 'alpha').resources.fish = 1;
    player(state, 'alpha').resources.water = 1;
    player(state, 'alpha').resources.energy = 2;

    state = applyRoundActions(state, {
      alpha: {
        type: 'upgrade_structure',
        structureId: alphaCamp.id,
      },
      beta: { type: 'pass' },
      gamma: { type: 'pass' },
    });

    expect(state.structures.find((structure) => structure.id === alphaCamp.id)?.type).toBe(
      'village',
    );
    expect(
      validateV2Action(state, 'alpha', {
        type: 'extract_tile',
        tileId: '-1,0',
        resource: 'timber',
        level: 'medium',
      }),
    ).toBe(true);
    expect(
      validateV2Action(state, 'alpha', {
        type: 'extract_tile',
        tileId: '-1,0',
        resource: 'timber',
        level: 'high',
      }),
    ).toBe(false);

    const forest = state.tiles.find((tile) => tile.id === '-1,0');
    if (!forest) throw new Error('expected forest tile');
    forest.health = forest.collapseThreshold;
    forest.status = 'collapsed';
    expect(
      validateV2Action(state, 'alpha', {
        type: 'extract_tile',
        tileId: '-1,0',
        resource: 'timber',
        level: 'low',
      }),
    ).toBe(false);

    state = applyRoundActions(state, {
      alpha: { type: 'pass' },
      beta: { type: 'pass' },
      gamma: { type: 'pass' },
    });

    const recoveredForest = state.tiles.find((tile) => tile.id === '-1,0');
    expect(recoveredForest?.health).toBe((forest.collapseThreshold ?? 0) + 2);
    expect(recoveredForest?.status).toBe('strained');
  });
});
