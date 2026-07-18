import type { Pricing } from '../model-profiles.js';
import {
  estimateUsageCostMicrousd,
  parseProviderUsage,
  type TokenUsage,
} from './usage-accounting.js';

export type UsageTotals = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costMicrousd: number;
  readonly budgetMicrousd?: number;
};

export class RunBudgetExceededError extends Error {
  readonly name = 'RunBudgetExceededError';

  constructor(readonly totals: UsageTotals) {
    super(`Aggregate model budget exceeded: ${totals.costMicrousd} micro-USD`);
  }
}

export class RunBudget {
  #promptTokens = 0;
  #completionTokens = 0;
  #costMicrousd = 0;
  #exceeded = false;

  constructor(readonly budgetMicrousd?: number) {}

  allowRequest(): boolean {
    return !this.#exceeded;
  }

  record(rawUsage: unknown, pricing: Pricing | undefined): TokenUsage | undefined {
    const usage = parseProviderUsage(rawUsage);
    if (!usage) return undefined;
    this.#promptTokens += usage.promptTokens;
    this.#completionTokens += usage.completionTokens;
    this.#costMicrousd += estimateUsageCostMicrousd(usage, pricing);
    if (this.budgetMicrousd !== undefined && this.#costMicrousd > this.budgetMicrousd) {
      this.#exceeded = true;
    }
    return usage;
  }

  totals(): UsageTotals {
    return {
      promptTokens: this.#promptTokens,
      completionTokens: this.#completionTokens,
      costMicrousd: this.#costMicrousd,
      ...(this.budgetMicrousd !== undefined ? { budgetMicrousd: this.budgetMicrousd } : {}),
    };
  }

  error(): RunBudgetExceededError | undefined {
    return this.#exceeded ? new RunBudgetExceededError(this.totals()) : undefined;
  }
}
