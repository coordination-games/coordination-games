import { describe, expect, it } from 'vitest';
import { buildCompletionRequestBody, resolveProfileProviderConfig } from '../openai-provider.js';
import { runOpenAiSession } from '../openai-session.js';
import { RunBudget } from '../run-budget.js';

describe('profile-backed OpenAI-compatible requests', () => {
  it('Given an exact MiniMax M3 profile, when building the provider body, then it preserves the opaque model and configured tuning', () => {
    // Given
    const profile = {
      provider: 'minimax' as const,
      model: 'MiniMax-M3',
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyEnv: 'MINIMAX_API_KEY',
      temperature: 0.2,
      topP: 0.9,
      maxCompletionTokens: 321,
      reasoningSplit: true,
      reasoningEffort: 'high',
    };

    // When
    const body = buildCompletionRequestBody({
      model: profile.model,
      messages: [{ role: 'user', content: 'begin' }],
      tools: [],
      profile,
    });

    // Then
    expect(body).toEqual({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'begin' }],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 321,
      reasoning_split: true,
      reasoning_effort: 'high',
    });
  });

  it('Given a profile credential environment name, when resolving runtime provider configuration, then it reads only that credential at the request boundary', () => {
    // Given
    const original = process.env.HARNESS_TEST_API_KEY;
    process.env.HARNESS_TEST_API_KEY = 'private-test-value';

    try {
      // When
      const config = resolveProfileProviderConfig({
        provider: 'openai-compatible',
        model: 'custom-model',
        baseUrl: 'https://models.example/v1',
        apiKeyEnv: 'HARNESS_TEST_API_KEY',
      });

      // Then
      expect(config).toEqual({
        baseUrl: 'https://models.example/v1',
        apiKey: 'private-test-value',
      });
    } finally {
      if (original === undefined) delete process.env.HARNESS_TEST_API_KEY;
      else process.env.HARNESS_TEST_API_KEY = original;
    }
  });

  it('Given a resolved MiniMax profile, when the shared OpenAI loop sends a request, then the transcript records the redacted constructed body', async () => {
    // Given
    const originalFetch = globalThis.fetch;
    const events: unknown[] = [];
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [{ id: 'state', function: { name: 'state', arguments: '{}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );

    try {
      // When
      const result = await runOpenAiSession({
        apiKey: 'private-test-value',
        baseUrl: 'https://api.minimax.io/v1',
        client: {
          listTools: async () => ({ tools: [{ name: 'state', inputSchema: { type: 'object' } }] }),
          callTool: async () => ({ content: [{ type: 'text', text: '{"phase":"finished"}' }] }),
        },
        options: {
          botName: 'bot',
          privateKey: 'private-key',
          server: 'http://127.0.0.1:8787',
          systemPrompt: 'token=private-test-value',
          model: 'MiniMax-M3',
          modelConfig: {
            provider: 'minimax',
            model: 'MiniMax-M3',
            baseUrl: 'https://api.minimax.io/v1',
            apiKeyEnv: 'MINIMAX_API_KEY',
            temperature: 0.2,
            reasoningSplit: true,
          },
          limits: { maxModelCalls: 1, wallClockMs: 10_000 },
          onEvent: (event) => events.push(event),
        },
      });

      // Then
      expect(result.reason).toBe('finished');
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'model_request',
          model: 'MiniMax-M3',
          request: expect.objectContaining({
            model: 'MiniMax-M3',
            temperature: 0.2,
            reasoning_split: true,
          }),
        }),
      );
      expect(JSON.stringify(events)).not.toContain('private-test-value');
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'model_response',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('Given a response that crosses the aggregate budget, when the OpenAI session continues, then it records the terminal error without a second completion', async () => {
    // Given
    const budget = new RunBudget(1);
    let completions = 0;
    const events: unknown[] = [];

    // When
    const result = await runOpenAiSession({
      apiKey: 'key',
      baseUrl: 'https://models.example/v1',
      client: { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) },
      completion: async () => {
        completions++;
        return {
          content: 'continue',
          toolCalls: [],
          usage: { prompt_tokens: 1, completion_tokens: 0 },
        };
      },
      options: {
        botName: 'bot',
        privateKey: 'private',
        server: 'http://127.0.0.1:8787',
        systemPrompt: 'prompt',
        model: 'MiniMax-M3',
        modelConfig: { provider: 'minimax', model: 'MiniMax-M3', pricing: { promptPerMillion: 2 } },
        limits: { maxModelCalls: 3, wallClockMs: 10_000 },
        budget,
        onEvent: (event) => {
          events.push(event);
          if (event.kind === 'model_response' && event.usage !== undefined)
            budget.record(event.usage, { promptPerMillion: 2 });
        },
      },
    });

    // Then
    expect(completions).toBe(1);
    expect(result).toEqual({ finished: false, modelCalls: 1, reason: 'error' });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'session',
        event: 'error',
        detail: 'RunBudgetExceededError',
      }),
    );
  });
});
