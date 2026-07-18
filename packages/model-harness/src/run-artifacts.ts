import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TranscriptWriter } from './run-transcript.js';
import type { RunBudget } from './runners/run-budget.js';
import { consequentialCounts } from './transcript.js';
import type { ResolvedSeat, RunSpec, SessionResult } from './types.js';

export async function writeManifest(input: {
  readonly runDir: string;
  readonly runId: string;
  readonly spec: RunSpec;
  readonly lobbyId: string;
  readonly gameId: string;
  readonly seats: readonly ResolvedSeat[];
  readonly sessionResults: ReadonlyMap<string, SessionResult>;
  readonly writer: TranscriptWriter;
  readonly outcome: unknown;
  readonly usage: ReturnType<RunBudget['totals']>;
  readonly budgetError: Error | undefined;
}): Promise<void> {
  const perBot = input.seats.map((seat) => {
    const result = input.sessionResults.get(seat.botName) ?? {
      finished: false,
      modelCalls: 0,
      reason: 'error' as const,
    };
    const counts = consequentialCounts([...input.writer.eventsFor(seat.botName)]);
    return {
      bot: seat.botName,
      persona: seat.persona.dir,
      model: seat.model,
      backend: seat.backend,
      ...(seat.modelConfig ? { modelConfig: seat.modelConfig } : {}),
      modelCalls: result.modelCalls,
      ...counts,
      finished: result.finished,
      reason: result.reason,
    };
  });
  const manifest = {
    runId: input.runId,
    spec: input.spec,
    lobbyId: input.lobbyId,
    gameId: input.gameId,
    seats: input.seats.map((seat) => ({
      bot: seat.botName,
      persona: seat.persona.dir,
      model: seat.model,
      backend: seat.backend,
      ...(seat.modelConfig ? { modelConfig: seat.modelConfig } : {}),
    })),
    outcome: input.outcome,
    perBot,
    usage: input.usage,
    ...(input.budgetError
      ? { budgetError: { name: input.budgetError.name, message: input.budgetError.message } }
      : {}),
  };
  await fs.writeFile(
    path.join(input.runDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function snapshotArtifacts(input: {
  readonly runDir: string;
  readonly server: string;
  readonly gameId: string;
  readonly inspectToken: string;
  readonly inspect: (path: string) => Promise<unknown>;
}): Promise<unknown> {
  const inspect = await waitForFinished(input);
  await writeRelayLog(input.runDir, input.gameId, inspect);
  return buildOutcome(inspect);
}

async function waitForFinished(input: {
  readonly server: string;
  readonly gameId: string;
  readonly inspectToken: string;
  readonly inspect: (path: string) => Promise<unknown>;
}): Promise<unknown> {
  const deadline = Date.now() + 180_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const inspect = await input.inspect(`/api/admin/session/${input.gameId}/inspect`);
      last = inspect;
      const gameInspect = record(inspect)?.gameInspect;
      const state = record(gameInspect)?.gameState ?? record(gameInspect)?.state;
      if (record(gameInspect)?.isOver === true || record(state)?.phase === 'finished')
        return inspect;
    } catch (error) {
      console.log(`  [orchestrate] inspect poll failed: ${String(error).slice(0, 120)}`);
    }
    await sleep(3000);
  }
  return last;
}

async function writeRelayLog(runDir: string, gameId: string, inspect: unknown): Promise<void> {
  const relayMessages = record(record(inspect)?.gameInspect)?.relayMessages;
  if (Array.isArray(relayMessages)) {
    const lines = relayMessages.map((message) => JSON.stringify(message)).join('\n');
    await fs.writeFile(path.join(runDir, 'relay.jsonl'), lines ? `${lines}\n` : '');
    return;
  }
  await fs.writeFile(
    path.join(runDir, 'relay.jsonl'),
    `${JSON.stringify({ warning: 'no gameInspect.relayMessages in inspect', gameId })}\n`,
  );
}

function buildOutcome(inspect: unknown): unknown {
  const gameInspect = record(inspect)?.gameInspect;
  const inspectRecord = record(gameInspect);
  const state = record(inspectRecord?.gameState) ?? record(inspectRecord?.state) ?? {};
  const replayChrome = record(inspectRecord?.replayChrome) ?? {};
  return {
    phase: state.phase ?? null,
    round: state.round ?? null,
    isFinished: inspectRecord?.isOver ?? replayChrome.isFinished ?? state.phase === 'finished',
    winnerLabel: replayChrome.winnerLabel ?? null,
    statusVariant: replayChrome.statusVariant ?? null,
    outcome: inspectRecord?.outcome ?? null,
    summary: inspectRecord?.summary ?? null,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
