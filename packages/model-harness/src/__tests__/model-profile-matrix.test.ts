import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseModelProfiles, resolveModelProfile } from '../model-profiles.js';
import { loadCampaign } from '../spec.js';

const minimax = { provider: 'minimax', model: 'MiniMax-M3' } as const;
const minimaxResolved = {
  provider: 'minimax',
  model: 'MiniMax-M3',
  baseUrl: 'https://api.minimax.io/v1',
  apiKeyEnv: 'MINIMAX_API_KEY',
};

// biome-ignore format: compact table rows keep the validation matrix scannable.
describe('model profile resolution matrix', () => {
  it.each([
    ['claude-cli', { provider: 'claude-cli', model: 'claude-haiku' }, { provider: 'claude-cli', model: 'claude-haiku' }],
    ['opencode-cli', { provider: 'opencode-cli', model: 'minimax-coding-plan/MiniMax-M3' }, { provider: 'opencode-cli', model: 'minimax-coding-plan/MiniMax-M3' }],
    ['openrouter', { provider: 'openrouter', model: 'openai/gpt-5' }, { provider: 'openrouter', model: 'openai/gpt-5', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' }],
    ['minimax', minimax, minimaxResolved],
    ['future MiniMax', { provider: 'minimax', model: 'MiniMax-M4-preview' }, { ...minimaxResolved, model: 'MiniMax-M4-preview' }],
    ['custom HTTPS', { provider: 'openai-compatible', model: 'custom', baseUrl: 'https://models.example/v1', apiKeyEnv: 'HARNESS_MODELS_API_KEY' }, { provider: 'openai-compatible', model: 'custom', baseUrl: 'https://models.example/v1', apiKeyEnv: 'HARNESS_MODELS_API_KEY' }],
    ['loopback HTTP', { provider: 'openai-compatible', model: 'local', baseUrl: 'http://localhost:8080/v1', apiKeyEnv: 'HARNESS_LOCAL_API_KEY' }, { provider: 'openai-compatible', model: 'local', baseUrl: 'http://localhost:8080/v1', apiKeyEnv: 'HARNESS_LOCAL_API_KEY' }],
    ['scripted', { provider: 'scripted', model: 'fixture' }, { provider: 'scripted', model: 'fixture' }],
  ] as const)('Given %s, when parsing, then it deep-resolves the provider contract', (_name, profile, expected) => {
    expect(parseModelProfiles({ models: { profile } }).profile).toEqual(expected);
  });

  it('Given unrelated environment changes and BOT_CONFIG, when parsing twice, then it is deterministic and restores the environment', () => {
    const keys = ['BOT_CONFIG', 'HARNESS_MATRIX_UNRELATED'] as const;
    const before = keys.map((key) => ({ key, present: Object.hasOwn(process.env, key), value: process.env[key] }));
    try {
      process.env.BOT_CONFIG = 'models: { ignored: { apiKey: not-read } }';
      process.env.HARNESS_MATRIX_UNRELATED = 'changed';
      const source = { models: { profile: { ...minimax, temperature: 0.2 } } };
      const first = resolveModelProfile(parseModelProfiles(source), 'profile', {}, 'games[0].seats[0]');
      const second = resolveModelProfile(parseModelProfiles(source), 'profile', {}, 'games[0].seats[0]');
      expect(first).toEqual(second);
      expect(first).toEqual({ ...minimaxResolved, temperature: 0.2 });
    } finally {
      for (const entry of before) {
        if (entry.present && entry.value !== undefined) process.env[entry.key] = entry.value;
        else delete process.env[entry.key];
      }
    }
    expect(keys.map((key) => ({ key, present: Object.hasOwn(process.env, key), value: process.env[key] }))).toEqual(before);
  });

  it.each([
    ['misspelled root key', 'modles: {}\ngames:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, model: m }]\n', /"modles" is not allowed in root/],
    ['empty models', { models: {} }, /"models" must not be empty/],
    ['blank profile name', { models: { ' ': minimax } }, /models\.<name>/],
    ['case-colliding names', { models: { M3: minimax, m3: minimax } }, /models\.m3/],
    ['non-object profile', { models: { m3: 'not-an-object' } }, /models\.m3 must be an object/],
    ['unknown profile key', { models: { m3: { ...minimax, unexpected: true } } }, /models\.m3\.unexpected/],
    ['raw secret profile field', { models: { m3: { ...minimax, apiKey: 'not-a-secret' } } }, /models\.m3\.apiKey/],
    ['blank model', { models: { m3: { ...minimax, model: ' ' } } }, /models\.m3\.model/],
    ['unknown provider', { models: { m3: { ...minimax, provider: 'unknown' } } }, /models\.m3\.provider/],
  ] as const)('Given %s, when parsing profiles, then it reports the full failing path', async (_name, source, error) => {
    if (typeof source === 'string') await withCampaign(source, async (filePath) => expect(loadCampaign(filePath)).rejects.toThrow(error));
    else expect(() => parseModelProfiles(source)).toThrow(error);
  });

  it.each([
    ['malformed URL', { baseUrl: 'not a URL' }, /models\.m3\.baseUrl/],
    ['non-loopback HTTP', { baseUrl: 'http://models.example/v1' }, /models\.m3\.baseUrl/],
    ['URL credentials', { baseUrl: 'https://user@models.example/v1' }, /models\.m3\.baseUrl/],
    ['URL query', { baseUrl: 'https://models.example/v1?debug=true' }, /models\.m3\.baseUrl/],
    ['URL fragment', { baseUrl: 'https://models.example/v1#debug' }, /models\.m3\.baseUrl/],
    ['trusted key on wrong host', { provider: 'openai-compatible', baseUrl: 'https://models.example/v1', apiKeyEnv: 'OPENROUTER_API_KEY' }, /models\.m3\.apiKeyEnv/],
    ['invalid custom key name', { provider: 'openai-compatible', baseUrl: 'https://models.example/v1', apiKeyEnv: 'CUSTOM_API_KEY' }, /models\.m3\.apiKeyEnv/],
    ['URL on Claude CLI', { provider: 'claude-cli', baseUrl: 'https://models.example/v1' }, /models\.m3/],
    ['key on Claude CLI', { provider: 'claude-cli', apiKeyEnv: 'HARNESS_CLAUDE_API_KEY' }, /models\.m3/],
    ['URL on OpenCode CLI', { provider: 'opencode-cli', model: 'minimax-coding-plan/MiniMax-M3', baseUrl: 'https://models.example/v1' }, /models\.m3/],
    ['key on OpenCode CLI', { provider: 'opencode-cli', model: 'minimax-coding-plan/MiniMax-M3', apiKeyEnv: 'HARNESS_OPENCODE_API_KEY' }, /models\.m3/],
    ['pricing on OpenCode CLI', { provider: 'opencode-cli', model: 'minimax-coding-plan/MiniMax-M3', pricing: {} }, /models\.m3/],
    ['URL on scripted', { provider: 'scripted', baseUrl: 'https://models.example/v1' }, /models\.m3/],
    ['key on scripted', { provider: 'scripted', apiKeyEnv: 'HARNESS_SCRIPTED_API_KEY' }, /models\.m3/],
    ['missing custom URL', { provider: 'openai-compatible' }, /models\.m3\.baseUrl/],
  ] as const)('Given %s, when parsing URL and key policy, then it reports the full failing path', (_name, patch, error) => {
    expect(() => parseModelProfiles({ models: { m3: { ...minimax, ...patch } } })).toThrow(error);
  });

  it('Given a routed OpenCode catalog identifier, when parsing, then it preserves provider/model punctuation', () => {
    const model = 'openrouter/qwen/qwen3-coder:free';

    expect(parseModelProfiles({ models: { routed: { provider: 'opencode-cli', model } } })).toEqual({
      routed: { provider: 'opencode-cli', model },
    });
  });

  it('Given the OpenCode none variant, when parsing, then it preserves the explicit no-reasoning selection', () => {
    expect(
      parseModelProfiles({
        models: {
          m3: {
            provider: 'opencode-cli',
            model: 'minimax-coding-plan/MiniMax-M3',
            reasoningEffort: 'none',
          },
        },
      }),
    ).toEqual({
      m3: {
        provider: 'opencode-cli',
        model: 'minimax-coding-plan/MiniMax-M3',
        reasoningEffort: 'none',
      },
    });
  });

  it.each([
    'MiniMax-M3',
    '/MiniMax-M3',
    'minimax-coding-plan/',
    'minimax-coding-plan//MiniMax-M3',
    'minimax coding plan/MiniMax-M3',
    'minimax-coding-plan/../MiniMax-M3',
    '--provider/MiniMax-M3',
  ])('Given unsafe OpenCode model identifier %s, when parsing, then it rejects the located model', (model) => {
    expect(() =>
      parseModelProfiles({ models: { m3: { provider: 'opencode-cli', model } } }),
    ).toThrow(/models\.m3\.model/);
  });

  it.each([
    ['negative temperature', { temperature: -1 }, /models\.m3\.temperature/],
    ['NaN temperature', { temperature: Number.NaN }, /models\.m3\.temperature/],
    ['infinite temperature', { temperature: Number.POSITIVE_INFINITY }, /models\.m3\.temperature/],
    ['zero topP', { topP: 0 }, /models\.m3\.topP/],
    ['large topP', { topP: 1.1 }, /models\.m3\.topP/],
    ['NaN topP', { topP: Number.NaN }, /models\.m3\.topP/],
    ['zero max completion tokens', { maxCompletionTokens: 0 }, /models\.m3\.maxCompletionTokens/],
    ['fractional max completion tokens', { maxCompletionTokens: 1.5 }, /models\.m3\.maxCompletionTokens/],
    ['zero timeout', { timeoutMs: 0 }, /models\.m3\.timeoutMs/],
    ['fractional timeout', { timeoutMs: 1.5 }, /models\.m3\.timeoutMs/],
    ['negative retries', { retries: -1 }, /models\.m3\.retries/],
    ['fractional retries', { retries: 1.5 }, /models\.m3\.retries/],
    ['numeric reasoning split', { reasoningSplit: 1 }, /models\.m3\.reasoningSplit/],
    ['string reasoning split', { reasoningSplit: 'true' }, /models\.m3\.reasoningSplit/],
    ['blank reasoning effort', { reasoningEffort: ' ' }, /models\.m3\.reasoningEffort/],
    ['invalid reasoning effort', { reasoningEffort: 'very high!' }, /models\.m3\.reasoningEffort/],
  ] as const)('Given %s, when parsing tuning, then it reports the full failing path', (_name, patch, error) => {
    expect(() => parseModelProfiles({ models: { m3: { ...minimax, ...patch } } })).toThrow(error);
  });

  it.each([
    ['non-object pricing', 'pricing', /models\.m3\.pricing/],
    ['unknown pricing key', { extra: 1 }, /models\.m3\.pricing\.extra/],
    ['negative prompt pricing', { promptPerMillion: -1 }, /models\.m3\.pricing\.promptPerMillion/],
    ['NaN prompt pricing', { promptPerMillion: Number.NaN }, /models\.m3\.pricing\.promptPerMillion/],
    ['infinite prompt pricing', { promptPerMillion: Number.POSITIVE_INFINITY }, /models\.m3\.pricing\.promptPerMillion/],
    ['negative completion pricing', { completionPerMillion: -1 }, /models\.m3\.pricing\.completionPerMillion/],
    ['NaN completion pricing', { completionPerMillion: Number.NaN }, /models\.m3\.pricing\.completionPerMillion/],
    ['infinite completion pricing', { completionPerMillion: Number.POSITIVE_INFINITY }, /models\.m3\.pricing\.completionPerMillion/],
  ] as const)('Given %s, when parsing pricing, then it reports the full failing path', (_name, pricing, error) => {
    expect(() => parseModelProfiles({ models: { m3: { ...minimax, pricing } } })).toThrow(error);
  });

  it('Given empty pricing, when parsing, then it preserves the explicit empty pricing object', () => {
    expect(parseModelProfiles({ models: { m3: { ...minimax, pricing: {} } } }).m3).toEqual({ ...minimaxResolved, pricing: {} });
  });

  it('Given every allowed nested override, when loading a profile seat, then it deep-resolves all tuning fields', async () => {
    const tuning = 'temperature: 0.1\n    topP: 0.5\n    maxCompletionTokens: 100\n    reasoningSplit: false\n    reasoningEffort: medium\n    timeoutMs: 5000\n    retries: 2';
    const overrides = '{ temperature: 0.8, topP: 0.9, maxCompletionTokens: 200, reasoningSplit: true, reasoningEffort: high, timeoutMs: 10000, retries: 3 }';
    await withCampaign(profileCampaign(tuning, overrides), async (filePath) => {
      const [run] = await loadCampaign(filePath);
      expect(run?.spec.seats[0]?.modelConfig).toEqual({ ...minimaxResolved, temperature: 0.8, topP: 0.9, maxCompletionTokens: 200, reasoningSplit: true, reasoningEffort: 'high', timeoutMs: 10000, retries: 3 });
    });
  });

  it.each([
    ['undefined profile', '{ persona: p, profile: absent }', /games\[0\]\.seats\[0\]\.profile/],
    ['model and profile', '{ persona: p, model: direct, profile: m3 }', /games\[0\]\.seats\[0\]/],
    ['neither model nor profile', '{ persona: p }', /games\[0\]\.seats\[0\]/],
    ['invalid count', '{ persona: p, profile: m3, count: 0 }', /games\[0\]\.seats\[0\]\.count/],
    ['overrides on a model seat', '{ persona: p, model: direct, overrides: {} }', /games\[0\]\.seats\[0\]\.overrides/],
    ['direct tuning', '{ persona: p, profile: m3, temperature: 0.7 }', /games\[0\]\.seats\[0\]/],
    ['non-object overrides', '{ persona: p, profile: m3, overrides: bad }', /games\[0\]\.seats\[0\]\.overrides/],
    ['unknown override', '{ persona: p, profile: m3, overrides: { unexpected: true } }', /games\[0\]\.seats\[0\]\.unexpected/],
    ['provider override', '{ persona: p, profile: m3, overrides: { provider: scripted } }', /games\[0\]\.seats\[0\]\.provider/],
    ['model override', '{ persona: p, profile: m3, overrides: { model: changed } }', /games\[0\]\.seats\[0\]\.model/],
    ['URL override', '{ persona: p, profile: m3, overrides: { baseUrl: https://models.example/v1 } }', /games\[0\]\.seats\[0\]\.baseUrl/],
    ['key environment override', '{ persona: p, profile: m3, overrides: { apiKeyEnv: HARNESS_OTHER_API_KEY } }', /games\[0\]\.seats\[0\]\.apiKeyEnv/],
    ['pricing override', '{ persona: p, profile: m3, overrides: { pricing: {} } }', /games\[0\]\.seats\[0\]\.pricing/],
    ['raw secret override', '{ persona: p, profile: m3, overrides: { apiKey: secret } }', /games\[0\]\.seats\[0\]\.apiKey/],
  ] as const)('Given %s, when loading a seat, then it reports the full failing path', async (_name, seat, error) => {
    await withCampaign(campaignWithSeat(seat), async (filePath) => expect(loadCampaign(filePath)).rejects.toThrow(error));
  });
});

function campaignWithSeat(seat: string): string {
  return `models:\n  m3:\n    provider: minimax\n    model: MiniMax-M3\ngames:\n  - game: test\n    rounds: 1\n    seats: [${seat}]\n`;
}

function profileCampaign(profileTuning: string, overrides: string): string {
  return `models:\n  m3:\n    provider: minimax\n    model: MiniMax-M3\n    ${profileTuning}\ngames:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, profile: m3, overrides: ${overrides} }]\n`;
}

async function withCampaign(
  yaml: string,
  assertion: (filePath: string) => Promise<unknown>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-profile-matrix-'));
  const filePath = path.join(directory, 'campaign.yaml');
  await writeFile(filePath, yaml);
  try {
    await assertion(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
