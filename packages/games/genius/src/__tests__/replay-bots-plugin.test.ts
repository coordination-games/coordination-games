import { canonicalizeJson } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import {
  GENIUS_GAME_ID,
  GeniusPlugin,
  GeniusReplayError,
  replayGeniusGame,
  runGeniusBotFixture,
} from '../index.js';

describe('Genius replay and deterministic bot fixture', () => {
  it('Given a deterministic three-bot game, when replayed, then canonical state, outcome, transcript, and hash are byte-identical', () => {
    // Given
    const first = runGeniusBotFixture();
    const second = runGeniusBotFixture();

    // When
    const replay = replayGeniusGame(first.config, first.actions);

    // Then
    expect(first.config.playerIds).toHaveLength(3);
    expect(first.state.phase).toBe('finished');
    expect(first.actions.length).toBeGreaterThan(3);
    expect(canonicalizeJson(replay)).toBe(canonicalizeJson(first.replay));
    expect(canonicalizeJson(second)).toBe(canonicalizeJson(first));
    expect(first.publicHash).toBe(second.publicHash);
    expect(first.state.players.find((player) => player.id === 'fallible')?.active).toBe(false);
  });

  it('Given a tampered recorded action, when replay is attempted, then invalid data is rejected rather than skipped', () => {
    // Given
    const fixture = runGeniusBotFixture();
    const first = fixture.actions[0];
    if (first === undefined) throw new TypeError('fixture should record actions');
    const tampered = [{ ...first, playerId: 'intruder' }, ...fixture.actions.slice(1)];

    // When / Then
    expect(() => replayGeniusGame(fixture.config, tampered)).toThrowError(GeniusReplayError);
  });
});

describe('Genius CoordinationGame adapters', () => {
  it('Given a valid setup, when generic hooks are called, then Genius exposes the complete contract', () => {
    // Given
    const setup = GeniusPlugin.createConfig?.(
      [
        { id: 'alpha', handle: 'Alpha' },
        { id: 'beta', handle: 'Beta' },
      ],
      'plugin-seed',
      { maxRounds: 1 },
    );
    if (setup === undefined) throw new TypeError('createConfig must exist');
    const state = GeniusPlugin.createInitialState(setup.config);
    const spectator = GeniusPlugin.buildSpectatorView(state, null, {
      handles: { alpha: 'Alpha', beta: 'Beta' },
      relayMessages: [],
    });

    // When / Then
    expect(GeniusPlugin.gameType).toBe(GENIUS_GAME_ID);
    expect(GeniusPlugin.version).toBe('0.1.0');
    expect(GeniusPlugin.gameTools?.map((tool) => tool.name)).toEqual(['press_color']);
    expect(GeniusPlugin.getPlayersNeedingAction?.(state)).toEqual(['alpha']);
    expect(GeniusPlugin.getTeamForPlayer(state, 'alpha')).toBe('alpha');
    expect(GeniusPlugin.getCurrentPhaseKind(state)).toBe('in_progress');
    expect(GeniusPlugin.getProgressCounter(state)).toBe(1);
    expect(GeniusPlugin.getSummaryFromSpectator(spectator)).toEqual(
      GeniusPlugin.getSummary?.(state),
    );
    expect(GeniusPlugin.getReplayChrome(spectator)).toEqual({
      isFinished: false,
      statusVariant: 'in_progress',
    });
    expect(GeniusPlugin.guide).toContain('project-local Simon-inspired fixture');
    expect(GeniusPlugin.guide).toContain('not commercial Genius fidelity');
  });
});
