import { parse as parseYaml } from 'yaml';
import {
  MODEL_PROVIDERS,
  type ModelProvider,
  type NamedModelProfiles,
  PROVIDER_DEFAULTS,
  type Pricing,
  type ResolvedModelProfile,
} from './model-profile-types.js';
import { safeApiKeyEnv, safeBaseUrl, safeReasoningEffort } from './profile-security.js';

export const TUNING_KEYS = [
  'temperature',
  'topP',
  'maxCompletionTokens',
  'reasoningSplit',
  'reasoningEffort',
  'timeoutMs',
  'retries',
] as const;
const PROFILE_KEYS = [
  'provider',
  'model',
  'baseUrl',
  'apiKeyEnv',
  ...TUNING_KEYS,
  'pricing',
] as const;

export function parseModelProfiles(source: unknown): NamedModelProfiles {
  const root = typeof source === 'string' ? parseYaml(source, { uniqueKeys: true }) : source;
  if (!isRecord(root) || !isRecord(root.models))
    throw new Error('model profiles: "models" must be a named mapping');
  const profiles: Record<string, ResolvedModelProfile> = {};
  const names = new Set<string>();
  for (const [name, value] of Object.entries(root.models)) {
    const where = `models.${name}`;
    if (!name.trim()) throw new Error('model profiles: models.<name> must not be blank');
    if (names.has(name.trim().toLowerCase()))
      throw new Error(`model profiles: duplicate profile ${where}`);
    names.add(name.trim().toLowerCase());
    profiles[name] = parseProfile(value, where);
  }
  if (!Object.keys(profiles).length) throw new Error('model profiles: "models" must not be empty');
  return profiles;
}

export function parseTuning(
  raw: Record<string, unknown>,
  where: string,
): Omit<ResolvedModelProfile, 'provider' | 'model' | 'baseUrl' | 'apiKeyEnv' | 'pricing'> {
  return {
    ...optional(
      raw.temperature,
      `${where}.temperature`,
      (value) => value >= 0,
      false,
      'out of range',
    ),
    ...optional(
      raw.topP,
      `${where}.topP`,
      (value) => value > 0 && value <= 1,
      false,
      'out of range',
    ),
    ...optional(
      raw.maxCompletionTokens,
      `${where}.maxCompletionTokens`,
      (value) => value > 0,
      true,
      'integer in range',
    ),
    ...(raw.reasoningSplit === undefined
      ? {}
      : { reasoningSplit: boolean(raw.reasoningSplit, `${where}.reasoningSplit`) }),
    ...(raw.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: safeReasoningEffort(raw.reasoningEffort, `${where}.reasoningEffort`) }),
    ...optional(
      raw.timeoutMs,
      `${where}.timeoutMs`,
      (value) => value > 0,
      true,
      'integer in range',
    ),
    ...optional(raw.retries, `${where}.retries`, (value) => value >= 0, true, 'integer in range'),
  };
}

function parseProfile(raw: unknown, where: string): ResolvedModelProfile {
  if (!isRecord(raw)) throw new Error(`model profiles: ${where} must be an object`);
  assertKeys(raw, PROFILE_KEYS, where);
  const provider = parseProvider(raw.provider, `${where}.provider`);
  const model =
    provider === 'opencode-cli'
      ? openCodeModel(raw.model, `${where}.model`)
      : string(raw.model, `${where}.model`);
  if (
    (provider === 'claude-cli' || provider === 'opencode-cli' || provider === 'scripted') &&
    (raw.baseUrl !== undefined || raw.apiKeyEnv !== undefined)
  )
    throw new Error(`model profiles: ${where} does not allow baseUrl or apiKeyEnv`);
  if (provider === 'opencode-cli' && raw.pricing !== undefined)
    throw new Error(`model profiles: ${where} does not allow pricing`);
  if (provider === 'openai-compatible' && raw.baseUrl === undefined)
    throw new Error(`model profiles: ${where}.baseUrl is required for openai-compatible`);
  const defaults = PROVIDER_DEFAULTS[provider];
  const baseUrl =
    raw.baseUrl === undefined ? defaults.baseUrl : safeBaseUrl(raw.baseUrl, `${where}.baseUrl`);
  const apiKeyEnv =
    raw.apiKeyEnv === undefined
      ? defaults.apiKeyEnv
      : safeApiKeyEnv(raw.apiKeyEnv, baseUrl, `${where}.apiKeyEnv`);
  if (raw.apiKeyEnv === undefined && apiKeyEnv)
    safeApiKeyEnv(apiKeyEnv, baseUrl, `${where}.apiKeyEnv`);
  const pricing = parsePricing(raw.pricing, `${where}.pricing`);
  return {
    provider,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...parseTuning(raw, where),
    ...(pricing ? { pricing } : {}),
  };
}

function parsePricing(raw: unknown, where: string): Pricing | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`model profiles: ${where} must be an object`);
  assertKeys(raw, ['promptPerMillion', 'completionPerMillion'], where);
  return {
    ...optional(
      raw.promptPerMillion,
      `${where}.promptPerMillion`,
      (value) => value >= 0,
      false,
      'out of range',
    ),
    ...optional(
      raw.completionPerMillion,
      `${where}.completionPerMillion`,
      (value) => value >= 0,
      false,
      'out of range',
    ),
  };
}

function optional(
  raw: unknown,
  where: string,
  valid: (value: number) => boolean,
  integer: boolean,
  error: string,
): Record<string, number> {
  if (raw === undefined) return {};
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    (integer && !Number.isInteger(raw)) ||
    !valid(raw)
  )
    throw new Error(
      `model profiles: ${where} ${error === 'out of range' ? 'is out of range' : `must be an ${error}`}`,
    );
  return { [where.slice(where.lastIndexOf('.') + 1)]: raw };
}

function boolean(raw: unknown, where: string): boolean {
  if (typeof raw !== 'boolean') throw new Error(`model profiles: ${where} must be a boolean`);
  return raw;
}
function string(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || !raw.trim())
    throw new Error(`model profiles: ${where} must be a non-empty string`);
  return raw.trim();
}
function openCodeModel(raw: unknown, where: string): string {
  const value = string(raw, where);
  const segments = value.split('/');
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9@][A-Za-z0-9._:@+-]*$/.test(segment) || segment === '.' || segment === '..',
    )
  ) {
    throw new Error(`model profiles: ${where} must use a safe provider/model identifier`);
  }
  return value;
}
function parseProvider(raw: unknown, where: string): ModelProvider {
  if (typeof raw !== 'string' || !(MODEL_PROVIDERS as readonly string[]).includes(raw))
    throw new Error(`model profiles: ${where} must be one of ${MODEL_PROVIDERS.join(', ')}`);
  return raw as ModelProvider;
}
function assertKeys(raw: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(raw))
    if (!allowed.includes(key)) throw new Error(`model profiles: ${where}.${key} is not allowed`);
}
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}
