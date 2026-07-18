import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTranscriptWriter, writeManifest } from '../orchestrate.js';
import { RunBudget } from '../runners/run-budget.js';
import type { ResolvedSeat, RunSpec, SessionResult } from '../types.js';

describe('run artifacts', () => {
  it('Given profile-backed usage that crosses a budget, when partial artifacts are flushed, then manifest and transcript persist redacted profile and typed budget failure', async () => {
    // Given
    const runDir = await mkdtemp(path.join(tmpdir(), 'harness-run-artifacts-'));
    const writer = makeTranscriptWriter(runDir);
    const budget = new RunBudget(1);
    const seat = profileSeat();
    const spec = runSpec(runDir);
    budget.record({ prompt_tokens: 1, completion_tokens: 0 }, { promptPerMillion: 2 });
    const budgetError = budget.error();
    if (budgetError)
      writer.onEvent({
        t: 1,
        bot: seat.botName,
        kind: 'session',
        event: 'error',
        detail: budgetError.name,
      });

    // When
    await writer.flush();
    await writeManifest({
      runDir,
      runId: 'run-test',
      spec,
      lobbyId: 'lobby-test',
      gameId: '',
      seats: [seat],
      sessionResults: new Map<string, SessionResult>([
        [seat.botName, { finished: false, modelCalls: 1, reason: 'error' }],
      ]),
      writer,
      outcome: null,
      usage: budget.totals(),
      budgetError: budget.error(),
    });

    // Then
    const manifest = await readFile(path.join(runDir, 'manifest.json'), 'utf8');
    const transcript = await readFile(path.join(runDir, 'bots', 'bot-test.jsonl'), 'utf8');
    expect(manifest).toContain('MINIMAX_API_KEY');
    expect(manifest).toContain('RunBudgetExceededError');
    expect(manifest).toContain('costMicrousd');
    expect(manifest).not.toContain('private-test-value');
    expect(transcript).toContain('RunBudgetExceededError');
  });
});

function profileSeat(): ResolvedSeat {
  return {
    botName: 'bot-test',
    privateKey: 'private-key',
    persona: { dir: '/persona', systemPromptFragment: 'persona' },
    model: 'MiniMax-M3',
    backend: 'openrouter',
    modelConfig: {
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyEnv: 'MINIMAX_API_KEY',
    },
  };
}

function runSpec(output: string): RunSpec {
  return {
    game: 'test',
    rounds: 1,
    params: {},
    server: 'http://127.0.0.1:8787',
    identities: 'ephemeral',
    output,
    seats: [],
    limits: { maxModelCallsPerBot: 1, wallClockMsPerRun: 1, maxAggregateCostMicrousd: 1 },
  };
}
