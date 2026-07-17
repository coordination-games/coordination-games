import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderDryRunPlan } from '../dry-run-plan.js';
import { loadCampaign } from '../spec.js';

describe('tournament campaign specifications', () => {
  it('Given a tragedy series entry, when loading the campaign, then it preserves the worker tournament request and repeats the complete series', async () => {
    await withCampaign(
      `models:
  minimax-m3:
    provider: minimax
    model: MiniMax-M3
games:
  - label: minimax-series
    game: tragedy-of-the-commons
    repeats: 2
    params: { teamSize: 4 }
    tournament:
      mode: tragedy-series
      policy:
        seriesLength: 3
        baseEntryCost: "100"
        carryBps: 1500
        slashBps: 500
        minRounds: 2
        maxRounds: 8
        hazardNumerator: 1
        hazardDenominator: 4
    seats:
      - { persona: mediator, profile: minimax-m3, count: 2 }
      - { persona: opportunist, profile: minimax-m3, count: 2 }
`,
      async (filePath) => {
        const runs = await loadCampaign(filePath);

        expect(runs).toHaveLength(2);
        const plan = renderDryRunPlan(runs);
        expect(plan).toContain('maximum model sessions: 24');
        expect(plan).toContain('[4 minimax]');
        expect(plan).toContain('profile=minimax-m3 provider=minimax model=MiniMax-M3');
        expect(runs.map((run) => run.spec)).toEqual([
          {
            kind: 'tournament',
            game: 'tragedy-of-the-commons',
            rounds: 8,
            params: { teamSize: 4 },
            server: 'http://localhost:8787',
            identities: 'ephemeral',
            output: './runs/out',
            seats: [
              {
                persona: 'mediator',
                profile: 'minimax-m3',
                model: 'MiniMax-M3',
                count: 2,
                modelConfig: {
                  provider: 'minimax',
                  model: 'MiniMax-M3',
                  baseUrl: 'https://api.minimax.io/v1',
                  apiKeyEnv: 'MINIMAX_API_KEY',
                },
              },
              {
                persona: 'opportunist',
                profile: 'minimax-m3',
                model: 'MiniMax-M3',
                count: 2,
                modelConfig: {
                  provider: 'minimax',
                  model: 'MiniMax-M3',
                  baseUrl: 'https://api.minimax.io/v1',
                  apiKeyEnv: 'MINIMAX_API_KEY',
                },
              },
            ],
            limits: { maxModelCallsPerBot: 80, wallClockMsPerRun: 600_000 },
            tournament: {
              mode: 'tragedy-series',
              policy: {
                seriesLength: 3,
                baseEntryCost: '100',
                carryBps: 1500,
                slashBps: 500,
                minRounds: 2,
                maxRounds: 8,
                hazardNumerator: 1,
                hazardDenominator: 4,
              },
            },
            label: 'minimax-series-r1',
          },
          expect.objectContaining({ label: 'minimax-series-r2' }),
        ]);
      },
    );
  });

  it('Given a tournament campaign, when rendering the dry run, then it exposes series policy, seat profiles, and the maximum session count', async () => {
    await withCampaign(tournamentYaml(), async (filePath) => {
      const plan = renderDryRunPlan(await loadCampaign(filePath));

      expect(plan).toContain('kind=tournament');
      expect(plan).toContain('seriesGames=3');
      expect(plan).toContain('hidden rounds=2-8 hazard=1/4 maxRounds=8');
      expect(plan).toContain('economics baseEntryCost=100 carryBps=1500 slashBps=500');
      expect(plan).toContain('seats p ×1 -> haiku');
      expect(plan).toContain('maximum model sessions: 3');
    });
  });

  it('Given mixed profile and model seats, when rendering a tournament, then it counts each resolved display provider', async () => {
    await withCampaign(
      `models:
  minimax-m3:
    provider: minimax
    model: MiniMax-M3
games:
  - game: tragedy-of-the-commons
    tournament:
      mode: tragedy-series
      policy:
        seriesLength: 1
        baseEntryCost: "100"
        carryBps: 0
        slashBps: 0
        minRounds: 1
        maxRounds: 2
        hazardNumerator: 1
        hazardDenominator: 2
    seats:
      - { persona: p, profile: minimax-m3, count: 2 }
      - { persona: p, model: haiku }
`,
      async (filePath) => {
        const plan = renderDryRunPlan(await loadCampaign(filePath));

        expect(plan).toContain('[2 minimax, 1 claude]');
      },
    );
  });

  it.each([
    ['seriesLength', 'seriesLength: 3', 'seriesLength: 0'],
    ['baseEntryCost', 'baseEntryCost: "100"', 'baseEntryCost: 100'],
    ['carryBps', 'carryBps: 1500', 'carryBps: 1.5'],
    ['slashBps', 'slashBps: 500', 'slashBps: -1'],
    ['minRounds', 'minRounds: 2', 'minRounds: 0'],
    ['maxRounds', 'maxRounds: 8', 'maxRounds: 65536'],
    ['hazardNumerator', 'hazardNumerator: 1', 'hazardNumerator: -1'],
    ['hazardDenominator', 'hazardDenominator: 4', 'hazardDenominator: 0'],
  ])('Given an invalid %s policy field, when loading a tournament, then it reports that field', async (field, current, replacement) => {
    await withCampaign(tournamentYaml().replace(current, replacement), async (filePath) => {
      await expect(loadCampaign(filePath)).rejects.toThrow(
        new RegExp(`games\\[0\\]\\.tournament\\.policy\\.${field}`),
      );
    });
  });

  it.each([
    [
      'authored rounds',
      (yaml: string) => yaml.replace('    tournament:', '    rounds: 3\n    tournament:'),
      /games\[0\]\.rounds/,
    ],
    [
      'non-tragedy game',
      (yaml: string) => yaml.replace('tragedy-of-the-commons', 'capture-the-lobster'),
      /games\[0\]\.game.*tragedy-of-the-commons/,
    ],
    [
      'unknown tournament key',
      (yaml: string) => yaml.replace('      mode:', '      unexpected: true\n      mode:'),
      /games\[0\]\.tournament\.unexpected/,
    ],
    [
      'unknown policy key',
      (yaml: string) =>
        yaml.replace('        seriesLength:', '        unexpected: true\n        seriesLength:'),
      /games\[0\]\.tournament\.policy\.unexpected/,
    ],
    [
      'bad bigint string',
      (yaml: string) => yaml.replace('baseEntryCost: "100"', 'baseEntryCost: "01"'),
      /games\[0\]\.tournament\.policy\.baseEntryCost/,
    ],
    [
      'round range',
      (yaml: string) => yaml.replace('minRounds: 2', 'minRounds: 9'),
      /games\[0\]\.tournament\.policy\.minRounds/,
    ],
    [
      'hazard range',
      (yaml: string) => yaml.replace('hazardNumerator: 1', 'hazardNumerator: 5'),
      /games\[0\]\.tournament\.policy\.hazardNumerator/,
    ],
    [
      'economics range',
      (yaml: string) => yaml.replace('slashBps: 500', 'slashBps: 9001'),
      /games\[0\]\.tournament\.policy/,
    ],
  ])('Given %s, when loading a tournament, then it reports the located invalid field', async (_name, mutate, error) => {
    const yaml = mutate(tournamentYaml());
    await withCampaign(yaml, async (filePath) => {
      await expect(loadCampaign(filePath)).rejects.toThrow(error);
    });
  });
});

function tournamentYaml(): string {
  return `games:
  - game: tragedy-of-the-commons
    tournament:
      mode: tragedy-series
      policy:
        seriesLength: 3
        baseEntryCost: "100"
        carryBps: 1500
        slashBps: 500
        minRounds: 2
        maxRounds: 8
        hazardNumerator: 1
        hazardDenominator: 4
    seats: [{ persona: p, model: haiku }]
`;
}

async function withCampaign(
  yaml: string,
  assertion: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-harness-tournament-'));
  const filePath = path.join(directory, 'campaign.yaml');
  await writeFile(filePath, yaml);
  try {
    await assertion(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
