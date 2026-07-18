import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoundedRoot } from '../paths.js';
import { summarizeSpec } from '../summary.js';

let rootDir: string;
const roots = (): BoundedRoot[] => [{ key: 't', label: 't/', dir: rootDir }];

/** Mirrors runs/minimax-m3-tournament.yaml — the canonical M3 tournament spec. */
const TOURNAMENT_YAML = `globals:
  server: http://localhost:8787
  identities: ephemeral
  output: ./runs/out
  limits: { maxModelCallsPerBot: 120, wallClockMsPerRun: 900000, maxAggregateCostMicrousd: 5000000 }
models:
  minimax-m3:
    provider: minimax
    model: MiniMax-M3
games:
  - label: m3-series
    game: tragedy-of-the-commons
    repeats: 2
    params: { teamSize: 4 }
    tournament:
      mode: tragedy-series
      policy:
        seriesLength: 3
        baseEntryCost: "100"
        carryBps: 1500
        slashBps: 500
        minRounds: 2
        maxRounds: 8
        hazardNumerator: 1
        hazardDenominator: 4
    seats:
      - { persona: ./personas/peaceful-mediator, profile: minimax-m3, count: 2 }
      - { persona: ./personas/win-focused-opportunist, profile: minimax-m3, count: 2 }
`;

const LEGACY_YAML = `globals:
  identities: ephemeral
  output: ./runs/out
games:
  - label: baseline
    game: tragedy-of-the-commons
    rounds: 6
    params: { teamSize: 4 }
    seats:
      - { persona: ./personas/peaceful-mediator, model: haiku, count: 2 }
      - { persona: ./personas/win-focused-opportunist, model: openai/gpt-4o, count: 2 }
  - label: "<script>alert(1)</script>"
    game: tragedy-of-the-commons
    rounds: 3
    seats:
      - { persona: ./personas/peaceful-mediator, model: haiku }
`;

beforeAll(async () => {
  rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gui-summary-'));
  await fsp.writeFile(path.join(rootDir, 'tournament.yaml'), TOURNAMENT_YAML);
  await fsp.writeFile(path.join(rootDir, 'legacy.yaml'), LEGACY_YAML);
  await fsp.writeFile(path.join(rootDir, 'broken.yaml'), 'games: [ { game: [unclosed\n');
  await fsp.writeFile(
    path.join(rootDir, 'modles-typo.yaml'),
    'modles:\n  m3: { provider: minimax, model: MiniMax-M3 }\ngames:\n  - { game: g, rounds: 1, seats: [ { persona: ./p, model: haiku } ] }\n',
  );
  await fsp.writeFile(
    path.join(rootDir, 'unknown-profile.yaml'),
    'models:\n  m3: { provider: minimax, model: MiniMax-M3 }\ngames:\n  - { game: g, rounds: 1, seats: [ { persona: ./p, profile: nope } ] }\n',
  );
  await fsp.writeFile(
    path.join(rootDir, 'secret-key.yaml'),
    `sk-proj-${'a'.repeat(64)}: 1\ngames:\n  - { game: g, rounds: 1, seats: [ { persona: ./p, model: haiku } ] }\n`,
  );
  await fsp.writeFile(
    path.join(rootDir, 'long-error.yaml'),
    `x${'y'.repeat(600)}: 1\ngames:\n  - { game: g, rounds: 1, seats: [ { persona: ./p, model: haiku } ] }\n`,
  );
});

afterAll(async () => {
  await fsp.rm(rootDir, { recursive: true, force: true });
});

describe('summarizeSpec — canonical tournament summary', () => {
  it('summarizes the M3 tournament spec with policy, seat matrix, and session ceiling', async () => {
    // Given the canonical M3 tournament spec / When summarized / Then the parser's truth is echoed
    const result = await summarizeSpec('t:tournament.yaml', roots());
    if (!result.ok) throw new Error(`expected ok summary, got failure: ${result.failure.message}`);
    expect(result.limits).toEqual({
      maxModelCallsPerBot: 120,
      wallClockMsPerRun: 900_000,
      maxAggregateCostMicrousd: 5_000_000,
    });
    expect(result.identities).toBe('ephemeral');
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry?.kind).toBe('tournament');
    expect(entry?.game).toBe('tragedy-of-the-commons');
    expect(entry?.repeats).toBe(2);
    expect(entry?.rounds).toBe(8);
    expect(entry?.tournament).toEqual({
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
    });
    const untunedSettings = {
      temperature: null,
      topP: null,
      maxCompletionTokens: null,
      reasoningSplit: null,
      reasoningEffort: null,
      timeoutMs: null,
      retries: null,
    };
    expect(entry?.seats).toEqual([
      {
        persona: 'peaceful-mediator',
        count: 2,
        provider: 'minimax',
        model: 'MiniMax-M3',
        profile: 'minimax-m3',
        settings: untunedSettings,
      },
      {
        persona: 'win-focused-opportunist',
        count: 2,
        provider: 'minimax',
        model: 'MiniMax-M3',
        profile: 'minimax-m3',
        settings: untunedSettings,
      },
    ]);
    // 2 repeats × 3 series games × 4 seats
    expect(entry?.maxModelSessions).toBe(24);
    expect(result.totals).toEqual({ entries: 1, totalRuns: 2, maxModelSessions: 24 });
  });

  it('keeps legacy multi-entry specs standard — no tournament badge anywhere', async () => {
    // Given an ordinary campaign / When summarized / Then no entry is marked tournament
    const result = await summarizeSpec('t:legacy.yaml', roots());
    if (!result.ok) throw new Error(`expected ok summary, got failure: ${result.failure.message}`);
    expect(result.entries).toHaveLength(2);
    for (const entry of result.entries) {
      expect(entry.kind).toBe('standard');
      expect(entry.tournament).toBeNull();
    }
    expect(result.entries[0]?.seats.map((s) => s.provider)).toEqual(['claude', 'openrouter']);
    expect(result.entries[0]?.seats.map((s) => s.profile)).toEqual([null, null]);
    expect(result.entries[0]?.maxModelSessions).toBe(4);
    expect(result.entries[0]?.rounds).toBe(6);
    // Untrusted label text passes through as plain text for the client to render inertly.
    expect(result.entries[1]?.label).toBe('<script>alert(1)</script>');
    expect(result.totals).toEqual({ entries: 2, totalRuns: 2, maxModelSessions: 5 });
  });
});

describe('summarizeSpec — classified, bounded, redacted failures', () => {
  it('classifies malformed YAML as invalid-spec instead of throwing', async () => {
    const result = await summarizeSpec('t:broken.yaml', roots());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('invalid-spec');
    expect(result.failure.message.length).toBeGreaterThan(0);
  });

  it('surfaces the modles: root typo through the canonical strict parser', async () => {
    const result = await summarizeSpec('t:modles-typo.yaml', roots());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('invalid-spec');
    expect(result.failure.message).toContain('modles');
    expect(result.failure.message).toContain('not allowed');
  });

  it('surfaces an undefined profile reference as a classified failure', async () => {
    const result = await summarizeSpec('t:unknown-profile.yaml', roots());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toMatch(/profile/i);
  });

  it('redacts provider-key-shaped text from failure messages', async () => {
    const result = await summarizeSpec('t:secret-key.yaml', roots());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).not.toContain('sk-proj-aaaa');
  });

  it('bounds oversized failure messages and flags the truncation', async () => {
    const result = await summarizeSpec('t:long-error.yaml', roots());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message.length).toBeLessThanOrEqual(500);
    expect(result.failure.truncated).toBe(true);
  });

  it('rejects traversal ids before touching the filesystem', async () => {
    await expect(summarizeSpec('t:../outside.yaml', roots())).rejects.toThrow('not allowed');
  });

  it('rejects non-YAML spec ids', async () => {
    await fsp.writeFile(path.join(rootDir, 'notes.txt'), 'hi');
    await expect(summarizeSpec('t:notes.txt', roots())).rejects.toThrow('.yaml');
  });
});

const TUNED_YAML = `models:
  m3-tuned:
    provider: minimax
    model: MiniMax-M3
    temperature: 0.7
    topP: 0.9
    maxCompletionTokens: 2048
    reasoningSplit: true
    reasoningEffort: high
    timeoutMs: 60000
    retries: 2
  m3-bare:
    provider: minimax
    model: MiniMax-M3
games:
  - label: tuned
    game: tragedy-of-the-commons
    rounds: 4
    seats:
      - { persona: ./personas/peaceful-mediator, profile: m3-tuned, count: 1, overrides: { temperature: 0.2 } }
      - { persona: ./personas/win-focused-opportunist, profile: m3-bare, count: 1 }
      - { persona: ./personas/quiet-analyst, model: haiku, count: 1 }
`;

describe('summarizeSpec — resolved sampling/reliability settings', () => {
  beforeAll(async () => {
    await fsp.writeFile(path.join(rootDir, 'tuned.yaml'), TUNED_YAML);
  });

  it('exposes the seven resolved settings, with a seat override beating its profile value', async () => {
    // Given a tuned profile plus a temperature override / When summarized / Then resolved values surface
    const result = await summarizeSpec('t:tuned.yaml', roots());
    if (!result.ok) throw new Error(`expected ok summary, got failure: ${result.failure.message}`);
    const seats = result.entries[0]?.seats;
    expect(seats?.[0]?.settings).toEqual({
      temperature: 0.2,
      topP: 0.9,
      maxCompletionTokens: 2048,
      reasoningSplit: true,
      reasoningEffort: 'high',
      timeoutMs: 60_000,
      retries: 2,
    });
  });

  it('reports all-null settings for a bare profile and null for a legacy model seat', async () => {
    const result = await summarizeSpec('t:tuned.yaml', roots());
    if (!result.ok) throw new Error(`expected ok summary, got failure: ${result.failure.message}`);
    const seats = result.entries[0]?.seats;
    expect(seats?.[1]?.settings).toEqual({
      temperature: null,
      topP: null,
      maxCompletionTokens: null,
      reasoningSplit: null,
      reasoningEffort: null,
      timeoutMs: null,
      retries: null,
    });
    expect(seats?.[2]?.settings).toBeNull();
  });

  it('never exposes apiKeyEnv names, base URLs, or raw config through the summary', async () => {
    const result = await summarizeSpec('t:tuned.yaml', roots());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('MINIMAX_API_KEY');
    expect(serialized).not.toContain('apiKeyEnv');
    expect(serialized).not.toContain('baseUrl');
    expect(serialized).not.toContain('api.minimax.io');
  });
});
