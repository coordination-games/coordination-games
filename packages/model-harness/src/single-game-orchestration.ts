import { promises as fs } from 'node:fs';
import path from 'node:path';
import { api } from './coga-client.js';
import type { RunBatchResult } from './orchestrate.js';
import { assemblePrompt } from './persona.js';
import { snapshotArtifacts, writeManifest } from './run-artifacts.js';
import { createAndJoinLobby, pollForGameId, resolveIdentities, resolveSeats } from './run-setup.js';
import { makeTranscriptWriter } from './run-transcript.js';
import { resolveRunnerCache, runnerForResolvedSeat } from './runner-resolution.js';
import { RunBudget } from './runners/run-budget.js';
import type { RunSpec, SessionResult } from './types.js';

export async function runSingleGameBatch(spec: RunSpec): Promise<RunBatchResult> {
  const runId = `run-${Date.now()}${spec.label ? `-${slugify(spec.label)}` : ''}`;
  const runDir = path.resolve(spec.output, runId);
  await fs.mkdir(runDir, { recursive: true });
  const identities = await resolveIdentities(spec);
  const seats = await resolveSeats(spec, identities);
  const lobbyId = await createAndJoinLobby(spec, identities);
  const writer = makeTranscriptWriter(runDir);
  const budget = new RunBudget(spec.limits.maxAggregateCostMicrousd);
  const results = new Map<string, SessionResult>();
  let sessionsDone = false;
  const gameIdPromise = pollForGameId({
    server: spec.server,
    lobbyId,
    deadline: Date.now() + spec.limits.wallClockMsPerRun,
    isDone: () => sessionsDone,
  });
  const runners = resolveRunnerCache(seats);
  await Promise.all(
    seats.map(async (seat) => {
      const result = await runnerForResolvedSeat(runners, seat).runSession({
        botName: seat.botName,
        privateKey: seat.privateKey,
        server: spec.server,
        systemPrompt: assemblePrompt(seat.botName, seat.persona),
        model: seat.model,
        ...(seat.modelConfig ? { modelConfig: seat.modelConfig } : {}),
        limits: {
          maxModelCalls: spec.limits.maxModelCallsPerBot,
          wallClockMs: spec.limits.wallClockMsPerRun,
        },
        ...(spec.disablePlugins ? { disablePlugins: spec.disablePlugins } : {}),
        budget,
        onEvent(event) {
          writer.onEvent(event);
          if (event.kind === 'model_response' && event.usage !== undefined) {
            budget.record(event.usage, seat.modelConfig?.pricing);
          }
        },
      });
      results.set(seat.botName, result);
    }),
  );
  sessionsDone = true;
  await writer.flush();
  const gameId = (await gameIdPromise) ?? '';
  const outcome = gameId
    ? await snapshotArtifacts({
        runDir,
        server: spec.server,
        gameId,
        inspectToken: process.env.INSPECTOR_TOKEN ?? 'local-inspector-token',
        inspect: (endpoint) =>
          api(spec.server, endpoint, {
            headers: { 'X-Admin-Token': process.env.INSPECTOR_TOKEN ?? 'local-inspector-token' },
          }),
      })
    : null;
  await writeManifest({
    runDir,
    runId,
    spec,
    lobbyId,
    gameId,
    seats,
    sessionResults: results,
    writer,
    outcome,
    usage: budget.totals(),
    budgetError: budget.error(),
  });
  const manifest: unknown = JSON.parse(
    await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8'),
  );
  return { runDir, lobbyId, gameId, manifest };
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'run'
  );
}
