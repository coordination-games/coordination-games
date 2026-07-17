import type { RunSpec } from './types.js';

export type TournamentPolicy = {
  readonly seriesLength: number;
  readonly baseEntryCost: string;
  readonly carryBps: number;
  readonly slashBps: number;
  readonly minRounds: number;
  readonly maxRounds: number;
  readonly hazardNumerator: number;
  readonly hazardDenominator: number;
};

export type TragedySeriesTournamentRequest = {
  readonly mode: 'tragedy-series';
  readonly policy: TournamentPolicy;
};

export type TournamentRunSpec = Omit<RunSpec, 'rounds'> & {
  readonly kind: 'tournament';
  readonly game: 'tragedy-of-the-commons';
  readonly rounds: TournamentPolicy['maxRounds'];
  readonly tournament: TragedySeriesTournamentRequest;
};

export type CampaignSpec = RunSpec | TournamentRunSpec;

export function isTournamentRun(spec: CampaignSpec): spec is TournamentRunSpec {
  return 'kind' in spec && spec.kind === 'tournament';
}
