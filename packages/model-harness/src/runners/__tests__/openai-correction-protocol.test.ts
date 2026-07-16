import { describe, expect, it, vi } from 'vitest';
import { runOpenAiSession } from '../openai-session.js';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('runOpenAiSession correction protocol', () => {
  it('Given an invalid assistant tool call, when requesting correction, then acknowledges its tool_call_id before the next request', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: unknown[] = [];
    const replies = [
      {
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'invalid-1', function: { name: 'unknown', arguments: 'secret=hidden' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              tool_calls: [{ id: 'state-1', function: { name: 'state', arguments: '{}' } }],
            },
          },
        ],
      },
    ];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      return response(replies.shift());
    });

    try {
      const result = await runOpenAiSession({
        apiKey: 'test-key',
        baseUrl: 'https://provider.test',
        client: {
          listTools: async () => ({ tools: [{ name: 'state', inputSchema: { type: 'object' } }] }),
          callTool: async () => ({ content: [{ type: 'text', text: '{"phase":"finished"}' }] }),
        },
        options: {
          botName: 'bot',
          privateKey: 'key',
          server: 'http://127.0.0.1:8787',
          systemPrompt: 'test prompt',
          model: 'minimax/test',
          limits: { maxModelCalls: 3, wallClockMs: 10_000 },
          onEvent: () => undefined,
        },
      });
      const second = requestBodies[1] as {
        readonly messages: readonly {
          readonly role: string;
          readonly tool_call_id?: string;
          readonly content: string | null;
        }[];
      };

      expect(result.reason).toBe('finished');
      expect(second.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'tool', tool_call_id: 'invalid-1' }),
        ]),
      );
      const assistantIndex = second.messages.findIndex((message) => message.role === 'assistant');
      const toolIndex = second.messages.findIndex((message) => message.role === 'tool');
      const correctionIndex = second.messages.findIndex(
        (message) =>
          message.role === 'system' && message.content?.startsWith('Correct your tool call'),
      );
      expect(assistantIndex).toBeLessThan(toolIndex);
      expect(toolIndex).toBeLessThan(correctionIndex);
      expect(JSON.stringify(second.messages[correctionIndex])).not.toContain('hidden');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
