import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAnalysisInputs, SeriesAnalysisInputError } from '../series-analysis.js';

describe('loadAnalysisInputs', () => {
  it('Given a legacy run and a failed series index, when loading judge inputs, then both expose their permitted relay histories', async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), 'series-analysis-'));
    const legacy = path.join(root, 'legacy');
    const series = path.join(root, 'series');
    await mkdir(path.join(legacy, 'bots'), { recursive: true });
    await writeFile(path.join(legacy, 'manifest.json'), '{"seats":[]}\n');
    await writeFile(path.join(legacy, 'relay.jsonl'), '{"legacy":true}\n');
    await writeFile(path.join(legacy, 'bots', 'bot-a.jsonl'), '{"kind":"session"}\n');
    await mkdir(path.join(series, 'games', '0', 'bots'), { recursive: true });
    await writeFile(
      path.join(series, 'series-manifest.json'),
      '{"status":"failed","gameIds":["game-1"]}\n',
    );
    await writeFile(path.join(series, 'games', '0', 'manifest.json'), '{"gameId":"game-1"}\n');
    await writeFile(
      path.join(series, 'games', '0', 'relay.jsonl'),
      '{"gameId":"game-1","index":0,"scope":{"kind":"all"}}\n',
    );

    try {
      // When
      const legacyInputs = await loadAnalysisInputs(legacy);
      const seriesInputs = await loadAnalysisInputs(series);

      // Then
      expect(legacyInputs.relayLines).toEqual([{ legacy: true }]);
      expect(seriesInputs.relayLines).toEqual([
        { gameId: 'game-1', index: 0, scope: { kind: 'all' } },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Given a series index with a missing child artifact or unsafe field, when loading judge inputs, then it rejects with an actionable typed error', async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), 'series-analysis-'));
    await writeFile(path.join(root, 'series-manifest.json'), '{"gameIds":["game-1"]}\n');

    try {
      // When / Then
      await expect(loadAnalysisInputs(root)).rejects.toBeInstanceOf(SeriesAnalysisInputError);
      await mkdir(path.join(root, 'games', '0'), { recursive: true });
      await writeFile(
        path.join(root, 'games', '0', 'manifest.json'),
        '{"gameId":"game-1","privateKey":"leak"}\n',
      );
      await expect(loadAnalysisInputs(root)).rejects.toThrow('unsafe field privateKey');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('Given the same bot name in two completed games, when loading judge inputs, then one stable bot timeline preserves sequential game provenance without pseudo-keys', async () => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), 'series-analysis-'));
    await writeFile(
      path.join(root, 'series-manifest.json'),
      JSON.stringify({
        availableGames: [
          { gameId: 'game-1', gameIndex: 0, status: 'completed' },
          { gameId: 'game-2', gameIndex: 1, status: 'completed' },
        ],
      }),
    );
    for (const [gameIndex, gameId] of ['game-1', 'game-2'].entries()) {
      const gameDir = path.join(root, 'games', String(gameIndex));
      await mkdir(path.join(gameDir, 'bots'), { recursive: true });
      await writeFile(path.join(gameDir, 'manifest.json'), JSON.stringify({ gameId }));
      await writeFile(path.join(gameDir, 'relay.jsonl'), '');
      await writeFile(
        path.join(gameDir, 'bots', 'bot-a.jsonl'),
        `${JSON.stringify({
          gameId,
          gameIndex,
          kind: 'tool_call',
          name: `action-${gameIndex}`,
        })}\n`,
      );
    }

    try {
      // When
      const inputs = await loadAnalysisInputs(root);

      // Then
      expect(Object.keys(inputs.botTranscripts)).toEqual(['bot-a']);
      expect(inputs.botTranscripts['bot-a']).toEqual([
        { gameId: 'game-1', gameIndex: 0, kind: 'tool_call', name: 'action-0' },
        { gameId: 'game-2', gameIndex: 1, kind: 'tool_call', name: 'action-1' },
      ]);
      expect(inputs.botTranscripts['0:bot-a']).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    'hiddenReasoning',
    'hidden_reasoning',
    'HIDDEN-REASONING',
    'horizon_secret',
    'RAW-TOOL-INTERNALS',
    'api_key',
    'private-key',
    'AUTH',
    'Credentials',
    'password',
    'TOKEN',
  ])('Given unsafe normalized field %s in a child artifact, when loading judge inputs, then it rejects the field variant', async (unsafeKey) => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), 'series-analysis-'));
    await writeFile(path.join(root, 'series-manifest.json'), '{"gameIds":["game-1"]}\n');
    await mkdir(path.join(root, 'games', '0'), { recursive: true });
    await writeFile(
      path.join(root, 'games', '0', 'manifest.json'),
      JSON.stringify({ gameId: 'game-1', [unsafeKey]: 'leak' }),
    );

    try {
      // When / Then
      await expect(loadAnalysisInputs(root)).rejects.toThrow(`unsafe field ${unsafeKey}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['naked', 'a'.repeat(64)],
    ['0x-prefixed', `0x${'b'.repeat(64)}`],
  ])('Given a raw %s 64-hex private key string in a child artifact, when loading judge inputs, then it rejects the credential value', async (_label, privateKey) => {
    // Given
    const root = await mkdtemp(path.join(tmpdir(), 'series-analysis-'));
    await writeFile(path.join(root, 'series-manifest.json'), '{"gameIds":["game-1"]}\n');
    await mkdir(path.join(root, 'games', '0'), { recursive: true });
    await writeFile(
      path.join(root, 'games', '0', 'manifest.json'),
      JSON.stringify({ gameId: 'game-1', note: privateKey }),
    );

    try {
      // When / Then
      await expect(loadAnalysisInputs(root)).rejects.toThrow('contains raw credential text');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
