import { describe, expect, it } from 'vitest';
import {
  applyV2Action,
  buildV2PlayerView,
  buildV2SpectatorView,
  createV2InitialState,
  validateV2Action,
} from '../game.js';
import { TragedyOfTheCommonsV2Plugin } from '../plugin.js';
import { DEFAULT_V2_CONFIG, type TragedyV2Action, type TragedyV2State } from '../types.js';

const PLAYER_IDS = ['alpha', 'beta', 'gamma'];

function createPlayingState(): TragedyV2State {
  let state = createV2InitialState(
    DEFAULT_V2_CONFIG({
      seed: 'simultaneous-reveal-seed',
      playerIds: PLAYER_IDS,
      maxRounds: 3,
    }),
  );
  const placements: Record<string, string> = {
    alpha: 'northWest',
    beta: 'north',
    gamma: 'south',
  };

  while (state.phase === 'waiting') {
    const current = state.players[state.currentPlayerIndex];
    if (!current) throw new Error('expected a setup player');
    const intersectionId = placements[current.id];
    if (!intersectionId) throw new Error(`missing placement for ${current.id}`);
    state = applyV2Action(state, current.id, { type: 'place_starting_camp', intersectionId }).state;
  }
  return state;
}

function extractionFor(
  state: TragedyV2State,
  playerId: string,
): Extract<TragedyV2Action, { type: 'extract_tile' }> {
  const structure = state.structures.find((item) => item.ownerId === playerId);
  if (!structure) throw new Error(`missing starting camp for ${playerId}`);
  const intersection = state.intersections.find((item) => item.id === structure.intersectionId);
  const hex = intersection?.hexes[0];
  if (!hex) throw new Error(`missing adjacent hex for ${playerId}`);
  const tile = state.tiles.find((item) => item.q === hex.q && item.r === hex.r);
  if (!tile) throw new Error(`missing adjacent tile for ${playerId}`);
  return { type: 'extract_tile', tileId: tile.id, resource: tile.primaryResource, level: 'low' };
}

function submitInOrder(state: TragedyV2State, playerIds: readonly string[]): TragedyV2State {
  return playerIds.reduce((current, playerId) => {
    const action = extractionFor(current, playerId);
    expect(validateV2Action(current, playerId, action)).toBe(true);
    return applyV2Action(current, playerId, action).state;
  }, state);
}

describe('Tragedy V2 simultaneous extraction reveal', () => {
  it('Given a pending extraction, when another player or spectator observes, then the choice remains private', () => {
    const state = createPlayingState();
    const firstPlayer = state.players[0];
    if (!firstPlayer) throw new Error('expected first player');
    const action = extractionFor(state, firstPlayer.id);

    const result = applyV2Action(state, firstPlayer.id, action);
    const spectator = buildV2SpectatorView(result.state);
    const pluginSpectator = TragedyOfTheCommonsV2Plugin.getVisibleState(result.state, null);
    const otherPlayer = state.players.find((player) => player.id !== firstPlayer.id);
    if (!otherPlayer) throw new Error('expected another player');
    const playerView = buildV2PlayerView(result.state, otherPlayer.id);

    expect(result.state.round).toBe(1);
    expect(
      JSON.stringify({
        spectator,
        pluginSpectator,
        playerView,
        relayMessages: result.relayMessages,
      }),
    ).not.toContain(`"action":{"tileId":"${action.tileId}"`);
    const getPlayersNeedingAction = TragedyOfTheCommonsV2Plugin.getPlayersNeedingAction;
    if (!getPlayersNeedingAction) throw new Error('expected player-submission reader');
    expect(getPlayersNeedingAction(result.state)).toEqual(
      state.players.filter((player) => player.id !== firstPlayer.id).map((player) => player.id),
    );
    expect(TragedyOfTheCommonsV2Plugin.getCurrentGameTools?.(result.state, firstPlayer.id)).toEqual(
      [],
    );
  });

  it('Given private extractions from every player, when the final choice arrives, then the round resolves and exposes one reveal artifact', () => {
    let state = createPlayingState();
    const submitted = state.players.map((player) => ({
      playerId: player.id,
      action: extractionFor(state, player.id),
    }));

    for (const item of submitted.slice(0, -1)) {
      state = applyV2Action(state, item.playerId, item.action).state;
      expect(state.lastResolvedActions).toEqual([]);
    }
    const final = submitted.at(-1);
    if (!final) throw new Error('expected final submission');
    const result = applyV2Action(state, final.playerId, final.action);
    const spectator = buildV2SpectatorView(result.state);

    expect(result.state.round).toBe(2);
    expect(spectator).toMatchObject({ lastRoundReveal: { round: 1, actions: submitted } });
    expect(JSON.stringify(result.relayMessages)).toContain(final.action.tileId);
  });

  it('Given identical choices, when players submit them in different orders, then resolution and replay state are identical', () => {
    const initial = createPlayingState();
    const canonical = submitInOrder(
      initial,
      initial.players.map((player) => player.id),
    );
    const reversed = submitInOrder(
      initial,
      [...initial.players].reverse().map((player) => player.id),
    );

    expect(reversed).toEqual(canonical);
  });

  it('Given partial submissions, when the round deadline expires, then every missing player resolves as pass', () => {
    const state = createPlayingState();
    const firstPlayer = state.players[0];
    if (!firstPlayer) throw new Error('expected first player');
    const submitted = applyV2Action(
      state,
      firstPlayer.id,
      extractionFor(state, firstPlayer.id),
    ).state;

    const timedOut = applyV2Action(submitted, null, { type: 'round_timeout' }).state;

    expect(timedOut.round).toBe(2);
    expect(timedOut).toMatchObject({
      lastRoundReveal: {
        actions: [
          { playerId: firstPlayer.id, action: extractionFor(state, firstPlayer.id) },
          ...state.players
            .slice(1)
            .map((player) => ({ playerId: player.id, action: { type: 'pass' } })),
        ],
      },
    });
  });
});
