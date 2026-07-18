import { promises as fs } from 'node:fs';
import path from 'node:path';
import { api } from './coga-client.js';
import type { RunBatchOptions, RunBatchResult } from './orchestrate.js';
import { assemblePrompt } from './persona.js';
import { snapshotArtifacts } from './run-artifacts.js';
import {
  createAndJoinLobby,
  type ResolvedIdentity,
  resolveIdentities,
  resolveSeats,
} from './run-setup.js';
import { makeTranscriptWriter, type TranscriptWriter } from './run-transcript.js';
import { resolveRunnerCache, runnerForResolvedSeat } from './runner-resolution.js';
import { RunBudget } from './runners/run-budget.js';
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
    readonly runDir: string;
    readonly server: string;
    readonly gameId: string;
  }) => Promise<unknown>;
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
    snapshotGame: async ({ runDir, server, gameId }) =>
      snapshotArtifacts({
        runDir,
        server,
        gameId,
        inspectToken: process.env.INSPECTOR_TOKEN ?? 'local-inspector-token',
        inspect: (endpoint) =>
          api(server, endpoint, {
            headers: { 'X-Admin-Token': process.env.INSPECTOR_TOKEN ?? 'local-inspector-token' },
          }),
      }),
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
  const budget = new RunBudget(spec.limits.maxAggregateCostMicrousd);
  const runners = dependencies.resolveRunnerCache(seats);
  const deadline = dependencies.now() + spec.limits.wallClockMsPerRun;
  const tournamentId = `lobby:${lobbyId}`;
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
        systemPrompt: `${assemblePrompt(seat.botName, seat.persona)}\n\n${seriesContext(
          gameId,
          completedGameIds,
        )}`,
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
          if (event.kind === 'model_response' && event.usage !== undefined) {
            budget.record(event.usage, seat.modelConfig?.pricing);
          }
        },
      }),
    flush: () => writer.flush(),
    onGameComplete: async ({ gameId: completedGameId, gameIndex, sessionResults }) => {
      const gameDir = path.join(runDir, 'games', String(gameIndex));
      await fs.mkdir(gameDir, { recursive: true });
      const outcome = await dependencies.snapshotGame({
        runDir: gameDir,
        server: spec.server,
        gameId: completedGameId,
      });
      await fs.writeFile(
        path.join(gameDir, 'manifest.json'),
        `${JSON.stringify(
          {
            gameId: completedGameId,
            sessions: [...sessionResults.entries()].map(([bot, result]) => ({ bot, ...result })),
            outcome,
          },
          null,
          2,
        )}\n`,
      );
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
  const manifest = {
    runId,
    kind: 'tournament',
    status: series.status,
    ...(series.error ? { error: series.error } : {}),
    lobbyId,
    tournamentId,
    gameIds: series.gameIds,
    standings: series.finalStandings,
    seats: seats.map((seat) => ({
      bot: seat.botName,
      model: seat.model,
      backend: seat.backend,
      ...(seat.modelConfig ? { modelConfig: seat.modelConfig } : {}),
    })),
    games: [...series.sessionResults.entries()].map(([id, results]) => ({
      gameId: id,
      sessions: [...results.entries()].map(([bot, result]) => ({ bot, ...result })),
    })),
    usage: budget.totals(),
    ...(budgetError
      ? { budgetError: { name: budgetError.name, message: budgetError.message } }
      : {}),
  };
  await fs.writeFile(
    path.join(runDir, 'series-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { runDir, lobbyId, gameId, manifest };
}

function seriesContext(currentGameId: string, completedGameIds: readonly string[]): string {
  const history = completedGameIds.slice(0, -1).join(', ');
  return history
    ? `Tournament continuity: completed public game ids ${history}; now playing ${currentGameId}. Do not infer private context from other players.`
    : `Tournament continuity: you are playing game ${currentGameId}. Do not infer private context from other players.`;
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
