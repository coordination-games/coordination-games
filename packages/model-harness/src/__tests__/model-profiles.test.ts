import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importBotConfig } from '../legacy-bot-config-importer.js';
import { parseModelProfiles } from '../model-profiles.js';
import { loadCampaign } from '../spec.js';

describe('model profiles', () => {
  it('Given an exact MiniMax-M3 profile, when loading a profile-backed seat, then it retains the opaque model id and deterministic defaults', async () => {
    await withCampaign(profileCampaign('MiniMax-M3'), async (filePath) => {
      const [run] = await loadCampaign(filePath);
      expect(run?.spec.seats).toEqual([
        {
          persona: 'p',
          profile: 'm3',
          model: 'MiniMax-M3',
          count: 1,
          modelConfig: {
            provider: 'minimax',
            model: 'MiniMax-M3',
            baseUrl: 'https://api.minimax.io/v1',
            apiKeyEnv: 'MINIMAX_API_KEY',
            temperature: 0.2,
          },
        },
      ]);
    });
  });

  it.each([
    'MiniMax-M3',
    'MiniMax-M4-preview',
  ])('Given opaque %s, when resolving a profile seat, then it is not allow-listed or rewritten', async (model) => {
    await withCampaign(profileCampaign(model), async (filePath) => {
      const [run] = await loadCampaign(filePath);
      expect(run?.spec.seats[0]?.model).toBe(model);
    });
  });

  it.each([
    ['claude-cli', 'claude-haiku', ''],
    ['opencode-cli', 'minimax-coding-plan/MiniMax-M3', ''],
    ['openrouter', 'openai/gpt-5', ''],
    ['minimax', 'MiniMax-M3', ''],
    [
      'openai-compatible',
      'local-model',
      'baseUrl: http://localhost:8080/v1\n    apiKeyEnv: HARNESS_LOCAL_API_KEY',
    ],
    ['scripted', 'fixture-model', ''],
  ])('Given %s, when loading its approved profile, then it preserves its opaque model', async (provider, model, extra) => {
    const yaml = `models:\n  profile:\n    provider: ${provider}\n    model: ${model}${extra ? `\n    ${extra}` : ''}\ngames:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, profile: profile }]\n`;
    await withCampaign(yaml, async (filePath) => {
      const [run] = await loadCampaign(filePath);
      expect(run?.spec.seats[0]?.model).toBe(model);
    });
  });

  it('Given a nested profile seat override, when resolving it, then it overrides only its non-secret tuning field', async () => {
    await withCampaign(
      profileCampaign('MiniMax-M3').replace(
        'profile: m3',
        'profile: m3, overrides: { temperature: 0.7 }',
      ),
      async (filePath) => {
        const [run] = await loadCampaign(filePath);
        expect(run?.spec.seats[0]?.modelConfig?.temperature).toBe(0.7);
      },
    );
  });

  it('Given direct profile-seat tuning, when loading, then it rejects instead of treating it as an override', async () => {
    await withCampaign(
      profileCampaign('MiniMax-M3').replace('profile: m3', 'profile: m3, temperature: 0.7'),
      async (filePath) => {
        await expect(loadCampaign(filePath)).rejects.toThrow(/games\[0\]\.seats\[0\]/);
      },
    );
  });

  it.each([
    [
      'undefined profile',
      campaignWithSeat('{ persona: p, profile: absent }'),
      /games\[0\]\.seats\[0\].profile/,
    ],
    [
      'model and profile conflict',
      campaignWithSeat('{ persona: p, model: haiku, profile: m3 }'),
      /games\[0\]\.seats\[0]/,
    ],
    [
      'unsafe URL',
      profileCampaign('future-minimax', 'baseUrl: http://minimax.io/v1'),
      /models\.m3\.baseUrl/,
    ],
    [
      'unsafe standard key env',
      profileCampaign(
        'future-minimax',
        'baseUrl: https://custom.example/v1\n    apiKeyEnv: OPENAI_API_KEY',
      ),
      /models\.m3\.apiKeyEnv/,
    ],
    ['raw secret field', profileCampaign('future-minimax', 'apiKey: secret'), /models\.m3/],
    ['bad ranges', profileCampaign('future-minimax', 'topP: 2'), /models\.m3\.topP/],
    [
      'numeric reasoning split',
      profileCampaign('future-minimax', 'reasoningSplit: 0.5'),
      /models\.m3\.reasoningSplit/,
    ],
    [
      'unknown provider',
      profileCampaign('future-minimax').replace('provider: minimax', 'provider: unknown'),
      /models\.m3\.provider/,
    ],
    [
      'secret seat override',
      campaignWithSeat('{ persona: p, profile: m3, apiKey: secret }'),
      /games\[0\]\.seats\[0\]/,
    ],
  ])('Given %s, when loading profiles, then it rejects the located invalid configuration', async (_name, yaml, error) => {
    await withCampaign(yaml, async (filePath) => {
      await expect(loadCampaign(filePath)).rejects.toThrow(error);
    });
  });

  it('Given a legacy bot configuration, when importing it, then canonical YAML parses like a hand-authored named profile', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-profile-import-'));
    const legacyPath = path.join(directory, 'legacy.json');
    const outputPath = path.join(directory, 'profiles.yaml');
    try {
      await writeFile(
        legacyPath,
        JSON.stringify({
          bots: [
            {
              name: 'm3',
              model: 'MiniMax-M3',
              provider: 'minimax',
              openAiBaseUrl: 'https://api.minimax.io/v1',
              temperature: 0.2,
            },
          ],
        }),
      );
      await importBotConfig(legacyPath, outputPath);
      const imported = parseModelProfiles(await readFile(outputPath, 'utf8'));
      const authored = parseModelProfiles(
        'models:\n  m3:\n    provider: minimax\n    model: MiniMax-M3\n    baseUrl: https://api.minimax.io/v1\n    temperature: 0.2\n',
      );
      expect(imported).toEqual(authored);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('Given malformed or colliding legacy entries, when importing, then it rejects instead of producing a partial profile file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-profile-import-invalid-'));
    const legacyPath = path.join(directory, 'legacy.json');
    const outputPath = path.join(directory, 'profiles.yaml');
    try {
      await writeFile(
        legacyPath,
        JSON.stringify([
          { name: 'same', model: 'a' },
          { name: 'SAME', model: 'b' },
        ]),
      );
      await expect(
        importBotConfig(legacyPath, outputPath, { provider: 'scripted', model: 'fixture' }),
      ).rejects.toThrow(/duplicate generated name/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function profileCampaign(model: string, extra = ''): string {
  const suffix = extra ? `\n    ${extra}` : '';
  return `models:\n  m3:\n    provider: minimax\n    model: ${model}\n    temperature: 0.2${suffix}\ngames:\n  - game: test\n    rounds: 1\n    seats: [{ persona: p, profile: m3 }]\n`;
}

function campaignWithSeat(seat: string): string {
  return `models:\n  m3:\n    provider: minimax\n    model: MiniMax-M3\ngames:\n  - game: test\n    rounds: 1\n    seats: [${seat}]\n`;
}

async function withCampaign(
  yaml: string,
  assertion: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-profile-spec-'));
  const filePath = path.join(directory, 'campaign.yaml');
  await writeFile(filePath, yaml);
  try {
    await assertion(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
