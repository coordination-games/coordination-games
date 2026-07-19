import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type RunBatchResult, runBatch } from '../orchestrate.js';
import type { ResolvedIdentity } from '../run-setup.js';
import { makeTranscriptWriter } from '../run-transcript.js';
import type { SeriesGameSnapshot } from '../series-inspect.js';
import type { TournamentState } from '../tournament-orchestration.js';
import type { TournamentBatchDependencies } from '../tournament-run.js';
import type { TournamentRunSpec } from '../tournament-types.js';
import type { AgentRunner, ResolvedSeat, RunSessionOptions, SessionResult } from '../types.js';

export type SessionCall = {
  readonly gameId: string;
  readonly botName: string;
  readonly signal: AbortSignal | undefined;
  readonly limits: RunSessionOptions['limits'];
};

type UsageEmission = {
  readonly gameId: string;
  readonly usage: unknown;
};

type FixtureOptions = {
  readonly states: readonly TournamentState[];
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly usageEmission?: UsageEmission;
  readonly providerFailureGameId?: string;
  readonly cappedGameId?: string;
  readonly snapshotFailureGameId?: string;
  readonly sleepFailure?: string;
  readonly failFlushCall?: number;
  readonly afterSnapshot?: (gameId: string) => void;
  readonly maxAggregateCostMicrousd?: number;
  readonly snapshots?: Readonly<Record<string, SeriesGameSnapshot>>;
  readonly onSeriesProgress?: (directory: string) => Promise<void>;
};

export type TournamentBatchFixture = {
  readonly directory: string;
  readonly identities: ResolvedIdentity[];
  readonly calls: {
    identityResolutions: number;
    seatResolutions: number;
    lobbyCreations: number;
    flushes: number;
    readonly seatIdentityInputs: (readonly ResolvedIdentity[])[];
    readonly lobbyIdentityInputs: (readonly ResolvedIdentity[])[];
    readonly sessions: SessionCall[];
    readonly snapshots: string[];
    readonly prompts: {
      readonly gameId: string;
      readonly botName: string;
      readonly systemPrompt: string;
    }[];
  };
  readonly dependencies: Partial<TournamentBatchDependencies>;
  readonly run: () => Promise<RunBatchResult>;
  readonly cleanup: () => Promise<void>;
};

export async function createTournamentBatchFixture(
  options: FixtureOptions,
): Promise<TournamentBatchFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-tournament-batch-'));
  const identities = fixtureIdentities();
  const seats = fixtureSeats();
  const calls: TournamentBatchFixture['calls'] = {
    identityResolutions: 0,
    seatResolutions: 0,
    lobbyCreations: 0,
    flushes: 0,
    seatIdentityInputs: [],
    lobbyIdentityInputs: [],
    sessions: [],
    snapshots: [],
    prompts: [],
  };
  let stateIndex = 0;
  let currentGameId: string | null = null;
  const runner: AgentRunner = {
    async runSession(sessionOptions): Promise<SessionResult> {
      if (currentGameId === null) throw new Error('fixture session started without a game');
      calls.sessions.push({
        gameId: currentGameId,
        botName: sessionOptions.botName,
        signal: sessionOptions.signal,
        limits: sessionOptions.limits,
      });
      calls.prompts.push({
        gameId: currentGameId,
        botName: sessionOptions.botName,
        systemPrompt: sessionOptions.systemPrompt,
      });
      if (options.usageEmission?.gameId === currentGameId) {
        sessionOptions.onEvent({
          t: 1,
          bot: sessionOptions.botName,
          kind: 'model_response',
          usage: options.usageEmission.usage,
        });
      }
      if (options.providerFailureGameId === currentGameId) {
        throw new Error(`provider failed for ${currentGameId}`);
      }
      if (options.cappedGameId === currentGameId) {
        return { finished: false, modelCalls: 30, reason: 'cap' };
      }
      return { finished: true, modelCalls: 1, reason: 'finished' };
    },
  };
  const dependencies: Partial<TournamentBatchDependencies> = {
    resolveIdentities: async () => {
      calls.identityResolutions++;
      return identities;
    },
    resolveSeats: async (_spec, inputIdentities) => {
      calls.seatResolutions++;
      calls.seatIdentityInputs.push(inputIdentities);
      return seats;
    },
    createAndJoinLobby: async (_spec, inputIdentities) => {
      calls.lobbyCreations++;
      calls.lobbyIdentityInputs.push(inputIdentities);
      return 'lobby-fixture';
    },
    makeTranscriptWriter: (runDir) => {
      const writer = makeTranscriptWriter(runDir);
      return {
        onEvent: (event) => writer.onEvent(event),
        eventsFor: (botName) => writer.eventsFor(botName),
        flush: async () => {
          calls.flushes++;
          if (calls.flushes === options.failFlushCall) {
            throw new Error(`transcript flush ${calls.flushes} failed`);
          }
          await writer.flush();
        },
      };
    },
    resolveRunnerCache: () => new Map([['fixture', runner]]),
    runnerForResolvedSeat: () => runner,
    pollState: async () => {
      const state = options.states[stateIndex] ?? options.states.at(-1);
      if (!state) throw new Error('fixture requires at least one tournament state');
      stateIndex++;
      currentGameId = state.currentGameId;
      return state;
    },
    snapshotGame: async ({ gameId }) => {
      calls.snapshots.push(gameId);
      if (options.snapshotFailureGameId === gameId) {
        throw new Error(`snapshot failed for ${gameId}`);
      }
      options.afterSnapshot?.(gameId);
      return (
        options.snapshots?.[gameId] ?? {
          outcome: { phase: 'finished', winnerLabel: gameId },
          standings: [],
          relay: [],
        }
      );
    },
    sleep: async () => {
      if (options.sleepFailure) throw new Error(options.sleepFailure);
    },
    now: options.now ?? (() => 0),
    ...(options.onSeriesProgress ? { onSeriesProgress: options.onSeriesProgress } : {}),
  };
  return {
    directory,
    identities,
    calls,
    dependencies,
    run: () =>
      runBatch(tournamentSpec(directory, options.maxAggregateCostMicrousd), {
        ...(options.signal ? { signal: options.signal } : {}),
        tournamentDependencies: dependencies,
      }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function readSeriesManifest(result: RunBatchResult): Promise<unknown> {
  return JSON.parse(await readFile(path.join(result.runDir, 'series-manifest.json'), 'utf8'));
}

export async function completedGameArtifacts(
  result: RunBatchResult,
): Promise<readonly { readonly path: string; readonly gameId: string }[]> {
  const entries = await readdir(result.runDir, { recursive: true });
  const manifests = entries
    .filter((entry) => /^games\/\d+\/manifest\.json$/.test(entry))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    manifests.map(async (manifestPath) => {
      const manifest: unknown = JSON.parse(
        await readFile(path.join(result.runDir, manifestPath), 'utf8'),
      );
      if (!isRecord(manifest) || typeof manifest.gameId !== 'string') {
        throw new Error(`invalid completed-game manifest at ${manifestPath}`);
      }
      return { path: manifestPath, gameId: manifest.gameId };
    }),
  );
}

export function runningState(
  gameId: string,
  activePlayerIds: readonly string[],
  gameIds: readonly string[] = [gameId],
): TournamentState {
  return { status: 'running', currentGameId: gameId, activePlayerIds, gameIds };
}

export function completedState(gameIds: readonly string[]): TournamentState {
  return {
    status: 'completed',
    currentGameId: null,
    activePlayerIds: [],
    gameIds,
    standings: [{ playerId: 'player-a', rank: 1 }],
  };
}

export function failedState(gameIds: readonly string[]): TournamentState {
  return {
    status: 'failed',
    currentGameId: null,
    activePlayerIds: [],
    gameIds,
    error: 'settlement failed',
  };
}

function fixtureIdentities(): ResolvedIdentity[] {
  return ['a', 'b', 'c'].map((suffix) => ({
    botName: `bot-${suffix}`,
    playerId: `player-${suffix}`,
    privateKey: `key-${suffix}`,
    address: `address-${suffix}`,
    token: `token-${suffix}`,
  }));
}

function fixtureSeats(): ResolvedSeat[] {
  return ['a', 'b', 'c'].map((suffix) => ({
    botName: `bot-${suffix}`,
    privateKey: `key-${suffix}`,
    persona: { dir: `/personas/bot-${suffix}`, systemPromptFragment: 'persona' },
    model: 'fixture-model',
    backend: 'openrouter',
    modelConfig: {
      provider: 'minimax',
      model: 'fixture-model',
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyEnv: 'MINIMAX_API_KEY',
      pricing: { promptPerMillion: 2, completionPerMillion: 2 },
    },
  }));
}

export function tournamentSpec(
  output: string,
  maxAggregateCostMicrousd?: number,
): TournamentRunSpec {
  return {
    kind: 'tournament' as const,
    game: 'tragedy-of-the-commons' as const,
    rounds: 2,
    params: {},
    server: 'http://fake.invalid',
    identities: 'ephemeral' as const,
    output,
    seats: [],
    limits: {
      maxModelCallsPerBot: 2,
      wallClockMsPerRun: 100,
      ...(maxAggregateCostMicrousd === undefined ? {} : { maxAggregateCostMicrousd }),
    },
    tournament: {
      mode: 'tragedy-series' as const,
      policy: {
        seriesLength: 3,
        baseEntryCost: '1',
        carryBps: 0,
        slashBps: 0,
        minRounds: 1,
        maxRounds: 2,
        hazardNumerator: 0,
        hazardDenominator: 1,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
