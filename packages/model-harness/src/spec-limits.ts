import type { RunLimits } from './types.js';

export const DEFAULT_LIMITS: RunLimits = {
  maxModelCallsPerBot: 80,
  wallClockMsPerRun: 600_000,
};

export function parseRunLimits(raw: unknown): RunLimits {
  if (!isRecord(raw)) return { ...DEFAULT_LIMITS };
  const maxModelCallsPerBot =
    typeof raw.maxModelCallsPerBot === 'number' && raw.maxModelCallsPerBot > 0
      ? raw.maxModelCallsPerBot
      : DEFAULT_LIMITS.maxModelCallsPerBot;
  const wallClockMsPerRun =
    typeof raw.wallClockMsPerRun === 'number' && raw.wallClockMsPerRun > 0
      ? raw.wallClockMsPerRun
      : DEFAULT_LIMITS.wallClockMsPerRun;
  const maxAggregateCostMicrousd = raw.maxAggregateCostMicrousd;
  if (
    maxAggregateCostMicrousd !== undefined &&
    (typeof maxAggregateCostMicrousd !== 'number' ||
      !Number.isSafeInteger(maxAggregateCostMicrousd) ||
      maxAggregateCostMicrousd < 0)
  ) {
    throw new Error('run-spec limits.maxAggregateCostMicrousd must be a non-negative safe integer');
  }
  return {
    maxModelCallsPerBot,
    wallClockMsPerRun,
    ...(maxAggregateCostMicrousd !== undefined ? { maxAggregateCostMicrousd } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
