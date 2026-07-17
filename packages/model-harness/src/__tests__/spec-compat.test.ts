import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandSeatPlan, loadCampaign } from '../spec.js';
import expectedCampaigns from './fixtures/campaign-compat.json' with { type: 'json' };

const repositoryRoot = path.resolve(import.meta.dirname, '../../../..');

const campaignFixtures = [
  ['campaign-example', 'runs/campaign-example.yaml'],
  ['claude-totc', 'runs/claude-totc.yaml'],
  ['treachery-study', 'runs/treachery-study.yaml'],
] as const;

describe('Lucian campaign specification compatibility', () => {
  it.each(
    campaignFixtures,
  )('Given %s, when loading its campaign and normalized dry-run plan, then it retains every resolved run', async (fixtureName, relativePath) => {
    const expected = expectedCampaigns[fixtureName];
    const runs = await loadCampaign(path.join(repositoryRoot, relativePath));

    expect(runs).toEqual(expected.runs);
    expect(runs).toHaveLength(expected.runCount);
    expect(runs.map((run) => expandSeatPlan(run.spec))).toEqual(expected.seatPlans);
  });

  it('Given partial globals and a plugin ablation, when loading a campaign, then it applies the existing defaults and preserves per-game controls', async () => {
    await withTemporaryCampaign(
      [
        'globals:',
        '  limits: { maxModelCallsPerBot: 9 }',
        '  analysis: {}',
        'games:',
        '  - label: defaults',
        '    game: defaults',
        '    rounds: 1',
        '    repeats: 2',
        '    disablePlugins: [trust-projector]',
        '    seats:',
        '      - { persona: ./personas/test, model: haiku }',
        '',
      ].join('\n'),
      async (filePath) => {
        const runs = await loadCampaign(filePath);
        expect(runs).toEqual([
          {
            spec: {
              game: 'defaults',
              rounds: 1,
              params: {},
              server: 'http://localhost:8787',
              identities: 'ephemeral',
              output: './runs/out',
              seats: [{ persona: './personas/test', model: 'haiku', count: 1 }],
              limits: { maxModelCallsPerBot: 9, wallClockMsPerRun: 600_000 },
              analysis: { enabled: true, model: 'anthropic/claude-sonnet' },
              disablePlugins: ['trust-projector'],
              label: 'defaults-r1',
            },
            baseLabel: 'defaults',
            repeatIndex: 1,
            repeatTotal: 2,
          },
          {
            spec: {
              game: 'defaults',
              rounds: 1,
              params: {},
              server: 'http://localhost:8787',
              identities: 'ephemeral',
              output: './runs/out',
              seats: [{ persona: './personas/test', model: 'haiku', count: 1 }],
              limits: { maxModelCallsPerBot: 9, wallClockMsPerRun: 600_000 },
              analysis: { enabled: true, model: 'anthropic/claude-sonnet' },
              disablePlugins: ['trust-projector'],
              label: 'defaults-r2',
            },
            baseLabel: 'defaults',
            repeatIndex: 2,
            repeatTotal: 2,
          },
        ]);
      },
    );
  });

  it.each([
    [
      'unknown game key',
      'games:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, model: haiku }]\n    unexpected: true\n',
      /"unexpected" is not allowed in games\[0\]/,
    ],
    [
      'unknown globals key',
      'globals: { unexpected: true }\ngames:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, model: haiku }]\n',
      /"unexpected" is not allowed in globals/,
    ],
    [
      'global key misplaced in a game',
      'games:\n  - game: test\n    rounds: 1\n    server: http://example.test\n    seats: [{ persona: p, model: haiku }]\n',
      /"server" is not allowed in games\[0\]/,
    ],
    [
      'game key misplaced in globals',
      'globals: { rounds: 1 }\ngames:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, model: haiku }]\n',
      /"rounds" is not allowed in globals/,
    ],
  ])('Given %s, when loading the campaign, then it reports the located partition error', async (_name, yaml, message) => {
    await withTemporaryCampaign(yaml, async (filePath) => {
      await expect(loadCampaign(filePath)).rejects.toThrow(message);
    });
  });

  it('Given an unknown root key, when loading a campaign, then it preserves the current permissive root behavior', async () => {
    await withTemporaryCampaign(
      'legacyRootMetadata: retained\ngames:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, model: haiku }]\n',
      async (filePath) => {
        await expect(loadCampaign(filePath)).resolves.toHaveLength(1);
      },
    );
  });
});

async function withTemporaryCampaign(
  yaml: string,
  assertion: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-harness-spec-'));
  const filePath = path.join(directory, 'campaign.yaml');
  await writeFile(filePath, yaml);
  try {
    await assertion(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
