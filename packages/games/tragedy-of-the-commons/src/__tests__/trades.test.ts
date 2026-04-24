import { describe, expect, it } from 'vitest';
import { type TragedyAction, TragedyOfTheCommonsPlugin, type TragedyState } from '../index.js';

const PLAYERS = ['alpha', 'beta', 'gamma', 'delta'];

function startState(maxRounds = 1): TragedyState {
  const setup = TragedyOfTheCommonsPlugin.createConfig?.(
    PLAYERS.map((id) => ({ id, handle: id })),
    'trade-test-seed',
    { maxRounds },
  );
  if (!setup) throw new Error('expected Tragedy createConfig');
  const initial = TragedyOfTheCommonsPlugin.createInitialState(setup.config);
  return TragedyOfTheCommonsPlugin.applyAction(initial, null, { type: 'game_start' }).state;
}

function apply(state: TragedyState, playerId: string, action: TragedyAction): TragedyState {
  expect(TragedyOfTheCommonsPlugin.validateAction(state, playerId, action)).toBe(true);
  return TragedyOfTheCommonsPlugin.applyAction(state, playerId, action).state;
}

describe('Tragedy trade validation and settlement', () => {
  it('rejects trades that would push the receiver above the resource cap', () => {
    const state = startState();
    const alpha = state.players.find((player) => player.id === 'alpha');
    if (!alpha) throw new Error('expected alpha');
    alpha.resources = { grain: 14, timber: 0, ore: 0, fish: 0, water: 0, energy: 0 };

    expect(
      TragedyOfTheCommonsPlugin.validateAction(state, 'alpha', {
        type: 'offer_trade',
        to: 'beta',
        give: { grain: 1 },
        receive: { timber: 2 },
      }),
    ).toBe(false);
  });

  it('settles matching reciprocal trades without minting over the cap', () => {
    let state = startState();
    const alphaBefore = state.players.find((player) => player.id === 'alpha')?.resources.grain;
    const betaBefore = state.players.find((player) => player.id === 'beta')?.resources.timber;

    state = apply(state, 'alpha', {
      type: 'offer_trade',
      to: 'beta',
      give: { grain: 1 },
      receive: { timber: 1 },
    });
    state = apply(state, 'beta', {
      type: 'offer_trade',
      to: 'alpha',
      give: { timber: 1 },
      receive: { grain: 1 },
    });
    state = apply(state, 'gamma', { type: 'pass' });
    state = apply(state, 'delta', { type: 'pass' });

    const alpha = state.players.find((player) => player.id === 'alpha');
    const beta = state.players.find((player) => player.id === 'beta');
    if (!alpha || !beta || alphaBefore == null || betaBefore == null) {
      throw new Error('expected settled trade players');
    }

    expect(state.phase).toBe('finished');
    expect(state.activeTrades).toHaveLength(2);
    expect(alpha.resources.grain).toBe(alphaBefore - 1);
    expect(beta.resources.timber).toBe(betaBefore - 1);
    expect(
      Object.values(alpha.resources).reduce((total, value) => total + value, 0),
    ).toBeLessThanOrEqual(14);
    expect(
      Object.values(beta.resources).reduce((total, value) => total + value, 0),
    ).toBeLessThanOrEqual(14);
  });
});
