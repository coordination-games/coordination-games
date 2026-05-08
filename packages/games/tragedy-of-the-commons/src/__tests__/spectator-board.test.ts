import { describe, expect, it } from 'vitest';
import { TragedyOfTheCommonsPlugin, type TragedyState } from '../index.js';

const PLAYERS = ['alpha', 'beta', 'gamma', 'delta'];

function hexKey(hex: unknown): string | null {
  if (!hex || typeof hex !== 'object' || !('q' in hex) || !('r' in hex)) return null;
  const q = hex.q;
  const r = hex.r;
  return typeof q === 'number' && typeof r === 'number' ? `${q},${r}` : null;
}

function sharedHexCount(left: unknown[], right: unknown[]): number {
  const leftKeys = new Set(left.flatMap((hex) => hexKey(hex) ?? []));
  return right.flatMap((hex) => hexKey(hex) ?? []).filter((key) => leftKeys.has(key)).length;
}

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

    const players = 'players' in spectator ? spectator.players : null;
    if (!Array.isArray(players)) throw new Error('expected spectator players array');
    for (const player of players) {
      if (!player || typeof player !== 'object') throw new Error('expected player object');
      const structureLocations = 'structureLocations' in player ? player.structureLocations : null;
      const roadLocations = 'roadLocations' in player ? player.roadLocations : null;
      expect(Array.isArray(structureLocations)).toBe(true);
      expect(Array.isArray(roadLocations)).toBe(true);
      expect((structureLocations as unknown[]).length).toBeGreaterThan(0);
      const firstStructure = (structureLocations as unknown[])[0];
      if (!firstStructure || typeof firstStructure !== 'object' || !('hexes' in firstStructure)) {
        throw new Error('expected intersection-style structure location');
      }
      expect(Array.isArray(firstStructure.hexes)).toBe(true);
      expect(firstStructure.hexes).toHaveLength(3);

      for (const road of roadLocations as unknown[]) {
        if (!road || typeof road !== 'object') throw new Error('expected road object');
        const from =
          'from' in road && road.from && typeof road.from === 'object' ? road.from : null;
        const to = 'to' in road && road.to && typeof road.to === 'object' ? road.to : null;
        const fromHexes = from && 'hexes' in from && Array.isArray(from.hexes) ? from.hexes : [];
        const toHexes = to && 'hexes' in to && Array.isArray(to.hexes) ? to.hexes : [];
        expect(sharedHexCount(fromHexes, toHexes)).toBe(2);
      }
    }
  });
});
