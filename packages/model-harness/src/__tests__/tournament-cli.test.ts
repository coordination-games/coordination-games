import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCampaign } from '../campaign-run.js';
import { runBatch } from '../orchestrate.js';
import type { CampaignRun } from '../types.js';
import {
  completedState,
  createTournamentBatchFixture,
  runningState,
  tournamentSpec,
} from './tournament-batch-fixture.js';

describe('tournament campaign execution', () => {
  it('Given a tournament CampaignRun, when the campaign injects canonical runBatch, then it executes without live services and writes a successful campaign index', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({
      states: [runningState('game-1', ['player-a']), completedState(['game-1'])],
    });
    const campaignRun = tournamentCampaignRun(fixture.directory, 'campaign-success');

    try {
      // When
      const exitCode = await runCampaign([campaignRun], {
        now: () => 41,
        log: () => undefined,
        error: () => undefined,
        runBatch: (spec) => runBatch(spec, { tournamentDependencies: fixture.dependencies }),
      });

      // Then
      const campaign = JSON.parse(
        await readFile(path.join(fixture.directory, 'campaign-41', 'campaign.json'), 'utf8'),
      );
      expect(exitCode).toBe(0);
      expect(campaign).toEqual({
        campaignId: 'campaign-41',
        total: 1,
        runs: [
          {
            label: 'campaign-success',
            game: 'tragedy-of-the-commons',
            status: 'ok',
            runDir: expect.stringMatching(/^run-\d+-campaign-success$/),
            lobbyId: 'lobby-fixture',
            gameId: 'game-1',
            analysis: false,
            outcome: null,
          },
        ],
      });
      expect(fixture.calls.sessions.map(({ gameId, botName }) => ({ gameId, botName }))).toEqual([
        { gameId: 'game-1', botName: 'bot-a' },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given a tournament CampaignRun whose batch fails, when the campaign completes, then it returns failure and records the exact error summary', async () => {
    // Given
    const fixture = await createTournamentBatchFixture({ states: [completedState([])] });
    const campaignRun = tournamentCampaignRun(fixture.directory, 'campaign-failure');

    try {
      // When
      const exitCode = await runCampaign([campaignRun], {
        now: () => 42,
        log: () => undefined,
        error: () => undefined,
        runBatch: async () => {
          throw new Error('deterministic batch failure');
        },
      });

      // Then
      const campaign = JSON.parse(
        await readFile(path.join(fixture.directory, 'campaign-42', 'campaign.json'), 'utf8'),
      );
      expect(exitCode).toBe(1);
      expect(campaign).toEqual({
        campaignId: 'campaign-42',
        total: 1,
        runs: [
          {
            label: 'campaign-failure',
            game: 'tragedy-of-the-commons',
            status: 'error',
            error: 'deterministic batch failure',
          },
        ],
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('Given a tournament batch returns a failed manifest, when the campaign completes, then it reports the terminal failure instead of success', async () => {
    const fixture = await createTournamentBatchFixture({ states: [completedState([])] });
    const campaignRun = tournamentCampaignRun(fixture.directory, 'manifest-failure');

    try {
      const exitCode = await runCampaign([campaignRun], {
        now: () => 43,
        log: () => undefined,
        error: () => undefined,
        runBatch: async () => ({
          runDir: path.join(fixture.directory, 'campaign-43', 'run-failed'),
          lobbyId: 'lobby-failed',
          gameId: 'game-failed',
          manifest: { status: 'failed', error: 'A player session did not finish' },
        }),
      });
      const campaign = JSON.parse(
        await readFile(path.join(fixture.directory, 'campaign-43', 'campaign.json'), 'utf8'),
      );

      expect(exitCode).toBe(1);
      expect(campaign.runs).toEqual([
        {
          label: 'manifest-failure',
          game: 'tragedy-of-the-commons',
          status: 'error',
          runDir: 'run-failed',
          lobbyId: 'lobby-failed',
          gameId: 'game-failed',
          error: 'A player session did not finish',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});

function tournamentCampaignRun(output: string, label: string): CampaignRun {
  return {
    spec: { ...tournamentSpec(output), label },
    baseLabel: label,
    repeatIndex: 1,
    repeatTotal: 1,
  };
}
