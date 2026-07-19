import { describe, expect, it } from 'vitest';
import { resolveRunnerCache, runnerForResolvedSeat } from '../runner-resolution.js';
import type { ResolvedSeat } from '../types.js';

const persona = { dir: '/persona', systemPromptFragment: 'test' };

function seat(modelConfig?: ResolvedSeat['modelConfig']): ResolvedSeat {
  return {
    botName: 'bot',
    privateKey: 'ephemeral-test-key',
    persona,
    model: modelConfig?.model ?? 'haiku',
    backend: modelConfig ? 'openrouter' : 'claude',
    ...(modelConfig ? { modelConfig } : {}),
  };
}

describe('runner resolution', () => {
  it('Given an opencode-cli profile, when resolving its runner, then it selects only the dedicated OpenCode CLI runner', () => {
    const resolvedSeat = seat({
      provider: 'opencode-cli',
      model: 'minimax-coding-plan/MiniMax-M3',
      maxCompletionTokens: 1024,
    });

    const cache = resolveRunnerCache([resolvedSeat]);

    expect(runnerForResolvedSeat(cache, resolvedSeat).constructor.name).toBe(
      'OpenCodeCliAgentRunner',
    );
    expect([...cache.keys()]).toEqual(['opencode-cli']);
  });

  it.each([
    ['claude-cli', { provider: 'claude-cli', model: 'haiku' } as const, 'ClaudeAgentRunner'],
    ['minimax', { provider: 'minimax', model: 'MiniMax-M3' } as const, 'OpenRouterAgentRunner'],
    ['scripted', { provider: 'scripted', model: 'fixture' } as const, 'OpenRouterAgentRunner'],
  ])('Given the existing %s profile, when resolving, then its runner stays unchanged', (_name, profile, expected) => {
    const resolvedSeat = seat(profile);
    const cache = resolveRunnerCache([resolvedSeat]);

    expect(runnerForResolvedSeat(cache, resolvedSeat).constructor.name).toBe(expected);
  });
});
