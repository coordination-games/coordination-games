import { describe, expect, it } from 'vitest';
import { TragedyOfTheCommonsPlugin, type TragedyState } from '../index.js';

const PLAYERS = ['alpha', 'beta', 'gamma', 'delta'];

function createState(): TragedyState {
  const setup = TragedyOfTheCommonsPlugin.createConfig?.(
    PLAYERS.map((id) => ({ id, handle: id })),
    'spectator-board-seed',
    {},
  );
  if (!setup) throw new Error('expected Tragedy createConfig');
  return TragedyOfTheCommonsPlugin.createInitialState(setup.config);
}

describe('Tragedy spectator board contract', () => {
  it('publishes the complete native board, not just the six controlled regions', () => {
    const state = createState();
    const spectator = TragedyOfTheCommonsPlugin.buildSpectatorView?.(state, null, {
      handles: Object.fromEntries(PLAYERS.map((id) => [id, id])),
      relayMessages: [],
    });

    if (!spectator || typeof spectator !== 'object' || !('boardTiles' in spectator)) {
      throw new Error('expected spectator boardTiles');
    }

    const boardTiles = spectator.boardTiles;
    if (!Array.isArray(boardTiles)) throw new Error('expected boardTiles array');

    expect(boardTiles).toHaveLength(19);
    expect(boardTiles.length).toBeGreaterThan(state.regions.length);
    expect(
      boardTiles.filter((tile) => typeof tile === 'object' && tile && 'regionId' in tile),
    ).toHaveLength(state.regions.length);
  });
});
