import { ClaudeAgentRunner } from './runners/claude.js';
import { OpenCodeCliAgentRunner } from './runners/opencode.js';
import { OpenRouterAgentRunner } from './runners/openrouter.js';
import type { AgentRunner, ResolvedSeat } from './types.js';

function runnerForSeat(seat: ResolvedSeat): AgentRunner {
  if (seat.modelConfig?.provider === 'claude-cli') return new ClaudeAgentRunner();
  if (seat.modelConfig?.provider === 'opencode-cli') return new OpenCodeCliAgentRunner();
  switch (seat.backend) {
    case 'claude':
      return new ClaudeAgentRunner();
    case 'openrouter':
      return new OpenRouterAgentRunner();
  }
}

function runnerKey(seat: ResolvedSeat): string {
  return seat.modelConfig?.provider ?? seat.backend;
}

export function resolveRunnerCache(
  seats: readonly ResolvedSeat[],
): ReadonlyMap<string, AgentRunner> {
  const cache = new Map<string, AgentRunner>();
  for (const seat of seats) {
    const key = runnerKey(seat);
    if (!cache.has(key)) cache.set(key, runnerForSeat(seat));
  }
  return cache;
}

export function runnerForResolvedSeat(
  cache: ReadonlyMap<string, AgentRunner>,
  seat: ResolvedSeat,
): AgentRunner {
  const runner = cache.get(runnerKey(seat));
  if (!runner) throw new Error(`No runner for backend ${seat.backend}`);
  return runner;
}
