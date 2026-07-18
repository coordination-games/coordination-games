export { assemblePrompt, loadPersona, resolvePersonaDir } from './persona.js';

import { runSingleGameBatch } from './single-game-orchestration.js';
import type { TournamentBatchDependencies } from './tournament-run.js';
import { runTournamentBatch } from './tournament-run.js';
import { type CampaignSpec, isTournamentRun } from './tournament-types.js';

export { writeManifest } from './run-artifacts.js';
export { makeTranscriptWriter } from './run-transcript.js';

export interface RunBatchResult {
  readonly runDir: string;
  readonly lobbyId: string;
  readonly gameId: string;
  readonly manifest: unknown;
}

export interface RunBatchOptions {
  readonly signal?: AbortSignal;
  readonly tournamentDependencies?: Partial<TournamentBatchDependencies>;
}

export type RunBatchDependencies = {
  readonly runSingleGameBatch: typeof runSingleGameBatch;
  readonly runTournamentBatch: typeof runTournamentBatch;
};

const DEFAULT_DEPENDENCIES: RunBatchDependencies = {
  runSingleGameBatch,
  runTournamentBatch,
};

export async function runBatch(
  spec: CampaignSpec,
  options: RunBatchOptions = {},
  overrides: Partial<RunBatchDependencies> = {},
): Promise<RunBatchResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return isTournamentRun(spec)
    ? dependencies.runTournamentBatch(spec, options, { ...options.tournamentDependencies })
    : dependencies.runSingleGameBatch(spec);
}
