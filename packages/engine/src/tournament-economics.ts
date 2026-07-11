const BASIS_POINTS = 10_000n;

export type TournamentEconomicsPolicy = {
  readonly baseEntryCost: bigint;
  readonly carryBps: number;
  readonly slashBps: number;
};

export type TournamentEconomics = {
  readonly baseEntryCost: bigint;
  readonly entryCost: bigint;
  readonly playerCount: number;
  readonly basePot: bigint;
  readonly incomingCarry: bigint;
  readonly releasedCarry: bigint;
  readonly carryRemainder: bigint;
  readonly carry: bigint;
  readonly slash: bigint;
  readonly treasuryDelta: bigint;
};

export type TournamentPayoutSettlement = {
  readonly playerPayouts: ReadonlyMap<string, bigint>;
  readonly treasuryDelta: bigint;
  readonly roundingResidual: bigint;
};

export class TournamentEconomicsError extends Error {
  readonly name = 'TournamentEconomicsError';

  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`Invalid tournament economics ${field}: ${reason}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTournamentEntryCost(config: unknown): bigint {
  if (!isRecord(config) || !isRecord(config.tournamentEconomics)) {
    throw new TournamentEconomicsError('tournamentEconomics', config, 'is required');
  }
  const { entryCost } = config.tournamentEconomics;
  if (typeof entryCost === 'bigint' && entryCost >= 0n) return entryCost;
  if (typeof entryCost === 'string' && /^(0|[1-9][0-9]*)$/.test(entryCost))
    return BigInt(entryCost);
  throw new TournamentEconomicsError(
    'tournamentEconomics.entryCost',
    entryCost,
    'must be an unsigned bigint',
  );
}

function requireNonNegative(field: string, value: bigint): void {
  if (value < 0n) throw new TournamentEconomicsError(field, value, 'must be non-negative');
}

function requireBps(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number(BASIS_POINTS)) {
    throw new TournamentEconomicsError(field, value, 'must be an integer in [0, 10000]');
  }
}

function requirePlayerCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TournamentEconomicsError('playerCount', value, 'must be a positive safe integer');
  }
}

/**
 * All divisions floor. Incoming carry is released only in whole per-player
 * increments; any remainder and proportional-payout residue remain treasury-held.
 */
export function createTournamentEconomics(input: {
  readonly policy: TournamentEconomicsPolicy;
  readonly playerCount: number;
  readonly incomingCarry: bigint;
}): TournamentEconomics {
  const { policy, playerCount, incomingCarry } = input;
  requireNonNegative('baseEntryCost', policy.baseEntryCost);
  requireNonNegative('incomingCarry', incomingCarry);
  requirePlayerCount(playerCount);
  requireBps('carryBps', policy.carryBps);
  requireBps('slashBps', policy.slashBps);
  if (policy.carryBps + policy.slashBps > Number(BASIS_POINTS)) {
    throw new TournamentEconomicsError(
      'policy',
      policy,
      'carryBps + slashBps must not exceed 10000',
    );
  }

  const count = BigInt(playerCount);
  const releasedCarry = (incomingCarry / count) * count;
  const carryRemainder = incomingCarry - releasedCarry;
  const entryCost = policy.baseEntryCost + incomingCarry / count;
  const basePot = entryCost * count;
  const carry = (basePot * BigInt(policy.carryBps)) / BASIS_POINTS;
  const slash = (basePot * BigInt(policy.slashBps)) / BASIS_POINTS;

  return Object.freeze({
    baseEntryCost: policy.baseEntryCost,
    entryCost,
    playerCount,
    basePot,
    incomingCarry,
    releasedCarry,
    carryRemainder,
    carry,
    slash,
    treasuryDelta: carry + slash - releasedCarry,
  });
}

export function validateTournamentEconomics(
  policy: TournamentEconomicsPolicy,
  economics: TournamentEconomics,
  playerCount: number,
): TournamentEconomics {
  if (economics.playerCount !== playerCount) {
    throw new TournamentEconomicsError(
      'economics.playerCount',
      economics.playerCount,
      'does not match players',
    );
  }
  const expected = createTournamentEconomics({
    policy,
    playerCount,
    incomingCarry: economics.incomingCarry,
  });
  for (const key of [
    'baseEntryCost',
    'entryCost',
    'basePot',
    'releasedCarry',
    'carryRemainder',
    'carry',
    'slash',
    'treasuryDelta',
  ] as const) {
    if (economics[key] !== expected[key]) {
      throw new TournamentEconomicsError(
        `economics.${key}`,
        economics[key],
        'does not match policy',
      );
    }
  }
  return expected;
}

export function applyTournamentPayouts(
  basePayouts: ReadonlyMap<string, bigint>,
  playerIds: readonly string[],
  economics: TournamentEconomics,
): TournamentPayoutSettlement {
  if (playerIds.length !== economics.playerCount || new Set(playerIds).size !== playerIds.length) {
    throw new TournamentEconomicsError(
      'playerIds',
      playerIds,
      'must be unique and match playerCount',
    );
  }
  if (basePayouts.size !== playerIds.length) {
    throw new TournamentEconomicsError(
      'basePayouts',
      basePayouts,
      'must have one entry per player',
    );
  }
  const shares = new Map<string, bigint>();
  let deltaTotal = 0n;
  for (const playerId of playerIds) {
    const delta = basePayouts.get(playerId);
    if (typeof delta !== 'bigint') {
      throw new TournamentEconomicsError(
        'basePayouts',
        basePayouts,
        `missing bigint delta for ${playerId}`,
      );
    }
    if (delta < -economics.entryCost) {
      throw new TournamentEconomicsError(
        'basePayouts',
        basePayouts,
        `delta below stake floor for ${playerId}`,
      );
    }
    shares.set(playerId, delta + economics.entryCost);
    deltaTotal += delta;
  }
  if (deltaTotal !== 0n) {
    throw new TournamentEconomicsError('basePayouts', basePayouts, 'must be zero-sum');
  }

  if (economics.basePot === 0n) {
    if ([...shares.values()].some((share) => share !== 0n)) {
      throw new TournamentEconomicsError(
        'basePayouts',
        basePayouts,
        'must be all zero for a zero pot',
      );
    }
    return Object.freeze({
      playerPayouts: new Map(playerIds.map((playerId) => [playerId, 0n])),
      treasuryDelta: 0n,
      roundingResidual: 0n,
    });
  }

  const distributablePot =
    economics.basePot - economics.carry - economics.slash + economics.releasedCarry;
  let distributed = 0n;
  const playerPayouts = new Map<string, bigint>();
  for (const playerId of playerIds) {
    const share = shares.get(playerId);
    if (share === undefined) {
      throw new TournamentEconomicsError(
        'basePayouts',
        basePayouts,
        `missing share for ${playerId}`,
      );
    }
    const allocation = (distributablePot * share) / economics.basePot;
    distributed += allocation;
    playerPayouts.set(playerId, allocation - economics.entryCost);
  }
  const roundingResidual = distributablePot - distributed;
  const treasuryDelta = economics.treasuryDelta + roundingResidual;
  return Object.freeze({ playerPayouts, treasuryDelta, roundingResidual });
}
