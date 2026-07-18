import { promises as fs } from 'node:fs';
import path from 'node:path';
import { api } from './coga-client.js';
import type { RunBatchOptions, RunBatchResult } from './orchestrate.js';
import { assemblePrompt } from './persona.js';
import {
  createAndJoinLobby,
  type ResolvedIdentity,
  resolveIdentities,
  resolveSeats,
} from './run-setup.js';
import { makeTranscriptWriter, type TranscriptWriter } from './run-transcript.js';
import { resolveRunnerCache, runnerForResolvedSeat } from './runner-resolution.js';
import { RunBudget } from './runners/run-budget.js';
import { createSeriesArtifactWriter } from './series-artifacts.js';
import { buildSeriesContext, type SeriesGameHistory } from './series-context.js';
import { extractSeriesGameSnapshot, type SeriesGameSnapshot } from './series-inspect.js';
import { finalTournamentArtifacts, resolvedTournamentConfig } from './tournament-artifact-data.js';
import { runTournamentSeries, type TournamentState } from './tournament-orchestration.js';
import { parseTournamentState } from './tournament-state.js';
import type { TournamentRunSpec } from './tournament-types.js';
import type { AgentRunner, ResolvedSeat } from './types.js';

export type TournamentBatchDependencies = {
  readonly resolveIdentities: (spec: TournamentRunSpec) => Promise<ResolvedIdentity[]>;
  readonly resolveSeats: (
    spec: TournamentRunSpec,
    identities: readonly ResolvedIdentity[],
  ) => Promise<ResolvedSeat[]>;
  readonly createAndJoinLobby: (
    spec: TournamentRunSpec,
    identities: readonly ResolvedIdentity[],
  ) => Promise<string>;
  readonly makeTranscriptWriter: (runDir: string) => TranscriptWriter;
  readonly resolveRunnerCache: (seats: readonly ResolvedSeat[]) => ReadonlyMap<string, AgentRunner>;
  readonly runnerForResolvedSeat: (
    cache: ReadonlyMap<string, AgentRunner>,
    seat: ResolvedSeat,
  ) => AgentRunner;
  readonly pollState: (server: string, tournamentId: string) => Promise<TournamentState>;
  readonly snapshotGame: (input: {
    readonly server: string;
    readonly gameId: string;
  }) => Promise<SeriesGameSnapshot>;
  readonly sleep: () => Promise<void>;
  readonly now: () => number;
};

export function createTournamentBatchDependencies(
  overrides: Partial<TournamentBatchDependencies> = {},
): TournamentBatchDependencies {
  return {
    resolveIdentities,
    resolveSeats,
    createAndJoinLobby,
    makeTranscriptWriter,
    resolveRunnerCache,
    runnerForResolvedSeat,
    pollState: async (server, tournamentId) =>
      parseTournamentState(
        await api(server, `/api/tournaments/${encodeURIComponent(tournamentId)}/state`),
      ),
    snapshotGame: async ({ server, gameId }) =>
      extractSeriesGameSnapshot(
        await api(server, `/api/admin/session/${encodeURIComponent(gameId)}/inspect`, {
          headers: { 'X-Admin-Token': process.env.INSPECTOR_TOKEN ?? 'local-inspector-token' },
        }),
      ),
    sleep: () => sleep(1_500),
    now: Date.now,
    ...overrides,
  };
}

export async function runTournamentBatch(
  spec: TournamentRunSpec,
  options: RunBatchOptions = {},
  overrides: Partial<TournamentBatchDependencies> = {},
): Promise<RunBatchResult> {
  const dependencies = createTournamentBatchDependencies(overrides);
  const runId = `run-${Date.now()}${spec.label ? `-${slugify(spec.label)}` : ''}`;
  const runDir = path.resolve(spec.output, runId);
  await fs.mkdir(runDir, { recursive: true });
  const identities = await dependencies.resolveIdentities(spec);
  const seats = await dependencies.resolveSeats(spec, identities);
  const lobbyId = await dependencies.createAndJoinLobby(spec, identities);
  const writer = dependencies.makeTranscriptWriter(runDir);
  const artifacts = createSeriesArtifactWriter({ runDir, runId });
  await artifacts.writeResolvedConfig(resolvedTournamentConfig(spec, seats));
  await artifacts.writeSeries({ status: 'running', gameIds: [], standings: [], usage: {} });
  const budget = new RunBudget(spec.limits.maxAggregateCostMicrousd);
  const runners = dependencies.resolveRunnerCache(seats);
  const deadline = dependencies.now() + spec.limits.wallClockMsPerRun;
  const tournamentId = `lobby:${lobbyId}`;
  const playerIdByBot = new Map(
    identities.map((identity) => [identity.botName, identity.playerId]),
  );
  const history: SeriesGameHistory[] = [];
  const gameEvents = new Map<string, Map<string, unknown[]>>();
  let series = await runTournamentSeries({
    identities,
    seats,
    deadline,
    now: dependencies.now,
    ...(options.signal ? { signal: options.signal } : {}),
    sleep: dependencies.sleep,
    stopReason: () => budget.error()?.message,
    pollState: () => dependencies.pollState(spec.server, tournamentId),
    runSession: async ({ gameId, completedGameIds, seat }) =>
      dependencies.runnerForResolvedSeat(runners, seat).runSession({
        botName: seat.botName,
        privateKey: seat.privateKey,
        server: spec.server,
        systemPrompt: `${assemblePrompt(seat.botName, seat.persona)}\n\n${buildSeriesContext({
          currentGameId: gameId,
          viewerPlayerId: playerIdByBot.get(seat.botName) ?? seat.botName,
          viewerHandle: seat.botName,
          history: history.filter((entry) => completedGameIds.includes(entry.gameId)),
        })}`,
        model: seat.model,
        ...(seat.modelConfig ? { modelConfig: seat.modelConfig } : {}),
        limits: {
          maxModelCalls: spec.limits.maxModelCallsPerBot,
          wallClockMs: spec.limits.wallClockMsPerRun,
        },
        ...(spec.disablePlugins ? { disablePlugins: spec.disablePlugins } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        budget,
        onEvent(event) {
          writer.onEvent(event);
          const eventsByBot = gameEvents.get(gameId) ?? new Map<string, unknown[]>();
          const events = eventsByBot.get(seat.botName) ?? [];
          events.push(event);
          eventsByBot.set(seat.botName, events);
          gameEvents.set(gameId, eventsByBot);
          if (event.kind === 'model_response' && event.usage !== undefined) {
            budget.record(event.usage, seat.modelConfig?.pricing);
          }
        },
      }),
    flush: () => writer.flush(),
    onGameComplete: async ({ gameId: completedGameId, gameIndex, sessionResults }) => {
      const snapshot = await dependencies.snapshotGame({
        server: spec.server,
        gameId: completedGameId,
      });
      const gameHistory = await artifacts.writeGame({
        gameId: completedGameId,
        gameIndex,
        outcome: snapshot.outcome,
        standings: snapshot.standings,
        relay: snapshot.relay,
        viewers: Object.fromEntries(
          [...sessionResults.keys()].flatMap((botName) => {
            const playerId = playerIdByBot.get(botName);
            return playerId ? [[botName, { playerId, handle: botName }]] : [];
          }),
        ),
        botEvents: Object.fromEntries(
          [...sessionResults.keys()].map((botName) => [
            botName,
            gameEvents.get(completedGameId)?.get(botName) ?? [],
          ]),
        ),
      });
      history.push(gameHistory);
      await artifacts.writeSeries({
        status: 'running',
        gameIds: history.map((entry) => entry.gameId),
        availableGames: history.map((entry, gameIndex) => ({
          gameId: entry.gameId,
          gameIndex,
          status: 'completed',
        })),
        standings: snapshot.standings,
        usage: budget.totals(),
      });
    },
  });
  try {
    await writer.flush();
  } catch (error) {
    series = {
      ...series,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const gameId = series.gameIds.at(-1) ?? '';
  const budgetError = budget.error();
  const output = finalTournamentArtifacts({
    runId,
    lobbyId,
    tournamentId,
    seats,
    result: series,
    usage: budget.totals(),
    budgetError: budgetError ? { name: budgetError.name, message: budgetError.message } : undefined,
    completedGameIds: new Set(history.map((entry) => entry.gameId)),
  });
  if (series.error) await artifacts.writeError(new Error(series.error));
  await artifacts.writeSeries(output.series);
  await artifacts.writeAnalysisInput(output.analysis);
  return { runDir, lobbyId, gameId, manifest: output.manifest };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
