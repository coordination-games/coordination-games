import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSeriesArtifactWriter,
  type ResolvedSeriesConfigInput,
  SeriesArtifactError,
} from '../series-artifacts.js';

describe('series artifacts', () => {
  it('Given unsafe inspector data, when persisting a completed game, then artifacts retain only safe relay fields and preserve game/index provenance', async () => {
    // Given
    const runDir = await mkdtemp(path.join(tmpdir(), 'series-artifacts-'));
    const writer = createSeriesArtifactWriter({ runDir, runId: 'run-safe' });

    try {
      // When
      await writer.writeGame({
        gameId: 'game-1',
        gameIndex: 0,
        outcome: {
          phase: 'finished',
          hiddenReasoning: 'hidden-reasoning',
          horizonSecret: 'horizon-secret',
        },
        standings: [{ playerId: 'player-a', rank: 1 }],
        relay: [
          {
            index: 4,
            type: 'messaging',
            pluginId: 'basic-chat',
            sender: 'player-a',
            scope: { kind: 'all' },
            turn: 2,
            timestamp: 1,
            data: {
              body: 'public-message',
              hiddenReasoning: 'hidden-reasoning',
              apiKey: 'api-key',
            },
          },
        ],
        viewers: { 'bot-a': { playerId: 'player-a', handle: 'bot-a' } },
        botEvents: {
          'bot-a': [
            {
              kind: 'tool_call',
              args: { privateKey: 'private-key', token: 'token', raw: 'tool-internals' },
            },
          ],
        },
      });

      // Then
      const relay = await readFile(path.join(runDir, 'games/0/relay.jsonl'), 'utf8');
      const bot = await readFile(path.join(runDir, 'games/0/bots/bot-a.jsonl'), 'utf8');
      const manifest = await readFile(path.join(runDir, 'games/0/manifest.json'), 'utf8');
      expect(relay).toContain('public-message');
      expect(relay).toContain('"gameId":"game-1"');
      expect(relay).toContain('"index":4');
      expect(manifest).toContain('"gameId": "game-1"');
      expect(bot).not.toContain('private-key');
      for (const secret of [
        'hidden-reasoning',
        'horizon-secret',
        'api-key',
        'private-key',
        'token',
        'tool-internals',
      ]) {
        expect(`${relay}${bot}${manifest}`).not.toContain(secret);
      }
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('Given a failed atomic manifest replacement, when the writer is interrupted before rename, then the prior partial manifest remains valid', async () => {
    // Given
    const runDir = await mkdtemp(path.join(tmpdir(), 'series-artifacts-'));
    let renameAttempts = 0;
    const writer = createSeriesArtifactWriter({
      runDir,
      runId: 'run-atomic',
      beforeRename: () => {
        renameAttempts++;
        if (renameAttempts === 2) throw new Error('forced interruption');
      },
    });

    try {
      await writer.writeSeries({
        status: 'running',
        gameIds: ['game-1'],
        standings: [],
        usage: {},
      });
      const before = await readFile(path.join(runDir, 'series-manifest.json'), 'utf8');

      // When
      await expect(
        writer.writeSeries({
          status: 'failed',
          gameIds: ['game-1', 'game-2'],
          standings: [],
          usage: {},
        }),
      ).rejects.toBeInstanceOf(SeriesArtifactError);

      // Then
      expect(await readFile(path.join(runDir, 'series-manifest.json'), 'utf8')).toBe(before);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('Given public and direct relay messages plus real credential formats, when writing a game, then shared artifacts are public-only and each DM is limited to its permitted bot views', async () => {
    // Given
    const runDir = await mkdtemp(path.join(tmpdir(), 'series-artifacts-'));
    const writer = createSeriesArtifactWriter({ runDir, runId: 'run-private' });
    const secrets = [
      'sk-proj-1234567890abcdefghijklmnop',
      'Bearer abcdefghijklmnopqrstuvwxyz',
      'API_KEY=arbitrary-secret-value',
      'https://alice:password@example.test/path?token=query-secret',
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'raw-tool-payload',
    ];

    try {
      // When
      await writer.writeGame({
        gameId: 'game-1',
        gameIndex: 0,
        outcome: { phase: 'finished' },
        standings: [],
        viewers: {
          'bot-a': { playerId: 'player-a', handle: 'bot-a' },
          'bot-b': { playerId: 'player-b', handle: 'bot-b' },
          'bot-c': { playerId: 'player-c', handle: 'bot-c' },
        },
        relay: [
          relay('player-a', { kind: 'all' }, 'public-message', 0),
          relay('player-a', { kind: 'dm', recipientHandle: 'bot-b' }, 'a-to-b-private', 1),
          relay('player-a', { kind: 'all' }, secrets.join(' '), 2),
        ],
        botEvents: {
          'bot-a': [{ kind: 'tool_call', raw: 'raw-tool-payload' }],
          'bot-b': [],
          'bot-c': [],
        },
      });

      // Then
      const shared = await readFile(path.join(runDir, 'games/0/relay.jsonl'), 'utf8');
      const botA = await readFile(path.join(runDir, 'games/0/bots/bot-a.jsonl'), 'utf8');
      const botB = await readFile(path.join(runDir, 'games/0/bots/bot-b.jsonl'), 'utf8');
      const botC = await readFile(path.join(runDir, 'games/0/bots/bot-c.jsonl'), 'utf8');
      expect(shared).toContain('public-message');
      expect(shared).not.toContain('a-to-b-private');
      expect(botA).toContain('a-to-b-private');
      expect(botB).toContain('a-to-b-private');
      expect(botC).not.toContain('a-to-b-private');
      for (const secret of secrets) expect(`${shared}${botA}${botB}${botC}`).not.toContain(secret);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('Given two recorded errors and an interrupted third append, when the error log is updated atomically, then it retains both ordered prior errors', async () => {
    // Given
    const runDir = await mkdtemp(path.join(tmpdir(), 'series-artifacts-'));
    let writes = 0;
    const writer = createSeriesArtifactWriter({
      runDir,
      runId: 'run-errors',
      beforeRename: (target) => {
        if (target.endsWith('errors.jsonl') && ++writes === 3) throw new Error('interrupted');
      },
    });

    try {
      await writer.writeError(new Error('first'));
      await writer.writeError(new Error('second'));

      // When
      await expect(writer.writeError(new Error('third'))).rejects.toBeInstanceOf(
        SeriesArtifactError,
      );

      // Then
      expect(await readFile(path.join(runDir, 'errors.jsonl'), 'utf8')).toContain('first');
      expect(await readFile(path.join(runDir, 'errors.jsonl'), 'utf8')).toContain('second');
      expect(await readFile(path.join(runDir, 'errors.jsonl'), 'utf8')).not.toContain('third');
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('Given a resolved MiniMax profile and populated tournament settings, when writing resolved config, then every reproducible non-secret field and the env name survive without the env value', async () => {
    // Given
    const runDir = await mkdtemp(path.join(tmpdir(), 'series-artifacts-'));
    const writer = createSeriesArtifactWriter({ runDir, runId: 'run-config' });
    const apiKeyValue = 'minimax-live-value-must-not-persist';
    const previousApiKey = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = apiKeyValue;
    const modelConfig = {
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyEnv: 'MINIMAX_API_KEY',
      temperature: 0.2,
      topP: 0.8,
      maxCompletionTokens: 4096,
      reasoningSplit: true,
      reasoningEffort: 'high',
      timeoutMs: 12_000,
      retries: 3,
      pricing: { promptPerMillion: 1.2, completionPerMillion: 4.8 },
    } as const;
    const config = {
      game: 'tragedy-of-the-commons',
      params: { teamSize: 3, resources: 12 },
      limits: {
        maxModelCallsPerBot: 5,
        wallClockMsPerRun: 60_000,
        maxAggregateCostMicrousd: 500_000,
      },
      tournament: {
        mode: 'tragedy-series',
        policy: {
          seriesLength: 3,
          baseEntryCost: '100',
          carryBps: 1000,
          slashBps: 500,
          minRounds: 2,
          maxRounds: 8,
          hazardNumerator: 1,
          hazardDenominator: 4,
        },
      },
      disablePlugins: ['trust'],
      seats: [
        {
          bot: 'bot-a',
          persona: '/personas/bot-a',
          model: 'MiniMax-M3',
          backend: 'openrouter',
          modelConfig,
        },
      ],
    } satisfies ResolvedSeriesConfigInput;

    try {
      // When
      await writer.writeResolvedConfig(config);

      // Then
      const text = await readFile(path.join(runDir, 'resolved-config.json'), 'utf8');
      expect(JSON.parse(text)).toEqual(config);
      expect(text).toContain('MINIMAX_API_KEY');
      expect(text).not.toContain(apiKeyValue);
    } finally {
      if (previousApiKey === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previousApiKey;
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('Given tool and model events with raw payloads, when writing bot artifacts, then useful event metadata remains while args, results, reasoning, and content are absent', async () => {
    // Given
    const runDir = await mkdtemp(path.join(tmpdir(), 'series-artifacts-'));
    const writer = createSeriesArtifactWriter({ runDir, runId: 'run-events' });

    try {
      // When
      await writer.writeGame({
        gameId: 'game-1',
        gameIndex: 0,
        outcome: { phase: 'finished' },
        standings: [],
        relay: [],
        viewers: { 'bot-a': { playerId: 'player-a', handle: 'bot-a' } },
        botEvents: {
          'bot-a': [
            {
              t: 1,
              bot: 'bot-a',
              kind: 'tool_call',
              name: 'send_message',
              args: { body: 'raw-call-args' },
            },
            {
              t: 2,
              bot: 'bot-a',
              kind: 'tool_result',
              name: 'send_message',
              stateVersion: 7,
              relayCursor: 11,
              isError: true,
              result: { content: 'raw-tool-result' },
            },
            {
              t: 3,
              bot: 'bot-a',
              kind: 'model_response',
              text: 'raw-model-content',
              reasoning: 'raw-hidden-reasoning',
              usage: { prompt_tokens: 13, completion_tokens: 5 },
            },
          ],
        },
      });

      // Then
      const text = await readFile(path.join(runDir, 'games/0/bots/bot-a.jsonl'), 'utf8');
      const events = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toEqual([
        {
          gameId: 'game-1',
          gameIndex: 0,
          kind: 'tool_call',
          t: 1,
          bot: 'bot-a',
          name: 'send_message',
        },
        {
          gameId: 'game-1',
          gameIndex: 0,
          kind: 'tool_result',
          t: 2,
          bot: 'bot-a',
          name: 'send_message',
          stateVersion: 7,
          relayCursor: 11,
          isError: true,
        },
        {
          gameId: 'game-1',
          gameIndex: 0,
          kind: 'model_response',
          t: 3,
          bot: 'bot-a',
          usage: { prompt_tokens: 13, completion_tokens: 5 },
        },
      ]);
      expect(text).not.toMatch(
        /raw-call-args|raw-tool-result|raw-model-content|raw-hidden-reasoning/,
      );
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

function relay(
  sender: string,
  scope: { readonly kind: 'all' } | { readonly kind: 'dm'; readonly recipientHandle: string },
  body: string,
  index: number,
) {
  return {
    index,
    type: 'messaging',
    pluginId: 'basic-chat',
    sender,
    scope,
    turn: 1,
    data: { body },
  };
}
