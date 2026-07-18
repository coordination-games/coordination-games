import { describe, expect, it } from 'vitest';
import { type RunBatchResult, runBatch } from '../orchestrate.js';
import type { RunSpec } from '../types.js';
import {
  completedGameArtifacts,
  completedState,
  createTournamentBatchFixture,
  failedState,
  readSeriesManifest,
  runningState,
} from './tournament-batch-fixture.js';

const SESSION_LIMITS = { maxModelCalls: 2, wallClockMs: 100 };

describe('tournament runBatch orchestration', () => {
  it('Given a three-game series with a stale id and eliminated seat, when runBatch completes, then identities stay stable and every active seat receives one bounded session', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({
      states: [
        runningState('game-1', ['player-a', 'player-b', 'player-c']),
        runningState('game-1', ['player-a', 'player-b', 'player-c']),
        runningState('game-2', ['player-a', 'player-b'], ['game-1', 'game-2']),
        runningState('game-3', ['player-a', 'player-b'], ['game-1', 'game-2', 'game-3']),
        completedState(['game-1', 'game-2', 'game-3']),
      ],
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(fixture.calls.identityResolutions).toBe(1);
      expect(fixture.calls.seatResolutions).toBe(1);
      expect(fixture.calls.lobbyCreations).toBe(1);
      expect(fixture.calls.seatIdentityInputs[0]).toBe(fixture.identities);
      expect(fixture.calls.lobbyIdentityInputs[0]).toBe(fixture.identities);
      expect(fixture.calls.sessions).toEqual([
        { gameId: 'game-1', botName: 'bot-a', signal: undefined, limits: SESSION_LIMITS },
        { gameId: 'game-1', botName: 'bot-b', signal: undefined, limits: SESSION_LIMITS },
        { gameId: 'game-1', botName: 'bot-c', signal: undefined, limits: SESSION_LIMITS },
        { gameId: 'game-2', botName: 'bot-a', signal: undefined, limits: SESSION_LIMITS },
        { gameId: 'game-2', botName: 'bot-b', signal: undefined, limits: SESSION_LIMITS },
        { gameId: 'game-3', botName: 'bot-a', signal: undefined, limits: SESSION_LIMITS },
        { gameId: 'game-3', botName: 'bot-b', signal: undefined, limits: SESSION_LIMITS },
      ]);
      expect(fixture.calls.snapshots).toEqual(['game-1', 'game-2', 'game-3']);
      expect(await completedGameArtifacts(result)).toEqual([
        { path: 'games/0/manifest.json', gameId: 'game-1' },
        { path: 'games/1/manifest.json', gameId: 'game-2' },
        { path: 'games/2/manifest.json', gameId: 'game-3' },
      ]);
      expect(await readSeriesManifest(result)).toMatchObject({
        kind: 'tournament',
        status: 'completed',
        lobbyId: 'lobby-fixture',
        tournamentId: 'lobby:lobby-fixture',
        gameIds: ['game-1', 'game-2', 'game-3'],
        standings: [{ playerId: 'player-a', rank: 1 }],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given one persisted game and an expired injected clock, when runBatch reaches the next game boundary, then it writes a timed-out partial manifest', async () => {
    // Given
    const times = [0, 0, 101];
    const fixture = await createTournamentBatchFixture({
      states: [runningState('game-1', ['player-a'])],
      now: () => times.shift() ?? 101,
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(await readSeriesManifest(result)).toMatchObject({
        status: 'timed_out',
        error: 'Tournament wall-clock limit exceeded',
        gameIds: ['game-1'],
      });
      expect(await completedGameArtifacts(result)).toEqual([
        { path: 'games/0/manifest.json', gameId: 'game-1' },
      ]);
      expect(fixture.calls.sessions.map(({ gameId, botName }) => ({ gameId, botName }))).toEqual([
        { gameId: 'game-1', botName: 'bot-a' },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given provider usage that exceeds the shared aggregate budget, when runBatch finishes the active sessions, then it persists usage and no completed-game artifact', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({
      states: [runningState('game-1', ['player-a'])],
      maxAggregateCostMicrousd: 3_000_000,
      usageEmission: {
        gameId: 'game-1',
        usage: { prompt_tokens: 2_000_000, completion_tokens: 0 },
      },
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(await readSeriesManifest(result)).toMatchObject({
        status: 'failed',
        error: 'Aggregate model budget exceeded: 4000000 micro-USD',
        gameIds: ['game-1'],
        usage: {
          promptTokens: 2_000_000,
          completionTokens: 0,
          costMicrousd: 4_000_000,
          budgetMicrousd: 3_000_000,
        },
        budgetError: {
          name: 'RunBudgetExceededError',
          message: 'Aggregate model budget exceeded: 4000000 micro-USD',
        },
      });
      expect(await completedGameArtifacts(result)).toEqual([]);
      expect(fixture.calls.snapshots).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given TournamentDO fails after one completed game, when runBatch observes the terminal state, then it preserves only that completed artifact', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({
      states: [runningState('game-1', ['player-a']), failedState(['game-1'])],
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(await readSeriesManifest(result)).toMatchObject({
        status: 'failed',
        error: 'settlement failed',
        gameIds: ['game-1'],
      });
      expect(await completedGameArtifacts(result)).toEqual([
        { path: 'games/0/manifest.json', gameId: 'game-1' },
      ]);
      expect(fixture.calls.sessions).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given a provider session fails before its game completes, when runBatch handles the failure, then it writes a failed partial manifest without a game artifact', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({
      states: [runningState('game-1', ['player-a'])],
      providerFailureGameId: 'game-1',
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(await readSeriesManifest(result)).toMatchObject({
        status: 'failed',
        error: 'provider failed for game-1',
        gameIds: ['game-1'],
        games: [
          {
            gameId: 'game-1',
            sessions: [{ bot: 'bot-a', finished: false, modelCalls: 0, reason: 'error' }],
          },
        ],
      });
      expect(await completedGameArtifacts(result)).toEqual([]);
      expect(fixture.calls.snapshots).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given cancellation after the first game artifact is persisted, when runBatch reaches the boundary between games, then it does not start a second-game session', async () => {
    // Given
    const controller = new AbortController();
    const fixture = await createTournamentBatchFixture({
      states: [
        runningState('game-1', ['player-a']),
        runningState('game-2', ['player-a'], ['game-1', 'game-2']),
      ],
      signal: controller.signal,
      afterSnapshot: () => controller.abort(),
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(await readSeriesManifest(result)).toMatchObject({
        status: 'cancelled',
        gameIds: ['game-1'],
      });
      expect(await completedGameArtifacts(result)).toEqual([
        { path: 'games/0/manifest.json', gameId: 'game-1' },
      ]);
      expect(fixture.calls.sessions).toEqual([
        {
          gameId: 'game-1',
          botName: 'bot-a',
          signal: controller.signal,
          limits: SESSION_LIMITS,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given snapshotting the second game fails, when runBatch finalizes, then it persists a failed series manifest and only the first game artifact', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({
      states: [
        runningState('game-1', ['player-a']),
        runningState('game-2', ['player-a'], ['game-1', 'game-2']),
      ],
      snapshotFailureGameId: 'game-2',
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(await readSeriesManifest(result)).toMatchObject({
        status: 'failed',
        error: 'snapshot failed for game-2',
        gameIds: ['game-1', 'game-2'],
      });
      expect(await completedGameArtifacts(result)).toEqual([
        { path: 'games/0/manifest.json', gameId: 'game-1' },
      ]);
      expect(fixture.calls.snapshots).toEqual(['game-1', 'game-2']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given final transcript flush fails after a completed game, when runBatch finalizes, then it converts the terminal result to a failed persisted manifest', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({
      states: [runningState('game-1', ['player-a']), completedState(['game-1'])],
      failFlushCall: 2,
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(await readSeriesManifest(result)).toMatchObject({
        status: 'failed',
        error: 'transcript flush 2 failed',
        gameIds: ['game-1'],
      });
      expect(await completedGameArtifacts(result)).toEqual([
        { path: 'games/0/manifest.json', gameId: 'game-1' },
      ]);
      expect(fixture.calls.flushes).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given lifecycle polling fails after a completed game, when runTournamentSeries handles the stale id, then runBatch persists the caught failure and completed artifact', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({
      states: [runningState('game-1', ['player-a']), runningState('game-1', ['player-a'])],
      sleepFailure: 'series polling failed',
    });

    try {
      // When
      const result = await fixture.run();

      // Then
      expect(await readSeriesManifest(result)).toMatchObject({
        status: 'failed',
        error: 'series polling failed',
        gameIds: ['game-1'],
      });
      expect(await completedGameArtifacts(result)).toEqual([
        { path: 'games/0/manifest.json', gameId: 'game-1' },
      ]);
      expect(fixture.calls.sessions).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given a legacy non-tournament spec, when runBatch dispatches, then it preserves the single-game input and artifact result contract exactly', async () => {
    // Given
    const spec = legacySpec();
    const manifest = { runId: 'legacy-run', outcome: { winnerLabel: 'bot-a' } };
    const expected: RunBatchResult = {
      runDir: '/artifacts/legacy-run',
      lobbyId: 'legacy-lobby',
      gameId: 'legacy-game',
      manifest,
    };
    const legacyCalls: RunSpec[] = [];
    let tournamentCalls = 0;

    // When
    const result = await runBatch(
      spec,
      {},
      {
        runSingleGameBatch: async (input) => {
          legacyCalls.push(input);
          return expected;
        },
        runTournamentBatch: async () => {
          tournamentCalls++;
          throw new Error('tournament branch must not run for a legacy spec');
        },
      },
    );

    // Then
    expect(legacyCalls).toEqual([spec]);
    expect(tournamentCalls).toBe(0);
    expect(result).toBe(expected);
    expect(result.manifest).toBe(manifest);
  });
});

function legacySpec(): RunSpec {
  return {
    game: 'legacy-game',
    rounds: 4,
    params: { teamSize: 2 },
    server: 'http://legacy.invalid',
    identities: 'pool',
    output: '/legacy-output',
    seats: [{ persona: 'legacy', model: 'haiku', count: 1 }],
    limits: { maxModelCallsPerBot: 7, wallClockMsPerRun: 1234 },
    analysis: { enabled: true, model: 'haiku' },
    disablePlugins: ['trust'],
    label: 'legacy-label',
  };
}
