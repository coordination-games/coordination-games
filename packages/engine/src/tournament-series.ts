import { createTournamentEconomics } from './tournament-economics.js';
import {
  type Bytes32Hex,
  computeTournamentPolicyHash,
  deriveTournamentGameSeed,
  parseBytes32Hex,
  type TournamentPolicy,
} from './tournament-encoding.js';

export type TournamentSeriesConfig = {
  readonly tournamentId: string;
  readonly gameType: string;
  readonly playerIds: readonly string[];
  readonly policy: TournamentPolicy;
};

export type TournamentStanding = {
  readonly playerId: string;
  readonly cumulativeDelta: bigint;
  readonly gamesPlayed: number;
};

export type CarryPlan = {
  readonly fromGameIndex: number;
  readonly toGameIndex: number | null;
  readonly carryBps: number;
  readonly slashBps: number;
  readonly baseEntryCost: bigint;
  readonly playerCount: number;
  readonly incomingCarry: bigint;
  readonly releasedCarry: bigint;
  readonly carryRemainder: bigint;
  readonly carry: bigint;
};

export type TournamentGameConfig = {
  readonly tournamentId: string;
  readonly gameIndex: number;
  readonly gameType: string;
  readonly playerIds: readonly string[];
  readonly tournamentRootSeed: Bytes32Hex;
  readonly gameSeed: Bytes32Hex;
  readonly policyHash: Bytes32Hex;
  readonly baseEntryCost: bigint;
  readonly incomingCarry: bigint;
  readonly entryCost: bigint;
  readonly incomingCarryPlan: CarryPlan | null;
};

export type TournamentSeries = {
  readonly tournamentId: string;
  readonly gameType: string;
  readonly playerIds: readonly string[];
  readonly activePlayerIds: readonly string[];
  readonly policy: TournamentPolicy;
  readonly policyHash: Bytes32Hex;
  readonly tournamentRootSeed: Bytes32Hex;
  readonly currentGameIndex: number;
  readonly settledGameIds: readonly string[];
  readonly standings: readonly TournamentStanding[];
  readonly treasuryCarry: bigint;
};

export type SettledGameOutcome = {
  readonly gameId: string;
  readonly gameIndex: number;
};

export type CreateSeriesResult = {
  readonly series: TournamentSeries;
  readonly gameConfig: TournamentGameConfig;
};

export type GameSettlementResult = {
  readonly series: TournamentSeries;
  readonly standings: readonly TournamentStanding[];
  readonly carryPlan: CarryPlan;
  readonly nextGameConfig: TournamentGameConfig | null;
};

export class TournamentSeriesError extends Error {
  readonly name = 'TournamentSeriesError';

  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`Invalid tournament series field ${field}: ${reason}`);
  }
}

export function deriveGameSeed(
  tournamentRootSeed: Bytes32Hex,
  tournamentId: string,
  gameIndex: number,
): Bytes32Hex {
  return deriveTournamentGameSeed(tournamentRootSeed, tournamentId, gameIndex);
}

function requireNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TournamentSeriesError(field, value, 'expected a non-empty string');
  }
}

function copyPolicy(policy: TournamentPolicy): TournamentPolicy {
  return Object.freeze({
    seriesLength: policy.seriesLength,
    baseEntryCost: policy.baseEntryCost,
    carryBps: policy.carryBps,
    slashBps: policy.slashBps,
    minRounds: policy.minRounds,
    maxRounds: policy.maxRounds,
    hazardNumerator: policy.hazardNumerator,
    hazardDenominator: policy.hazardDenominator,
  });
}

function copyPlayerIds(playerIds: readonly string[]): readonly string[] {
  if (playerIds.length === 0) {
    throw new TournamentSeriesError('playerIds', playerIds, 'expected at least one player');
  }
  const copied = [...playerIds];
  for (const playerId of copied) requireNonEmpty('playerIds', playerId);
  if (new Set(copied).size !== copied.length) {
    throw new TournamentSeriesError('playerIds', playerIds, 'expected unique player IDs');
  }
  return Object.freeze(copied);
}

function compareStandings(left: TournamentStanding, right: TournamentStanding): number {
  if (left.cumulativeDelta > right.cumulativeDelta) return -1;
  if (left.cumulativeDelta < right.cumulativeDelta) return 1;
  if (left.playerId < right.playerId) return -1;
  if (left.playerId > right.playerId) return 1;
  return 0;
}

function makeGameConfig(
  series: TournamentSeries,
  gameIndex: number,
  incomingCarryPlan: CarryPlan | null,
): TournamentGameConfig {
  const economics = createTournamentEconomics({
    policy: series.policy,
    playerCount: series.activePlayerIds.length,
    incomingCarry: series.treasuryCarry,
  });
  return Object.freeze({
    tournamentId: series.tournamentId,
    gameIndex,
    gameType: series.gameType,
    playerIds: Object.freeze([...series.activePlayerIds]),
    tournamentRootSeed: series.tournamentRootSeed,
    gameSeed: deriveGameSeed(series.tournamentRootSeed, series.tournamentId, gameIndex),
    policyHash: series.policyHash,
    baseEntryCost: series.policy.baseEntryCost,
    incomingCarry: economics.incomingCarry,
    entryCost: economics.entryCost,
    incomingCarryPlan,
  });
}

export function createSeries(
  config: TournamentSeriesConfig,
  tournamentRootSeed: Bytes32Hex,
): CreateSeriesResult {
  requireNonEmpty('tournamentId', config.tournamentId);
  requireNonEmpty('gameType', config.gameType);
  const playerIds = copyPlayerIds(config.playerIds);
  const policy = copyPolicy(config.policy);
  const policyHash = computeTournamentPolicyHash(policy);
  const normalizedRootSeed = parseBytes32Hex(tournamentRootSeed, 'tournamentRootSeed');
  const standings = Object.freeze(
    playerIds
      .map((playerId) => Object.freeze({ playerId, cumulativeDelta: 0n, gamesPlayed: 0 }))
      .sort(compareStandings),
  );
  const series: TournamentSeries = Object.freeze({
    tournamentId: config.tournamentId,
    gameType: config.gameType,
    playerIds,
    activePlayerIds: playerIds,
    policy,
    policyHash,
    tournamentRootSeed: normalizedRootSeed,
    currentGameIndex: 0,
    settledGameIds: Object.freeze([]),
    standings,
    treasuryCarry: 0n,
  });
  return Object.freeze({ series, gameConfig: makeGameConfig(series, 0, null) });
}

function validatePayouts(series: TournamentSeries, payouts: ReadonlyMap<string, unknown>): void {
  if (payouts.size !== series.activePlayerIds.length) {
    throw new TournamentSeriesError('payouts', payouts, 'expected exactly one payout per player');
  }
  for (const playerId of series.activePlayerIds) {
    if (!payouts.has(playerId)) {
      throw new TournamentSeriesError('payouts', payouts, `missing player ${playerId}`);
    }
  }
  for (const [playerId, delta] of payouts) {
    if (!series.activePlayerIds.includes(playerId)) {
      throw new TournamentSeriesError('payouts', payouts, `unknown player ${playerId}`);
    }
    if (typeof delta !== 'bigint') {
      throw new TournamentSeriesError('payouts', payouts, `expected bigint for ${playerId}`);
    }
  }
}

export function onGameSettled(
  series: TournamentSeries,
  outcome: SettledGameOutcome,
  payouts: ReadonlyMap<string, unknown>,
  eliminatedPlayerIds: readonly string[] = [],
): GameSettlementResult {
  if (series.currentGameIndex >= series.policy.seriesLength) {
    throw new TournamentSeriesError('series', series, 'series is complete');
  }
  if (outcome.gameIndex !== series.currentGameIndex) {
    throw new TournamentSeriesError(
      'gameIndex',
      outcome.gameIndex,
      `expected ${series.currentGameIndex}`,
    );
  }
  requireNonEmpty('gameId', outcome.gameId);
  if (series.settledGameIds.includes(outcome.gameId)) {
    throw new TournamentSeriesError('gameId', outcome.gameId, 'game already settled');
  }
  validatePayouts(series, payouts);
  const eliminated = new Set(eliminatedPlayerIds);
  if (eliminated.size !== eliminatedPlayerIds.length) {
    throw new TournamentSeriesError(
      'eliminatedPlayerIds',
      eliminatedPlayerIds,
      'expected unique player IDs',
    );
  }
  for (const playerId of eliminated) {
    if (!series.activePlayerIds.includes(playerId)) {
      throw new TournamentSeriesError(
        'eliminatedPlayerIds',
        eliminatedPlayerIds,
        `expected active player ${playerId}`,
      );
    }
  }

  const standings = Object.freeze(
    series.standings
      .map((standing) => {
        if (!series.activePlayerIds.includes(standing.playerId)) return standing;
        const delta = payouts.get(standing.playerId);
        if (typeof delta !== 'bigint') {
          throw new TournamentSeriesError(
            'payouts',
            payouts,
            `missing player ${standing.playerId}`,
          );
        }
        return Object.freeze({
          playerId: standing.playerId,
          cumulativeDelta: standing.cumulativeDelta + delta,
          gamesPlayed: standing.gamesPlayed + 1,
        });
      })
      .sort(compareStandings),
  );
  const nextGameIndex = series.currentGameIndex + 1;
  const toGameIndex = nextGameIndex < series.policy.seriesLength ? nextGameIndex : null;
  const economics = createTournamentEconomics({
    policy: series.policy,
    playerCount: series.activePlayerIds.length,
    incomingCarry: series.treasuryCarry,
  });
  const carryPlan: CarryPlan = Object.freeze({
    fromGameIndex: series.currentGameIndex,
    toGameIndex,
    carryBps: series.policy.carryBps,
    slashBps: series.policy.slashBps,
    baseEntryCost: series.policy.baseEntryCost,
    playerCount: series.activePlayerIds.length,
    incomingCarry: economics.incomingCarry,
    releasedCarry: economics.releasedCarry,
    carryRemainder: economics.carryRemainder,
    carry: economics.carry,
  });
  const updatedSeries: TournamentSeries = Object.freeze({
    ...series,
    playerIds: Object.freeze([...series.playerIds]),
    activePlayerIds: Object.freeze(
      series.activePlayerIds.filter((playerId) => !eliminated.has(playerId)),
    ),
    policy: copyPolicy(series.policy),
    currentGameIndex: nextGameIndex,
    settledGameIds: Object.freeze([...series.settledGameIds, outcome.gameId]),
    standings,
    treasuryCarry: economics.carryRemainder + economics.carry,
  });
  const nextGameConfig =
    toGameIndex === null ? null : makeGameConfig(updatedSeries, toGameIndex, carryPlan);
  return Object.freeze({
    series: updatedSeries,
    standings,
    carryPlan,
    nextGameConfig,
  });
}
