import type { Pricing } from '../model-profiles.js';

export type TokenUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
};

export function parseProviderUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  if (!isTokenCount(promptTokens) || !isTokenCount(completionTokens)) return undefined;
  return { promptTokens, completionTokens };
}

export function estimateUsageCostMicrousd(
  usage: TokenUsage | undefined,
  pricing: Pricing | undefined,
): number {
  if (!usage || !pricing) return 0;
  return (
    microusdForTokens(usage.promptTokens, pricing.promptPerMillion ?? 0) +
    microusdForTokens(usage.completionTokens, pricing.completionPerMillion ?? 0)
  );
}

function microusdForTokens(tokens: number, dollarsPerMillion: number): number {
  const priceMicrousdPerMillion = toMicrousd(dollarsPerMillion);
  return Math.round((tokens * priceMicrousdPerMillion) / 1_000_000);
}

function toMicrousd(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
