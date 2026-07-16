import { describe, expect, it, vi } from 'vitest';

type FetchInput = {
  readonly url: string;
  readonly init: RequestInit;
};

const testState = vi.hoisted(() => ({
  fetches: [] as FetchInput[],
  responses: [] as unknown[],
  toolCalls: [] as { readonly name: string; readonly arguments: Record<string, unknown> }[],
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    readonly pid = undefined;
    async close(): Promise<void> {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(_transport: unknown): Promise<void> {}
    async close(): Promise<void> {}
    async listTools(): Promise<{
      readonly tools: readonly {
        readonly name: string;
        readonly inputSchema: Record<string, unknown>;
      }[];
    }> {
      return { tools: [{ name: 'state', inputSchema: { type: 'object' } }] };
    }
    async callTool(input: {
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }): Promise<{ readonly content: readonly { readonly type: 'text'; readonly text: string }[] }> {
      testState.toolCalls.push(input);
      return { content: [{ type: 'text', text: '{"phase":"finished"}' }] };
    }
  },
}));

import { OpenRouterAgentRunner } from '../openrouter.js';

function providerResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function opts(): Parameters<OpenRouterAgentRunner['runSession']>[0] {
  return {
    botName: 'bot-red',
    privateKey: 'not-a-live-key',
    server: 'http://127.0.0.1:8787',
    systemPrompt: 'test prompt',
    model: 'minimax/minimax-m2',
    limits: { maxModelCalls: 3, wallClockMs: 10_000 },
    onEvent: () => undefined,
  };
}

describe('OpenRouterAgentRunner runtime reliability RED cases', () => {
  it('Given a retryable provider failure, when the call is retried, then it uses bounded attempts', async () => {
    // Given / When
    const originalFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';
    testState.fetches.length = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      testState.fetches.push({ url: String(input), init: init ?? {} });
      return providerResponse({ error: { message: 'temporarily unavailable' } }, 503);
    });

    try {
      await new OpenRouterAgentRunner().runSession(opts());
      // Then: Task 19 requires the default bounded retry policy to consume three attempts.
      expect(testState.fetches).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('Given malformed tool JSON, when the provider responds, then it terminates after correction exhaustion instead of dispatching it', async () => {
    // Given / When
    const originalFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';
    testState.toolCalls.length = 0;
    globalThis.fetch = vi.fn(async () =>
      providerResponse({
        choices: [
          {
            message: { tool_calls: [{ id: 'bad-1', function: { name: 'state', arguments: '{' } }] },
          },
        ],
      }),
    );

    try {
      const result = await new OpenRouterAgentRunner().runSession(opts());
      // Then: malformed calls must be corrected or fail, never become an MCP call.
      expect(result.reason).toBe('error');
      expect(testState.toolCalls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('Given a model call that stops heartbeating, when its timeout elapses, then the session terminates', async () => {
    // Given / When
    const originalFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.useFakeTimers();
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = resolve;
          init?.signal?.addEventListener('abort', () => {
            resolve(providerResponse({ error: { message: 'aborted' } }, 499));
          });
        }),
    );

    try {
      let settled = false;
      const session = new OpenRouterAgentRunner().runSession({
        ...opts(),
        limits: { maxModelCalls: 3, wallClockMs: 25 },
      });
      void session.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(26);

      // Then: a hard-stalled in-flight request must not outlive the session budget.
      expect(settled).toBe(true);
      release?.(providerResponse({ choices: [{ message: { content: 'late' } }] }));
      await session;
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('Given an unsupported tool, when the model corrects it, then only the corrected action is dispatched', async () => {
    // Given / When
    const originalFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';
    testState.toolCalls.length = 0;
    const replies = [
      {
        choices: [
          {
            message: {
              tool_calls: [{ id: 'wrong', function: { name: 'erase', arguments: '{}' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              tool_calls: [{ id: 'right', function: { name: 'state', arguments: '{}' } }],
            },
          },
        ],
      },
    ];
    globalThis.fetch = vi.fn(async () => providerResponse(replies.shift()));

    try {
      const result = await new OpenRouterAgentRunner().runSession(opts());

      // Then: invalid actions feed correction context to the model without hitting MCP.
      expect(result.finished).toBe(true);
      expect(testState.toolCalls).toEqual([{ name: 'state', arguments: {} }]);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('Given an unusable provider configuration, when a session starts, then it rejects before requesting the provider', async () => {
    // Given / When
    const originalFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = 'test-key';
    testState.fetches.length = 0;
    globalThis.fetch = vi.fn(async () => providerResponse({ choices: [] }));

    try {
      const result = await new OpenRouterAgentRunner().runSession({ ...opts(), model: ' ' });

      // Then: model capability/configuration errors are actionable before network use.
      expect(result.reason).toBe('error');
      expect(testState.fetches).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('Given progress heartbeats, when the action completes, then it does not false-stall and transcript messages are redacted', async () => {
    const originalFetch = globalThis.fetch;
    const events: unknown[] = [];
    process.env.OPENROUTER_API_KEY = 'test-key';
    globalThis.fetch = vi.fn(async () =>
      providerResponse({
        choices: [
          {
            message: {
              tool_calls: [{ id: 'state', function: { name: 'state', arguments: '{}' } }],
            },
          },
        ],
      }),
    );

    try {
      const result = await new OpenRouterAgentRunner().runSession({
        ...opts(),
        systemPrompt: 'INSPECTOR_TOKEN=assignment-secret',
        onEvent: (event) => events.push(event),
      });

      expect(result.reason).toBe('finished');
      expect(JSON.stringify(events)).not.toContain('assignment-secret');
      expect(JSON.stringify(events)).toContain('heartbeat');
      expect(JSON.stringify(events)).not.toContain('timeout');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});
