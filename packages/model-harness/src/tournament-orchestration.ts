import type { SessionResult } from './types.js';

export type TournamentStatus = 'running' | 'completed' | 'failed';

export type TournamentStanding = {
  readonly playerId: string;
  readonly rank?: number;
  readonly cumulativeDelta?: string;
};

export type TournamentState = {
  readonly status: TournamentStatus;
  readonly currentGameId: string | null;
  readonly activePlayerIds: readonly string[];
  readonly gameIds: readonly string[];
  readonly standings?: readonly TournamentStanding[];
  readonly error?: string;
};

export type SeriesSession<Seat extends { readonly botName: string }> = {
  readonly gameId: string;
  readonly completedGameIds: readonly string[];
  readonly seat: Seat;
};

export type TournamentSeriesResult = {
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  readonly gameIds: readonly string[];
  readonly finalStandings: readonly TournamentStanding[];
  readonly error?: string;
  readonly sessionResults: ReadonlyMap<string, ReadonlyMap<string, SessionResult>>;
};

type SeriesProgress = Pick<TournamentSeriesResult, 'gameIds' | 'sessionResults'>;

type SeriesTerminal = {
  readonly error?: string;
  readonly finalStandings?: readonly TournamentStanding[];
};

type SeriesInput<Seat extends { readonly botName: string }> = {
  readonly identities: readonly { readonly botName: string; readonly playerId: string }[];
  readonly seats: readonly Seat[];
  readonly pollState: () => Promise<TournamentState>;
  readonly runSession: (session: SeriesSession<Seat>) => Promise<SessionResult>;
  readonly flush: () => Promise<void>;
  readonly onGameComplete?: (input: {
    readonly gameId: string;
    readonly gameIndex: number;
    readonly sessionResults: ReadonlyMap<string, SessionResult>;
  }) => Promise<void>;
  readonly now: () => number;
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly sleep?: () => Promise<void>;
  readonly stopReason?: () => string | undefined;
};

export async function runTournamentSeries<Seat extends { readonly botName: string }>(
  input: SeriesInput<Seat>,
): Promise<TournamentSeriesResult> {
  const processedGameIds = new Set<string>();
  const observedGameIds: string[] = [];
  const results = new Map<string, ReadonlyMap<string, SessionResult>>();
  const progress: SeriesProgress = { gameIds: observedGameIds, sessionResults: results };

  try {
    while (input.now() < input.deadline) {
      if (input.signal?.aborted) return result('cancelled', progress);
      const stopReason = input.stopReason?.();
      if (stopReason) return result('failed', progress, { error: stopReason });

      let state: TournamentState;
      try {
        state = await input.pollState();
      } catch (error) {
        return result('failed', progress, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      appendUnique(observedGameIds, state.gameIds);
      switch (state.status) {
        case 'completed':
          return result('completed', progress, { finalStandings: state.standings ?? [] });
        case 'failed':
          return result('failed', progress, {
            ...(state.error ? { error: state.error } : {}),
            finalStandings: state.standings ?? [],
          });
        case 'running':
          break;
        default: {
          const unhandledStatus: never = state.status;
          return unhandledStatus;
        }
      }

      const gameId = state.currentGameId;
      if (gameId === null || processedGameIds.has(gameId)) {
        await input.sleep?.();
        continue;
      }
      if (input.signal?.aborted) return result('cancelled', progress);

      const activeSeats = activeSeatsFor(state.activePlayerIds, input.identities, input.seats);
      processedGameIds.add(gameId);
      appendUnique(observedGameIds, [gameId]);
      const gameResults = new Map<string, SessionResult>();
      let sessionFailure: string | undefined;
      await Promise.all(
        activeSeats.map(async (seat) => {
          try {
            gameResults.set(
              seat.botName,
              await input.runSession({ gameId, completedGameIds: observedGameIds, seat }),
            );
          } catch (error) {
            sessionFailure ??= error instanceof Error ? error.message : String(error);
            gameResults.set(seat.botName, { finished: false, modelCalls: 0, reason: 'error' });
          }
        }),
      );
      results.set(gameId, gameResults);
      if (input.signal?.aborted) return result('cancelled', progress);
      const afterGameStop = input.stopReason?.();
      if (afterGameStop) return result('failed', progress, { error: afterGameStop });
      if (sessionFailure || [...gameResults.values()].some((session) => !session.finished)) {
        return result('failed', progress, {
          error: sessionFailure ?? 'A player session did not finish',
        });
      }
      try {
        await input.flush();
        await input.onGameComplete?.({
          gameId,
          gameIndex: results.size - 1,
          sessionResults: gameResults,
        });
      } catch (error) {
        return result('failed', progress, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result('timed_out', progress, { error: 'Tournament wall-clock limit exceeded' });
  } catch (error) {
    return result('failed', progress, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function activeSeatsFor<Seat extends { readonly botName: string }>(
  activePlayerIds: readonly string[],
  identities: SeriesInput<Seat>['identities'],
  seats: SeriesInput<Seat>['seats'],
): readonly Seat[] {
  const activePlayers = new Set(activePlayerIds);
  const playerIdByBot = new Map(
    identities.map((identity) => [identity.botName, identity.playerId]),
  );
  return seats.filter((seat) => activePlayers.has(playerIdByBot.get(seat.botName) ?? ''));
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function result(
  status: TournamentSeriesResult['status'],
  progress: SeriesProgress,
  terminal: SeriesTerminal = {},
): TournamentSeriesResult {
  return {
    status,
    gameIds: progress.gameIds,
    finalStandings: terminal.finalStandings ?? [],
    sessionResults: progress.sessionResults,
    ...(terminal.error ? { error: terminal.error } : {}),
  };
}
