import { describe, expect, it } from 'vitest';
import { type TragedyAction, TragedyOfTheCommonsPlugin, type TragedyState } from '../index.js';

const PLAYERS = ['alpha', 'beta', 'gamma', 'delta'];

interface NativeBoardView {
  round: number;
  phase: string;
  boardTiles: unknown[];
  players?: unknown[];
  you?: unknown;
  relayMessages?: unknown[];
}

function isNativeBoardView(value: unknown): value is NativeBoardView {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { boardTiles?: unknown };
  return 'round' in value && 'phase' in value && Array.isArray(candidate.boardTiles);
}

function createState(maxRounds = 2): TragedyState {
  const setup = TragedyOfTheCommonsPlugin.createConfig?.(
    PLAYERS.map((id) => ({ id, handle: id })),
    'gameplay-flow-seed',
    { maxRounds },
  );
  if (!setup) throw new Error('expected Tragedy createConfig');
  return TragedyOfTheCommonsPlugin.createInitialState(setup.config);
}

function applyValidated(
  state: TragedyState,
  playerId: string | null,
  action: TragedyAction,
): TragedyState {
  expect(TragedyOfTheCommonsPlugin.validateAction(state, playerId, action)).toBe(true);
  return TragedyOfTheCommonsPlugin.applyAction(state, playerId, action).state;
}

function expectNativeBoardView(value: unknown): NativeBoardView {
  if (!isNativeBoardView(value)) throw new Error('expected native board view');
  expect(value.boardTiles).toHaveLength(19);
  return value;
}

describe('Tragedy native plugin gameplay flow', () => {
  it('runs start, player actions, spectator views, timeout finish, and outcome through the plugin API', () => {
    let state = createState();

    expect(state.phase).toBe('waiting');
    expect(state.boardTiles).toHaveLength(19);
    expect(TragedyOfTheCommonsPlugin.getCurrentPhaseKind(state)).toBe('lobby');
    expect(TragedyOfTheCommonsPlugin.getProgressCounter(state)).toBe(0);
    expect(TragedyOfTheCommonsPlugin.getTeamForPlayer(state, 'alpha')).toBe('alpha');
    expect(TragedyOfTheCommonsPlugin.validateAction(state, 'alpha', { type: 'pass' })).toBe(false);

    state = applyValidated(state, null, { type: 'game_start' });

    expect(state.phase).toBe('playing');
    expect(state.round).toBe(1);
    expect(TragedyOfTheCommonsPlugin.getCurrentPhaseKind(state)).toBe('in_progress');
    expect(TragedyOfTheCommonsPlugin.getProgressCounter(state)).toBe(1);
    expect(TragedyOfTheCommonsPlugin.getPlayersNeedingAction?.(state)).toEqual(PLAYERS);

    const spectatorBeforeActions = expectNativeBoardView(
      TragedyOfTheCommonsPlugin.buildSpectatorView(state, null, {
        handles: Object.fromEntries(PLAYERS.map((id) => [id, id.toUpperCase()])),
        relayMessages: [
          {
            index: 1,
            type: 'chat:message',
            pluginId: 'basic-chat',
            sender: 'alpha',
            scope: { kind: 'all' },
            turn: 1,
            timestamp: 1,
            data: { content: 'opening commons negotiation' },
          },
        ],
      }),
    );
    expect(spectatorBeforeActions.relayMessages).toHaveLength(1);

    const alphaView = expectNativeBoardView(
      TragedyOfTheCommonsPlugin.getVisibleState(state, 'alpha'),
    );
    expect(alphaView.you).toBeTruthy();
    expect(alphaView.boardTiles).toHaveLength(spectatorBeforeActions.boardTiles.length);
    expectNativeBoardView(TragedyOfTheCommonsPlugin.getVisibleState(state, null));

    state = applyValidated(state, 'alpha', { type: 'build_settlement', regionId: 'ironcrest' });
    expect(TragedyOfTheCommonsPlugin.validateAction(state, 'alpha', { type: 'pass' })).toBe(false);
    expect(TragedyOfTheCommonsPlugin.getPlayersNeedingAction?.(state)).toEqual([
      'beta',
      'gamma',
      'delta',
    ]);

    state = applyValidated(state, 'beta', {
      type: 'extract_commons',
      ecosystemId: 'sunspine-aquifer',
      level: 'medium',
    });
    state = applyValidated(state, 'gamma', { type: 'pass' });
    state = applyValidated(state, 'delta', { type: 'pass' });

    expect(state.round).toBe(2);
    expect(state.phase).toBe('playing');
    expect(state.boardTiles).toHaveLength(19);
    expect(state.players.find((player) => player.id === 'alpha')?.regionsControlled).toContain(
      'ironcrest',
    );
    expectNativeBoardView(
      TragedyOfTheCommonsPlugin.buildSpectatorView(state, null, {
        handles: {},
        relayMessages: [],
      }),
    );

    state = applyValidated(state, null, { type: 'round_timeout' });

    expect(state.phase).toBe('finished');
    expect(TragedyOfTheCommonsPlugin.isOver(state)).toBe(true);
    expect(TragedyOfTheCommonsPlugin.getCurrentPhaseKind(state)).toBe('finished');
    const outcome = TragedyOfTheCommonsPlugin.getOutcome(state);
    expect(outcome.rankings).toHaveLength(PLAYERS.length);
    expect(outcome.roundsPlayed).toBe(2);
    const payouts = TragedyOfTheCommonsPlugin.computePayouts(
      outcome,
      PLAYERS,
      TragedyOfTheCommonsPlugin.entryCost,
    );
    expect(payouts.size).toBe(PLAYERS.length);
  });
});
