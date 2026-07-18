import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../spec.js';

describe('aggregate micro-USD run limit', () => {
  it('Given a configured aggregate micro-USD cap, when loading a campaign, then it preserves the integer cap while old limits keep their defaults', async () => {
    // Given
    const directory = await mkdtemp(path.join(tmpdir(), 'harness-run-limits-'));
    const filePath = path.join(directory, 'campaign.yaml');
    await writeFile(
      filePath,
      'globals:\n  limits: { maxAggregateCostMicrousd: 17 }\ngames:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, model: minimax/test }]\n',
    );

    // When
    const [run] = await loadCampaign(filePath);

    // Then
    expect(run?.spec.limits).toEqual({
      maxModelCallsPerBot: 80,
      wallClockMsPerRun: 600_000,
      maxAggregateCostMicrousd: 17,
    });
  });
});
