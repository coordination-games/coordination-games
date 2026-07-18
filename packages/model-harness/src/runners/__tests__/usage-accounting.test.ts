import { describe, expect, it } from 'vitest';
import { estimateUsageCostMicrousd, parseProviderUsage } from '../usage-accounting.js';

describe('provider usage accounting', () => {
  it('Given provider token counters and configured per-million prices, when accounting usage, then it returns deterministic micro-USD cost', () => {
    // Given / When
    const usage = parseProviderUsage({ prompt_tokens: 1_500_000, completion_tokens: 500_000 });

    // Then
    expect(usage).toEqual({ promptTokens: 1_500_000, completionTokens: 500_000 });
    expect(estimateUsageCostMicrousd(usage, { promptPerMillion: 2, completionPerMillion: 4 })).toBe(
      5_000_000,
    );
  });

  it('Given malformed provider counters, when parsing usage, then it rejects the record instead of trusting it', () => {
    // Given / When / Then
    expect(parseProviderUsage({ prompt_tokens: 1.5, completion_tokens: 2 })).toBeUndefined();
    expect(parseProviderUsage({ prompt_tokens: -1, completion_tokens: 2 })).toBeUndefined();
  });
});
