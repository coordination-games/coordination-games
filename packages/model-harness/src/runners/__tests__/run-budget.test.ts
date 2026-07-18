import { describe, expect, it } from 'vitest';
import { RunBudget } from '../run-budget.js';

describe('RunBudget', () => {
  it('Given concurrent-session usage observations, when aggregate cost crosses the cap, then later requests are rejected with exact micro-USD totals', () => {
    // Given
    const budget = new RunBudget(3_000_000);

    // When
    budget.record({ prompt_tokens: 1_000_000, completion_tokens: 0 }, { promptPerMillion: 2 });
    budget.record({ prompt_tokens: 0, completion_tokens: 1_000_000 }, { completionPerMillion: 2 });

    // Then
    expect(budget.allowRequest()).toBe(false);
    expect(budget.totals()).toEqual({
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      costMicrousd: 4_000_000,
      budgetMicrousd: 3_000_000,
    });
    expect(budget.error()).toMatchObject({ name: 'RunBudgetExceededError' });
  });
});
