import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { MODEL_PROVIDERS, type ModelProvider, parseModelProfiles } from './model-profiles.js';

const PROFILE_KEYS = [
  'provider',
  'model',
  'baseUrl',
  'openAiBaseUrl',
  'apiKeyEnv',
  'temperature',
  'topP',
  'maxCompletionTokens',
  'reasoningSplit',
  'reasoningEffort',
  'timeoutMs',
  'retries',
  'pricing',
] as const;
const PERSONA_KEYS = ['id', 'title', 'instruction', 'publicStyle', 'privateStyle'] as const;
const ALLOWED_KEYS = ['name', ...PROFILE_KEYS, ...PERSONA_KEYS] as const;

export type LegacyImportDefaults = {
  readonly provider?: ModelProvider;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxCompletionTokens?: number;
  readonly reasoningSplit?: boolean;
  readonly reasoningEffort?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly pricing?: unknown;
};

export type LegacyImportResult = {
  readonly profileNames: readonly string[];
  readonly omittedPersonaFields: Readonly<Record<string, readonly string[]>>;
};

export async function importBotConfig(
  inputPath: string,
  outputPath: string,
  defaults: LegacyImportDefaults = {},
): Promise<LegacyImportResult> {
  const parsed = parseJson(await fs.readFile(inputPath, 'utf8'));
  const models: Record<string, Record<string, unknown>> = {};
  const omittedPersonaFields: Record<string, readonly string[]> = {};
  const names = new Set<string>();
  for (const [index, entry] of bots(parsed).entries()) {
    const { name, profile, omitted } = parseEntry(entry, index, defaults);
    const normalized = name.toLowerCase();
    if (names.has(normalized))
      throw new Error(`legacy bot config: duplicate generated name "${name}"`);
    names.add(normalized);
    models[name] = profile;
    if (omitted.length) omittedPersonaFields[name] = omitted;
  }
  const canonical = { models };
  parseModelProfiles(canonical);
  const temporary = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.tmp`,
  );
  try {
    await fs.writeFile(temporary, stringifyYaml(canonical), 'utf8');
    await fs.rename(temporary, outputPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { profileNames: Object.keys(models), omittedPersonaFields };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('legacy bot config must be valid JSON');
  }
}
function bots(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw) && raw.length) return raw;
  if (record(raw) && Array.isArray(raw.bots) && raw.bots.length) return raw.bots;
  throw new Error(
    'legacy bot config must be a non-empty array or an object with a non-empty bots array',
  );
}
function parseEntry(
  raw: unknown,
  index: number,
  defaults: LegacyImportDefaults,
): { name: string; profile: Record<string, unknown>; omitted: readonly string[] } {
  const where = `legacy bot config: bots[${index}]`;
  if (!record(raw)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(raw))
    if (!(ALLOWED_KEYS as readonly string[]).includes(key))
      throw new Error(`${where}.${key} is not supported`);
  if (raw.baseUrl !== undefined && raw.openAiBaseUrl !== undefined)
    throw new Error(`${where} cannot contain both baseUrl and openAiBaseUrl`);
  if (raw.provider === 'opencode-go')
    throw new Error(
      `${where}.provider opencode-go is unsupported; migrate to openai-compatible with an explicit loopback baseUrl and HARNESS_*_API_KEY policy`,
    );
  const name = string(raw.name, `${where}.name`);
  const profile = {
    ...defaults,
    ...pickProfile(raw),
    ...(raw.openAiBaseUrl === undefined
      ? {}
      : { baseUrl: string(raw.openAiBaseUrl, `${where}.openAiBaseUrl`) }),
  };
  if (
    typeof profile.provider !== 'string' ||
    !(MODEL_PROVIDERS as readonly string[]).includes(profile.provider)
  )
    throw new Error(`${where}.provider requires an explicit approved default`);
  if (typeof profile.model !== 'string' || !profile.model.trim())
    throw new Error(`${where}.model requires an explicit non-empty default`);
  strictScalars(profile, where);
  return { name, profile, omitted: PERSONA_KEYS.filter((key) => raw[key] !== undefined) };
}
function pickProfile(raw: Record<string, unknown>): Record<string, unknown> {
  const profile: Record<string, unknown> = {};
  for (const key of PROFILE_KEYS)
    if (key !== 'openAiBaseUrl' && raw[key] !== undefined) profile[key] = raw[key];
  return profile;
}
function strictScalars(profile: Record<string, unknown>, where: string): void {
  for (const key of ['baseUrl', 'apiKeyEnv', 'reasoningEffort'] as const)
    if (profile[key] !== undefined) string(profile[key], `${where}.${key}`);
  for (const key of ['temperature', 'topP', 'maxCompletionTokens', 'timeoutMs', 'retries'] as const)
    if (
      profile[key] !== undefined &&
      (typeof profile[key] !== 'number' || !Number.isFinite(profile[key]))
    )
      throw new Error(`${where}.${key} must be a finite number`);
  if (profile.reasoningSplit !== undefined && typeof profile.reasoningSplit !== 'boolean')
    throw new Error(`${where}.reasoningSplit must be a boolean`);
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${where} must be a non-empty string`);
  return value.trim();
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
