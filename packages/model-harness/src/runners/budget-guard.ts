import type { RunSessionOptions, SessionResult } from '../types.js';

export function budgetFailure(
  options: RunSessionOptions,
  modelCalls: number,
): SessionResult | undefined {
  const budget = options.budget;
  if (!budget || budget.allowRequest()) return undefined;
  options.onEvent({
    t: Date.now(),
    bot: options.botName,
    kind: 'session',
    event: 'error',
    detail: budget.error()?.name ?? 'RunBudgetExceededError',
  });
  return { finished: false, modelCalls, reason: 'error' };
}
