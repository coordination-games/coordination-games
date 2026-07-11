import { canonicalEncode } from './canonical-encoding.js';
import {
  type Bytes32Hex,
  computeHiddenHorizonPrfDigest,
  computeTournamentPolicyHash,
  parseBytes32Hex,
  TournamentEncodingError,
  type TournamentPolicy,
} from './tournament-encoding.js';

export type HiddenHorizonPolicy = TournamentPolicy;

type ValidatedHiddenHorizonPolicy = {
  readonly minRounds: number;
  readonly maxRounds: number;
  readonly hazardNumerator: number;
  readonly hazardDenominator: number;
  readonly policyHash: Bytes32Hex;
};

export type HiddenHorizonPublicConfig = {
  readonly commitment: Bytes32Hex;
  readonly policyHash: Bytes32Hex;
  readonly minRounds: number;
  readonly maxRounds: number;
  readonly hazardNumerator: number;
  readonly hazardDenominator: number;
};

export class HiddenHorizonError extends Error {
  readonly name = 'HiddenHorizonError';

  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Invalid hidden-horizon field ${field}: ${reason}`);
  }
}

const MAX_ROUNDS = 0xffff;
const TOTAL_MASS = 1n << 256n;

function bytes32(field: string, value: unknown): Bytes32Hex {
  try {
    return parseBytes32Hex(value, field);
  } catch (error) {
    if (error instanceof TournamentEncodingError) {
      throw new HiddenHorizonError(field, 'expected 0x plus exactly 64 hex digits');
    }
    throw error;
  }
}

function parsePolicy(policy: TournamentPolicy): ValidatedHiddenHorizonPolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new HiddenHorizonError('policy', 'expected an object');
  }
  try {
    const policyHash = computeTournamentPolicyHash(policy);
    if (policy.maxRounds > MAX_ROUNDS) {
      throw new HiddenHorizonError('maxRounds', `expected an integer in [1, ${MAX_ROUNDS}]`);
    }
    return Object.freeze({
      minRounds: policy.minRounds,
      maxRounds: policy.maxRounds,
      hazardNumerator: policy.hazardNumerator,
      hazardDenominator: policy.hazardDenominator,
      policyHash,
    });
  } catch (error) {
    if (error instanceof TournamentEncodingError) {
      throw new HiddenHorizonError(error.field, 'expected a valid TournamentPolicy field');
    }
    throw error;
  }
}

export function deriveStopRound(
  secret: Bytes32Hex,
  gameId: string,
  playerEntropy: Bytes32Hex,
  policy: TournamentPolicy,
): number {
  const normalizedSecret = bytes32('secret', secret);
  if (typeof gameId !== 'string' || gameId.length === 0) {
    throw new HiddenHorizonError('gameId', 'expected a non-empty string');
  }
  const normalizedEntropy = bytes32('playerEntropy', playerEntropy);
  const normalizedPolicy = parsePolicy(policy);
  if (normalizedPolicy.minRounds === normalizedPolicy.maxRounds) return normalizedPolicy.minRounds;
  if (normalizedPolicy.hazardNumerator === 0) return normalizedPolicy.maxRounds;
  if (normalizedPolicy.hazardNumerator === normalizedPolicy.hazardDenominator) {
    return normalizedPolicy.minRounds;
  }

  const digest = computeHiddenHorizonPrfDigest({
    secret: normalizedSecret,
    gameId,
    playerEntropy: normalizedEntropy,
    policyHash: normalizedPolicy.policyHash,
  });
  const sample = BigInt(digest);
  const numerator = BigInt(normalizedPolicy.hazardNumerator);
  const denominator = BigInt(normalizedPolicy.hazardDenominator);
  let remainingMass = TOTAL_MASS;
  let cumulativeThreshold = 0n;

  for (let round = normalizedPolicy.minRounds; round < normalizedPolicy.maxRounds; round += 1) {
    const stopMass = (remainingMass * numerator) / denominator;
    cumulativeThreshold += stopMass;
    if (sample < cumulativeThreshold) return round;
    remainingMass -= stopMass;
    if (remainingMass < 0n) {
      throw new HiddenHorizonError('hazard', 'probability mass underflow');
    }
  }
  return normalizedPolicy.maxRounds;
}

export function createHiddenHorizonPublicConfig(
  commitment: Bytes32Hex,
  policy: TournamentPolicy,
): HiddenHorizonPublicConfig {
  const normalizedPolicy = parsePolicy(policy);
  return Object.freeze({
    commitment: bytes32('commitment', commitment),
    policyHash: normalizedPolicy.policyHash,
    minRounds: normalizedPolicy.minRounds,
    maxRounds: normalizedPolicy.maxRounds,
    hazardNumerator: normalizedPolicy.hazardNumerator,
    hazardDenominator: normalizedPolicy.hazardDenominator,
  });
}

export function serializeHiddenHorizonPublicConfig(
  commitment: Bytes32Hex,
  policy: TournamentPolicy,
): Uint8Array {
  return canonicalEncode(createHiddenHorizonPublicConfig(commitment, policy));
}
