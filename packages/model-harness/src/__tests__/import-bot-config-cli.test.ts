import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseModelProfiles } from '../model-profiles.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'index.ts');
const PRIVATE_VALUE = 'private-value-must-not-appear';
const PERSONA_PROSE = 'persona prose must not reach command output';

describe('import-bot-config CLI', () => {
  it('Given persona-only bots and explicit defaults/output, when invoking the real CLI, then it writes reparsable profiles without leaking private input', async () => {
    await withTempDirectory(async (directory) => {
      await writeFile(
        path.join(directory, 'bots.json'),
        JSON.stringify([
          {
            name: 'm3',
            title: PERSONA_PROSE,
            instruction: PRIVATE_VALUE,
          },
        ]),
      );

      const result = runCli(directory, [
        'bots.json',
        '--default-provider',
        'minimax',
        '--default-model',
        'MiniMax-M3',
        '--default-base-url',
        'https://api.minimax.io/v1',
        '--default-api-key-env',
        'HARNESS_MINIMAX_API_KEY',
        '--output',
        'explicit-profiles.yaml',
      ]);

      expect(result.status).toBe(0);
      const outputPath = path.join(directory, 'explicit-profiles.yaml');
      expect(parseModelProfiles(await readFile(outputPath, 'utf8'))).toEqual(
        parseModelProfiles({
          models: {
            m3: {
              provider: 'minimax',
              model: 'MiniMax-M3',
              baseUrl: 'https://api.minimax.io/v1',
              apiKeyEnv: 'HARNESS_MINIMAX_API_KEY',
            },
          },
        }),
      );
      expect(result.stdout).toContain(outputPath);
      expect(result.stdout).toContain('m3');
      expect(result.stdout).toContain('title, instruction');
      expect(`${result.stdout}${result.stderr}`).not.toContain(PERSONA_PROSE);
      expect(`${result.stdout}${result.stderr}`).not.toContain(PRIVATE_VALUE);
      expect(`${result.stdout}${result.stderr}`).not.toContain('ignored-env-secret');
    });
  });

  it('Given explicit bot profiles and no output flag, when invoking the real CLI, then it writes model-profiles.yaml in the caller cwd', async () => {
    await withTempDirectory(async (directory) => {
      await writeFile(
        path.join(directory, 'bots.json'),
        JSON.stringify({
          bots: [{ name: 'fixture', provider: 'scripted', model: 'fixture-model' }],
        }),
      );

      const result = runCli(directory, ['bots.json']);

      expect(result.status).toBe(0);
      const outputPath = path.join(directory, 'model-profiles.yaml');
      expect(parseModelProfiles(await readFile(outputPath, 'utf8'))).toEqual(
        parseModelProfiles({
          models: { fixture: { provider: 'scripted', model: 'fixture-model' } },
        }),
      );
      expect(result.stdout).toContain(outputPath);
    });
  });

  it.each([
    ['missing output value', ['bots.json', '--output']],
    ['missing default value', ['bots.json', '--default-model']],
    ['unknown flag', ['bots.json', '--unknown', 'value']],
    ['duplicate flag', ['bots.json', '--output', 'one.yaml', '--output', 'two.yaml']],
    ['extra positional', ['bots.json', 'extra.json']],
  ])('Given %s, when invoking the real CLI, then it fails before writing output', async (_name, argv) => {
    await withTempDirectory(async (directory) => {
      await writeFile(path.join(directory, 'bots.json'), '[]');

      const result = runCli(directory, argv);

      expect(result.status).toBe(1);
      await expect(readFile(path.join(directory, 'model-profiles.yaml'), 'utf8')).rejects.toThrow();
    });
  });

  it('Given malformed input or opencode-go, when invoking the real CLI, then it preserves an existing output', async () => {
    await withTempDirectory(async (directory) => {
      const inputPath = path.join(directory, 'bots.json');
      const outputPath = path.join(directory, 'profiles.yaml');
      await writeFile(outputPath, 'preserve');

      await writeFile(inputPath, '{ malformed');
      const malformed = runCli(directory, ['bots.json', '--output', 'profiles.yaml']);
      expect(malformed.status).toBe(1);
      expect(`${malformed.stdout}${malformed.stderr}`).toContain('valid JSON');
      await expect(readFile(outputPath, 'utf8')).resolves.toBe('preserve');

      await writeFile(
        inputPath,
        JSON.stringify([{ name: 'unsupported', provider: 'opencode-go', model: 'ignored' }]),
      );
      const unsupported = runCli(directory, ['bots.json', '--output', 'profiles.yaml']);
      expect(unsupported.status).toBe(1);
      expect(`${unsupported.stdout}${unsupported.stderr}`).toContain('opencode-go is unsupported');
      await expect(readFile(outputPath, 'utf8')).resolves.toBe('preserve');
    });
  });
});

function runCli(cwd: string, args: readonly string[]) {
  return spawnSync('npx', ['tsx', CLI_PATH, 'import-bot-config', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      BOT_CONFIG: 'environment-config-must-not-be-read',
      HARNESS_IMPORT_TEST_SECRET: 'ignored-env-secret',
    },
    shell: false,
  });
}

async function withTempDirectory(assertion: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'import-bot-config-cli-'));
  try {
    await assertion(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
