import path from 'node:path';
import type { LegacyImportDefaults } from './legacy-bot-config-importer.js';
import { MODEL_PROVIDERS, type ModelProvider } from './model-profiles.js';

const IMPORT_FLAGS = [
  '--default-provider',
  '--default-model',
  '--default-base-url',
  '--default-api-key-env',
  '--output',
] as const;

export type ImportBotConfigArgs = {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly defaults: LegacyImportDefaults;
};

export class ImportBotConfigArgumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ImportBotConfigArgumentError';
  }
}

export function parseImportBotConfigArgs(
  argv: readonly string[],
  cwd: string,
): ImportBotConfigArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let provider: ModelProvider | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let apiKeyEnv: string | undefined;
  let output: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (!isImportFlag(arg)) {
      throw new ImportBotConfigArgumentError(`unknown import-bot-config flag: ${arg}`);
    }
    if (flags.has(arg)) {
      throw new ImportBotConfigArgumentError(`duplicate import-bot-config flag: ${arg}`);
    }
    flags.add(arg);
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || !value.trim()) {
      throw new ImportBotConfigArgumentError(`${arg} requires a non-empty value`);
    }
    index += 1;

    switch (arg) {
      case '--default-provider':
        provider = parseProvider(value);
        break;
      case '--default-model':
        model = value.trim();
        break;
      case '--default-base-url':
        baseUrl = value.trim();
        break;
      case '--default-api-key-env':
        apiKeyEnv = value.trim();
        break;
      case '--output':
        output = value.trim();
        break;
    }
  }

  const input = positionals[0];
  if (!input) {
    throw new ImportBotConfigArgumentError('`import-bot-config` requires a <legacy.json> path');
  }
  if (positionals.length > 1) {
    throw new ImportBotConfigArgumentError(
      '`import-bot-config` accepts exactly one <legacy.json> path',
    );
  }

  return {
    inputPath: path.resolve(cwd, input),
    outputPath: path.resolve(cwd, output ?? 'model-profiles.yaml'),
    defaults: {
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    },
  };
}

function isImportFlag(value: string): value is (typeof IMPORT_FLAGS)[number] {
  for (const flag of IMPORT_FLAGS) {
    if (flag === value) return true;
  }
  return false;
}

function parseProvider(value: string): ModelProvider {
  for (const provider of MODEL_PROVIDERS) {
    if (provider === value) return provider;
  }
  throw new ImportBotConfigArgumentError(
    `unsupported default provider "${value}"; use one of: ${MODEL_PROVIDERS.join(', ')}`,
  );
}
