import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importBotConfig } from '../legacy-bot-config-importer.js';
import { parseModelProfiles } from '../model-profiles.js';

describe('legacy bot config importer', () => {
  it('Given a raw array with persona fields and explicit defaults, when importing, then it omits prose and reports field names', async () => {
    await withFiles(async (input, output) => {
      await writeFile(
        input,
        JSON.stringify([{ name: 'm3', title: 'Persona', instruction: 'secret prose' }]),
      );
      const result = await importBotConfig(input, output, {
        provider: 'minimax',
        model: 'MiniMax-M3',
      });
      expect(result).toEqual({
        profileNames: ['m3'],
        omittedPersonaFields: { m3: ['title', 'instruction'] },
      });
      expect(parseModelProfiles(await readFile(output, 'utf8')).m3?.model).toBe('MiniMax-M3');
    });
  });

  it.each([
    ['string tuning', [{ name: 'x', provider: 'minimax', model: 'M3', temperature: '1' }]],
    [
      'numeric reasoning split',
      [{ name: 'x', provider: 'minimax', model: 'M3', reasoningSplit: 1 }],
    ],
    [
      'alias conflict',
      [
        {
          name: 'x',
          provider: 'minimax',
          model: 'M3',
          baseUrl: 'https://api.minimax.io/v1',
          openAiBaseUrl: 'https://api.minimax.io/v1',
        },
      ],
    ],
    ['opencode migration', [{ name: 'x', provider: 'opencode-go', model: 'M3' }]],
  ])('Given %s, when importing, then it rejects without changing output', async (_name, bots) => {
    await withFiles(async (input, output) => {
      await writeFile(input, JSON.stringify(bots));
      await writeFile(output, 'preserve');
      await expect(importBotConfig(input, output)).rejects.toThrow();
      await expect(readFile(output, 'utf8')).resolves.toBe('preserve');
    });
  });
});

async function withFiles(
  assertion: (input: string, output: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'legacy-importer-'));
  try {
    await assertion(path.join(directory, 'bots.json'), path.join(directory, 'profiles.yaml'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
