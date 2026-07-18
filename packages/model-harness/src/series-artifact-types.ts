import type { ResolvedModelProfile } from './model-profile-types.js';
import type { SeriesGameHistory, SeriesRelayScope } from './series-context.js';
import type { TragedySeriesTournamentRequest } from './tournament-types.js';
import type { Backend, RunLimits } from './types.js';

export type SeriesRawRelay = {
  readonly index: number;
  readonly type: string;
  readonly pluginId: string;
  readonly sender: string;
  readonly scope: SeriesRelayScope;
  readonly turn: number | null;
  readonly timestamp?: number;
  readonly data: unknown;
};

export type SeriesGameArtifactInput = {
  readonly gameId: string;
  readonly gameIndex: number;
  readonly outcome: unknown;
  readonly standings: readonly { readonly playerId: string; readonly rank?: number }[];
  readonly relay: readonly SeriesRawRelay[];
  readonly botEvents: Readonly<Record<string, readonly unknown[]>>;
  readonly viewers: Readonly<
    Record<string, { readonly playerId: string; readonly handle: string }>
  >;
};

export type SeriesManifestSeat = {
  readonly bot: string;
  readonly persona: string;
  readonly model: string;
  readonly backend: Backend;
  readonly modelConfig?: ResolvedModelProfile;
};

export type AvailableSeriesGame = {
  readonly gameId: string;
  readonly gameIndex: number;
  readonly status: 'completed' | 'incomplete';
};

export type SeriesManifestInput = {
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  readonly gameIds: readonly string[];
  readonly standings: readonly { readonly playerId: string; readonly rank?: number }[];
  readonly usage: unknown;
  readonly error?: string;
  readonly lobbyId?: string;
  readonly tournamentId?: string;
  readonly seats?: readonly SeriesManifestSeat[];
  readonly games?: readonly unknown[];
  readonly budgetError?: { readonly name: string; readonly message: string };
  readonly availableGames?: readonly AvailableSeriesGame[];
};

export type ResolvedSeriesConfigInput = {
  readonly game: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly limits: RunLimits;
  readonly tournament: TragedySeriesTournamentRequest;
  readonly disablePlugins: readonly string[] | undefined;
  readonly seats: readonly SeriesManifestSeat[];
};

export type SeriesArtifactWriter = {
  writeResolvedConfig(config: ResolvedSeriesConfigInput): Promise<void>;
  writeGame(input: SeriesGameArtifactInput): Promise<SeriesGameHistory>;
  writeSeries(input: SeriesManifestInput): Promise<void>;
  writeAnalysisInput(input: SeriesManifestInput): Promise<void>;
  writeError(error: Error): Promise<void>;
};

export type ArtifactWriterInput = {
  readonly runDir: string;
  readonly runId: string;
  readonly beforeRename?: (targetPath: string) => void;
};
