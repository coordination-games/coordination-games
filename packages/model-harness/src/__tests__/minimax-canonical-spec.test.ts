import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../spec.js';
import { isTournamentRun } from '../tournament-types.js';

describe('canonical MiniMax tournament', () => {
  it('Given the checked-in specification, when loading, then it uses only the Token Plan OpenCode profile', async () => {
    const canonical = fileURLToPath(
      new URL('../../../../runs/minimax-m3-tournament.yaml', import.meta.url),
    );

    const runs = await loadCampaign(canonical);

    expect(runs).toHaveLength(1);
    const spec = runs[0]?.spec;
    expect(spec && isTournamentRun(spec)).toBe(true);
    if (!spec || !isTournamentRun(spec)) throw new Error('canonical run is not a tournament');
    expect(spec.params).toEqual({ teamSize: 3 });
    expect(spec.limits.maxModelCallsPerBot).toBe(30);
    expect(spec.tournament.policy).toMatchObject({
      seriesLength: 2,
      minRounds: 2,
      maxRounds: 3,
      hazardNumerator: 1,
      hazardDenominator: 2,
    });
    expect(spec.seats).toEqual([
      expect.objectContaining({
        model: 'minimax-coding-plan/MiniMax-M3',
        count: 2,
        modelConfig: {
          provider: 'opencode-cli',
          model: 'minimax-coding-plan/MiniMax-M3',
          maxCompletionTokens: 512,
          reasoningEffort: 'none',
        },
      }),
      expect.objectContaining({
        model: 'minimax-coding-plan/MiniMax-M3',
        count: 1,
        modelConfig: {
          provider: 'opencode-cli',
          model: 'minimax-coding-plan/MiniMax-M3',
          maxCompletionTokens: 512,
          reasoningEffort: 'none',
        },
      }),
    ]);
  });
});
