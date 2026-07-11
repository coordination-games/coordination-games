import { type HiddenHorizonPublicConfig, parseBytes32Hex } from '@coordination-games/engine';
import type { TragedyV2Config, TragedyV2State } from './types.js';

const MAX_HIDDEN_HORIZON_ROUNDS = 0xffff;
const HIDDEN_HORIZON_KEYS = [
  'commitment',
  'policyHash',
  'minRounds',
  'maxRounds',
  'hazardNumerator',
  'hazardDenominator',
] as const;
const HIDDEN_HORIZON_KEY_SET = new Set<string>(HIDDEN_HORIZON_KEYS);

export class SealedHiddenHorizonError extends Error {
  readonly name = 'SealedHiddenHorizonError';

  constructor(readonly reason: string) {
    super(`Invalid sealed Tragedy V2 hidden horizon: ${reason}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function exactHiddenHorizonKeys(value: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === HIDDEN_HORIZON_KEYS.length &&
    keys.every((key) => typeof key === 'string' && HIDDEN_HORIZON_KEY_SET.has(key))
  );
}

function parsePublicHorizon(value: unknown): HiddenHorizonPublicConfig {
  if (!isRecord(value) || !exactHiddenHorizonKeys(value)) {
    throw new SealedHiddenHorizonError('hiddenHorizon must contain exactly the six public fields');
  }
  const { commitment, policyHash, minRounds, maxRounds, hazardNumerator, hazardDenominator } =
    value;
  if (
    typeof commitment !== 'string' ||
    typeof policyHash !== 'string' ||
    !isSafeInteger(minRounds) ||
    !isSafeInteger(maxRounds) ||
    !isSafeInteger(hazardNumerator) ||
    !isSafeInteger(hazardDenominator)
  ) {
    throw new SealedHiddenHorizonError(
      'hiddenHorizon fields must have valid public primitive values',
    );
  }
  let normalizedCommitment: HiddenHorizonPublicConfig['commitment'];
  let normalizedPolicyHash: HiddenHorizonPublicConfig['policyHash'];
  try {
    normalizedCommitment = parseBytes32Hex(commitment, 'hiddenHorizon.commitment');
    normalizedPolicyHash = parseBytes32Hex(policyHash, 'hiddenHorizon.policyHash');
  } catch {
    throw new SealedHiddenHorizonError('hiddenHorizon commitments must be valid bytes32 values');
  }
  if (minRounds < 1 || minRounds > maxRounds || maxRounds > MAX_HIDDEN_HORIZON_ROUNDS) {
    throw new SealedHiddenHorizonError(
      'public bounds must satisfy 1 <= minRounds <= maxRounds <= 65535',
    );
  }
  if (hazardDenominator < 1 || hazardNumerator < 0 || hazardNumerator > hazardDenominator) {
    throw new SealedHiddenHorizonError(
      'hazard must satisfy denominator >= 1 and 0 <= numerator <= denominator',
    );
  }
  return Object.freeze({
    commitment: normalizedCommitment,
    policyHash: normalizedPolicyHash,
    minRounds,
    maxRounds,
    hazardNumerator,
    hazardDenominator,
  });
}

function isV2State(value: unknown): value is TragedyV2State {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.round) &&
    typeof value.phase === 'string' &&
    isRecord(value.config) &&
    value.config.schemaVersion === 'v2'
  );
}

function validatePublicHorizon(config: TragedyV2Config): HiddenHorizonPublicConfig | null {
  const horizon = config.hiddenHorizon;
  if (horizon === undefined) return null;
  const normalizedHorizon = parsePublicHorizon(horizon);
  if (config.maxRounds !== normalizedHorizon.maxRounds) {
    throw new SealedHiddenHorizonError('config.maxRounds must equal hiddenHorizon.maxRounds');
  }
  return normalizedHorizon;
}

export function sealV2HiddenHorizon(initialState: unknown, stopRound: unknown): TragedyV2State {
  if (!isV2State(initialState)) {
    throw new SealedHiddenHorizonError('expected an initial Tragedy V2 state');
  }
  if (
    initialState.phase !== 'waiting' ||
    initialState.round !== 0 ||
    initialState.sealedHiddenHorizon !== undefined
  ) {
    throw new SealedHiddenHorizonError('sealing is allowed only once for an initial waiting state');
  }
  const horizon = validatePublicHorizon(initialState.config);
  if (horizon === null) {
    throw new SealedHiddenHorizonError('hiddenHorizon is required for a sealed endpoint');
  }
  if (typeof stopRound !== 'number' || !Number.isSafeInteger(stopRound)) {
    throw new SealedHiddenHorizonError('stopRound must be a safe integer');
  }
  if (stopRound < horizon.minRounds || stopRound > horizon.maxRounds) {
    throw new SealedHiddenHorizonError('stopRound must be within the public bounds');
  }
  return {
    ...initialState,
    config: { ...initialState.config, hiddenHorizon: horizon },
    sealedHiddenHorizon: Object.freeze({ stopRound }),
  };
}

export function effectiveV2FinalRound(state: TragedyV2State): number {
  const horizon = validatePublicHorizon(state.config);
  if (horizon === null) return state.config.maxRounds;
  const sealed = state.sealedHiddenHorizon;
  if (sealed === undefined) {
    throw new SealedHiddenHorizonError('committed hiddenHorizon is missing its sealed endpoint');
  }
  if (!Number.isSafeInteger(sealed.stopRound)) {
    throw new SealedHiddenHorizonError('sealed stopRound must be a safe integer');
  }
  if (sealed.stopRound < horizon.minRounds || sealed.stopRound > horizon.maxRounds) {
    throw new SealedHiddenHorizonError('sealed stopRound must be within the public bounds');
  }
  return sealed.stopRound;
}
