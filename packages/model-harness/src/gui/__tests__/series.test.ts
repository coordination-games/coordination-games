import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewArtifactFile } from '../inspect.js';
import type { BoundedRoot } from '../paths.js';
import { inspectSeries } from '../series.js';

/**
 * Private-safe series inspection: the console surfaces Todo 9 series artifacts
 * (series-manifest / resolved-config / per-game manifests + public relay) and
 * NEVER reads bots/*.jsonl, which are the only files carrying DM bodies.
 */

let rootDir: string;
const roots = (): BoundedRoot[] => [{ key: 't', label: 't/', dir: rootDir }];

const SERIES_MANIFEST = {
  runId: 'run-series',
  kind: 'tournament',
  status: 'completed',
  gameIds: ['g1', 'g2'],
  standings: [
    { playerId: 'p1', rank: 1 },
    { playerId: 'p2', rank: 2 },
  ],
  usage: { promptTokens: 1200, completionTokens: 340, note: 'not-a-number' },
  lobbyId: 'lobby-1',
  tournamentId: 'lobby:lobby-1',
};

const RESOLVED_CONFIG = {
  game: 'tragedy-of-the-commons',
  params: { teamSize: 4 },
  limits: { maxModelCallsPerBot: 120, wallClockMsPerRun: 900_000 },
  tournament: {
    mode: 'tragedy-series',
    policy: {
      seriesLength: 3,
      baseEntryCost: '100',
      carryBps: 1500,
      slashBps: 500,
      minRounds: 2,
      maxRounds: 8,
      hazardNumerator: 1,
      hazardDenominator: 4,
    },
  },
  seats: [
    {
      bot: 'bot1',
      persona: './personas/peaceful-mediator',
      model: 'MiniMax-M3',
      backend: 'openrouter',
      modelConfig: { provider: 'minimax', model: 'MiniMax-M3', apiKeyEnv: 'MINIMAX_API_KEY' },
    },
    {
      bot: 'bot2',
      persona: './personas/win-focused-opportunist',
      model: 'haiku',
      backend: 'claude',
    },
  ],
};

const GAME_MANIFEST = {
  gameId: 'g1',
  gameIndex: 0,
  outcome: { phase: 'finished', winnerLabel: 'p1' },
  standings: [{ playerId: 'p1', rank: 1 }],
  relayCount: 2,
};

async function writeSeriesDir(
  name: string,
  overrides: Partial<typeof SERIES_MANIFEST>,
): Promise<string> {
  const dir = path.join(rootDir, name);
  await fsp.mkdir(path.join(dir, 'games', '0', 'bots'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'series-manifest.json'),
    JSON.stringify({ ...SERIES_MANIFEST, ...overrides }),
  );
  await fsp.writeFile(path.join(dir, 'resolved-config.json'), JSON.stringify(RESOLVED_CONFIG));
  await fsp.writeFile(
    path.join(dir, 'analysis-input.json'),
    JSON.stringify({ runId: 'run-series', kind: 'tournament', status: 'completed' }),
  );
  await fsp.writeFile(
    path.join(dir, 'errors.jsonl'),
    `${JSON.stringify({ name: 'SeriesArtifactError', message: 'boom' })}\n`,
  );
  await fsp.writeFile(path.join(dir, 'games', '0', 'manifest.json'), JSON.stringify(GAME_MANIFEST));
  await fsp.writeFile(
    path.join(dir, 'games', '0', 'relay.jsonl'),
    `${JSON.stringify({ index: 0, type: 'messaging', sender: 'p1', scope: { kind: 'all' } })}\n${JSON.stringify({ index: 1, type: 'messaging', sender: 'p2', scope: { kind: 'all' } })}\n`,
  );
  await fsp.writeFile(
    path.join(dir, 'games', '0', 'bots', 'bot1.jsonl'),
    `${JSON.stringify({ kind: 'relay', relay: { scope: { kind: 'dm', recipientHandle: 'bot1' }, body: 'DM-SECRET-BODY' } })}\n`,
  );
  return dir;
}

beforeAll(async () => {
  rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gui-series-'));
  await writeSeriesDir('series-run', {});
  await writeSeriesDir('series-live', { status: 'running', gameIds: ['g1'] });
  const plain = path.join(rootDir, 'plain-run');
  await fsp.mkdir(plain, { recursive: true });
  await fsp.writeFile(path.join(plain, 'manifest.json'), JSON.stringify({ runId: 'r' }));
});

afterAll(async () => {
  await fsp.rm(rootDir, { recursive: true, force: true });
});

describe('inspectSeries — truthful private-safe series audit', () => {
  it('surfaces status, standings, usage, seats, and per-game progress', async () => {
    // Given a completed Todo 9 series dir / When inspected / Then the audit is truthful
    const audit = await inspectSeries('t:series-run', roots());
    if (!audit) throw new Error('expected a series audit');
    expect(audit.kind).toBe('tournament');
    expect(audit.status).toBe('completed');
    expect(audit.gameIds).toEqual(['g1', 'g2']);
    expect(audit.seriesLength).toBe(3);
    expect(audit.standings).toEqual([
      { playerId: 'p1', rank: 1 },
      { playerId: 'p2', rank: 2 },
    ]);
    // Only numeric usage entries survive — no free-form strings on this surface.
    expect(audit.usage).toEqual({ promptTokens: 1200, completionTokens: 340 });
    expect(audit.seats).toEqual([
      { bot: 'bot1', persona: 'peaceful-mediator', model: 'MiniMax-M3', provider: 'minimax' },
      { bot: 'bot2', persona: 'win-focused-opportunist', model: 'haiku', provider: 'claude' },
    ]);
    expect(audit.games).toEqual([
      {
        gameIndex: 0,
        gameId: 'g1',
        outcome: { phase: 'finished', winnerLabel: 'p1' },
        standings: [{ playerId: 'p1', rank: 1 }],
        relayCount: 2,
      },
    ]);
    expect(audit.errors).toEqual([{ name: 'SeriesArtifactError', message: 'boom' }]);
  });

  it('never reads bot files — DM bodies cannot reach the audit surface', async () => {
    const audit = await inspectSeries('t:series-run', roots());
    expect(JSON.stringify(audit)).not.toContain('DM-SECRET-BODY');
    // The seat summary carries provider/model only — no apiKeyEnv, no modelConfig.
    expect(JSON.stringify(audit)).not.toContain('MINIMAX_API_KEY');
  });

  it('shows live progression for a running series', async () => {
    // Given a running series with one finished game / When inspected / Then progress is visible
    const audit = await inspectSeries('t:series-live', roots());
    if (!audit) throw new Error('expected a series audit');
    expect(audit.status).toBe('running');
    expect(audit.gameIds).toEqual(['g1']);
    expect(audit.seriesLength).toBe(3);
    expect(audit.games).toHaveLength(1);
  });

  it('returns null for a non-series artifact dir', async () => {
    expect(await inspectSeries('t:plain-run', roots())).toBeNull();
  });

  it('rejects traversal ids before touching the filesystem', async () => {
    await expect(inspectSeries('t:../outside', roots())).rejects.toThrow('not allowed');
  });
});

describe('previewArtifactFile — series files join the whitelist, bot DMs stay out', () => {
  it.each([
    'series-manifest.json',
    'resolved-config.json',
    'analysis-input.json',
    'errors.jsonl',
    'games/0/manifest.json',
    'games/0/relay.jsonl',
  ])('previews %s', async (file) => {
    const preview = await previewArtifactFile('t:series-run', file, roots());
    expect(preview.file).toBe(file);
    expect(preview.text.length).toBeGreaterThan(0);
  });

  it('refuses per-game bot event files — they carry DM bodies', async () => {
    await expect(
      previewArtifactFile('t:series-run', 'games/0/bots/bot1.jsonl', roots()),
    ).rejects.toThrow('file is not previewable');
  });
});
