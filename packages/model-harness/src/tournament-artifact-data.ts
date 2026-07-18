import type {
  ResolvedSeriesConfigInput,
  SeriesManifestInput,
  SeriesManifestSeat,
} from './series-artifacts.js';
import type { TournamentSeriesResult } from './tournament-orchestration.js';
import type { TournamentRunSpec } from './tournament-types.js';
import type { ResolvedSeat } from './types.js';

type BudgetError = { readonly name: string; readonly message: string };

export type FinalTournamentArtifacts = {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly series: SeriesManifestInput;
  readonly analysis: SeriesManifestInput;
};

export function resolvedTournamentConfig(
  spec: TournamentRunSpec,
  seats: readonly ResolvedSeat[],
): ResolvedSeriesConfigInput {
  return {
    game: spec.game,
    params: spec.params,
    limits: spec.limits,
    tournament: spec.tournament,
    disablePlugins: spec.disablePlugins,
    seats: seats.map(projectSeat),
  };
}

export function finalTournamentArtifacts(input: {
  readonly runId: string;
  readonly lobbyId: string;
  readonly tournamentId: string;
  readonly seats: readonly ResolvedSeat[];
  readonly result: TournamentSeriesResult;
  readonly usage: unknown;
  readonly budgetError: BudgetError | undefined;
  readonly completedGameIds: ReadonlySet<string>;
}): FinalTournamentArtifacts {
  const availableGames: NonNullable<SeriesManifestInput['availableGames']> =
    input.result.gameIds.map((gameId, gameIndex) => ({
      gameId,
      gameIndex,
      status: input.completedGameIds.has(gameId) ? 'completed' : 'incomplete',
    }));
  const analysis: SeriesManifestInput = {
    status: input.result.status,
    gameIds: input.result.gameIds,
    standings: input.result.finalStandings,
    usage: input.usage,
    ...(input.result.error ? { error: input.result.error } : {}),
    availableGames,
  };
  const series: SeriesManifestInput = {
    ...analysis,
    lobbyId: input.lobbyId,
    tournamentId: input.tournamentId,
    seats: input.seats.map(projectSeat),
    games: [...input.result.sessionResults.entries()].map(([gameId, results]) => ({
      gameId,
      sessions: [...results.entries()].map(([bot, result]) => ({ bot, ...result })),
    })),
    ...(input.budgetError ? { budgetError: input.budgetError } : {}),
  };
  return {
    manifest: { runId: input.runId, kind: 'tournament', ...series },
    series,
    analysis,
  };
}

function projectSeat(seat: ResolvedSeat): SeriesManifestSeat {
  return {
    bot: seat.botName,
    persona: seat.persona.dir,
    model: seat.model,
    backend: seat.backend,
    ...(seat.modelConfig ? { modelConfig: seat.modelConfig } : {}),
  };
}
