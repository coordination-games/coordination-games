import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ImportBotConfigArgumentError,
  parseImportBotConfigArgs,
} from '../import-bot-config-cli-args.js';

describe('import bot config CLI arguments', () => {
  it('Given explicit legacy defaults and output, when parsing, then it resolves paths from the caller cwd', () => {
    const cwd = path.join(path.sep, 'tmp', 'caller');

    const parsed = parseImportBotConfigArgs(
      [
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
        'nested/profiles.yaml',
      ],
      cwd,
    );

    expect(parsed).toEqual({
      inputPath: path.join(cwd, 'bots.json'),
      outputPath: path.join(cwd, 'nested', 'profiles.yaml'),
      defaults: {
        provider: 'minimax',
        model: 'MiniMax-M3',
        baseUrl: 'https://api.minimax.io/v1',
        apiKeyEnv: 'HARNESS_MINIMAX_API_KEY',
      },
    });
  });

  it('Given no output flag, when parsing, then it writes model profiles in the caller cwd', () => {
    const cwd = path.join(path.sep, 'tmp', 'caller');

    const parsed = parseImportBotConfigArgs(['bots.json'], cwd);

    expect(parsed.outputPath).toBe(path.join(cwd, 'model-profiles.yaml'));
  });

  it.each([
    ['missing output value', ['bots.json', '--output']],
    ['missing default model value', ['bots.json', '--default-model']],
    ['blank default provider', ['bots.json', '--default-provider', '   ']],
    ['duplicate output', ['bots.json', '--output', 'a.yaml', '--output', 'b.yaml']],
    ['unknown flag', ['bots.json', '--mystery', 'value']],
    ['extra positional', ['bots.json', 'extra.json']],
    ['unsupported provider', ['bots.json', '--default-provider', 'opencode-go']],
  ])('Given %s, when parsing, then it rejects before import', (_name, argv) => {
    expect(() => parseImportBotConfigArgs(argv, path.join(path.sep, 'tmp', 'caller'))).toThrow(
      ImportBotConfigArgumentError,
    );
  });
});
