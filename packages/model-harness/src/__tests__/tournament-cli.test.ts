import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'index.ts');

describe('tournament CLI preflight', () => {
  it('Given a tournament execution request, when invoking the CLI without dry-run, then it fails before creating campaign output', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-harness-tournament-cli-'));
    try {
      const specPath = path.join(directory, 'tournament.yaml');
      await writeFile(specPath, tournamentYaml());

      const result = spawnSync('npx', ['tsx', CLI_PATH, 'run', specPath], {
        cwd: directory,
        encoding: 'utf8',
        shell: false,
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        'Tournament execution is not implemented',
      );
      await expect(readdir(path.join(directory, 'output'))).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function tournamentYaml(): string {
  return `globals:
  output: ./output
games:
  - game: tragedy-of-the-commons
    tournament:
      mode: tragedy-series
      policy:
        seriesLength: 1
        baseEntryCost: "1"
        carryBps: 0
        slashBps: 0
        minRounds: 1
        maxRounds: 1
        hazardNumerator: 0
        hazardDenominator: 1
    seats: [{ persona: p, model: haiku }]
`;
}
