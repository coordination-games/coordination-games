import type { LobbySizePolicy, LobbySizeUnit } from './types.js';

const LEGACY_MIN_SIZE = 1;
const LEGACY_MAX_SIZE = 20;

export class LobbySizePolicyError extends Error {
  readonly name = 'LobbySizePolicyError';

  constructor(readonly reason: string) {
    super(`Invalid lobby size policy: ${reason}`);
  }
}

export class LobbySizeError extends Error {
  readonly name = 'LobbySizeError';

  constructor(
    readonly unit: LobbySizeUnit,
    readonly min: number,
    readonly max: number,
  ) {
    super(`Invalid ${unit}: expected an integer between ${min} and ${max}`);
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new LobbySizePolicyError(`${field} must be a positive finite integer`);
  }
}

export function defineLobbySizePolicy(policy: LobbySizePolicy): LobbySizePolicy {
  requirePositiveInteger(policy.min, 'min');
  requirePositiveInteger(policy.max, 'max');
  requirePositiveInteger(policy.default, 'default');
  if (policy.min > policy.max) {
    throw new LobbySizePolicyError('min must not exceed max');
  }
  if (policy.default < policy.min || policy.default > policy.max) {
    throw new LobbySizePolicyError('default must be within min and max');
  }
  return Object.freeze({ ...policy });
}

export function resolveLobbySize(
  raw: unknown,
  policy?: LobbySizePolicy,
  legacyDefault = 2,
): number {
  const min = policy?.min ?? LEGACY_MIN_SIZE;
  const max = policy?.max ?? LEGACY_MAX_SIZE;
  const defaultSize = policy?.default ?? legacyDefault;
  const unit = policy?.unit ?? 'player-count';

  if (policy === undefined) {
    requirePositiveInteger(defaultSize, 'legacy default');
    if (defaultSize < min || defaultSize > max) {
      throw new LobbySizePolicyError('legacy default must be between 1 and 20');
    }
  }
  if (raw === undefined) return defaultSize;
  if (
    typeof raw !== 'number' ||
    !Number.isFinite(raw) ||
    !Number.isInteger(raw) ||
    raw < min ||
    raw > max
  ) {
    throw new LobbySizeError(unit, min, max);
  }
  return raw;
}
