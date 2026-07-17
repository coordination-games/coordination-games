import type { NamedModelProfiles } from './model-profiles.js';
import { parseSeats } from './spec-seats.js';
import type {
  TournamentPolicy,
  TournamentRunSpec,
  TragedySeriesTournamentRequest,
} from './tournament-types.js';
import type { RunLimits } from './types.js';

const TRAGEDY_GAME = 'tragedy-of-the-commons';
const TOURNAMENT_KEYS = ['mode', 'policy'] as const;
const POLICY_KEYS = [
  'seriesLength',
  'baseEntryCost',
  'carryBps',
  'slashBps',
  'minRounds',
  'maxRounds',
  'hazardNumerator',
  'hazardDenominator',
] as const;

type TournamentRunDefaults = {
  readonly server: string;
  readonly identities: 'ephemeral' | 'pool';
  readonly output: string;
  readonly limits: RunLimits;
  readonly params: Record<string, unknown>;
  readonly analysis?: NonNullable<TournamentRunSpec['analysis']>;
  readonly disablePlugins?: string[];
};

export function parseTournamentRunSpec(
  obj: Record<string, unknown>,
  filePath: string,
  profiles: NamedModelProfiles | undefined,
  location: string,
  defaults: TournamentRunDefaults,
): TournamentRunSpec {
  if (obj.game !== TRAGEDY_GAME) {
    throw new Error(
      `run-spec at ${filePath}: ${location}.game must be "${TRAGEDY_GAME}" for tournament entries`,
    );
  }
  if (obj.rounds !== undefined) {
    throw new Error(
      `run-spec at ${filePath}: ${location}.rounds is not allowed for tournament entries; policy.maxRounds is authoritative`,
    );
  }
  const tournament = parseTournamentRequest(obj.tournament, filePath, location);
  return {
    kind: 'tournament',
    game: TRAGEDY_GAME,
    rounds: tournament.policy.maxRounds,
    ...defaults,
    seats: parseSeats(obj.seats, filePath, profiles, location),
    tournament,
  };
}

function parseTournamentRequest(
  value: unknown,
  filePath: string,
  location: string,
): TragedySeriesTournamentRequest {
  const where = `${location}.tournament`;
  const tournament = requireRecord(value, where, filePath);
  assertAllowedKeys(tournament, TOURNAMENT_KEYS, where, filePath);
  if (tournament.mode !== 'tragedy-series')
    throw new Error(`run-spec at ${filePath}: ${where}.mode must be "tragedy-series"`);
  return {
    mode: 'tragedy-series',
    policy: parsePolicy(tournament.policy, filePath, `${where}.policy`),
  };
}

function parsePolicy(value: unknown, filePath: string, where: string): TournamentPolicy {
  const policy = requireRecord(value, where, filePath);
  assertAllowedKeys(policy, POLICY_KEYS, where, filePath);
  const seriesLength = requireInt(policy.seriesLength, `${where}.seriesLength`, filePath, 1);
  const baseEntryCost = requireBigintString(
    policy.baseEntryCost,
    `${where}.baseEntryCost`,
    filePath,
  );
  const carryBps = requireInt(policy.carryBps, `${where}.carryBps`, filePath, 0, 10_000);
  const slashBps = requireInt(policy.slashBps, `${where}.slashBps`, filePath, 0, 10_000);
  const minRounds = requireInt(policy.minRounds, `${where}.minRounds`, filePath, 1, 65_535);
  const maxRounds = requireInt(policy.maxRounds, `${where}.maxRounds`, filePath, 1, 65_535);
  const hazardNumerator = requireInt(
    policy.hazardNumerator,
    `${where}.hazardNumerator`,
    filePath,
    0,
  );
  const hazardDenominator = requireInt(
    policy.hazardDenominator,
    `${where}.hazardDenominator`,
    filePath,
    1,
  );
  if (minRounds > maxRounds)
    throw new Error(`run-spec at ${filePath}: ${where}.minRounds must not exceed maxRounds`);
  if (hazardNumerator > hazardDenominator)
    throw new Error(
      `run-spec at ${filePath}: ${where}.hazardNumerator must not exceed hazardDenominator`,
    );
  if (carryBps + slashBps > 10_000)
    throw new Error(`run-spec at ${filePath}: ${where} carryBps + slashBps must not exceed 10000`);
  return {
    seriesLength,
    baseEntryCost,
    carryBps,
    slashBps,
    minRounds,
    maxRounds,
    hazardNumerator,
    hazardDenominator,
  };
}

function requireRecord(value: unknown, where: string, filePath: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`run-spec at ${filePath}: ${where} must be an object`);
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  filePath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new Error(`run-spec at ${filePath}: ${where}.${key} is not allowed`);
  }
}

function requireInt(
  value: unknown,
  where: string,
  filePath: string,
  minimum: number,
  maximum?: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    const range = maximum === undefined ? `at least ${minimum}` : `in [${minimum}, ${maximum}]`;
    throw new Error(`run-spec at ${filePath}: ${where} must be an integer ${range}`);
  }
  return value;
}

function requireBigintString(value: unknown, where: string, filePath: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`run-spec at ${filePath}: ${where} must be a non-negative bigint string`);
  return value;
}
