import { redactValue } from '../gui/redact.js';
import type { RunSessionOptions, SessionResult, ToolResultEvent } from '../types.js';
import {
  type ChatMessage,
  type CompletionResponse,
  isRetryableProviderError,
  requestCompletion,
  validateProviderConfig,
} from './openai-provider.js';
import {
  callTool,
  invalidToolCall,
  looksFinished,
  mapTools,
  parseArguments,
  type ToolClient,
  toolCallsWithIds,
} from './openai-tools.js';
import {
  RuntimeTimeoutError,
  retryProviderCall,
  ToolCorrectionExhaustedError,
} from './runtime-reliability.js';

const MAX_CORRECTIONS = 2;

export async function runOpenAiSession(input: {
  readonly client: ToolClient;
  readonly options: RunSessionOptions;
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
}): Promise<SessionResult> {
  const { client, options, apiKey, baseUrl } = input;
  const wireModel = options.model.replace(/^openrouter\//, '');
  const startedAt = Date.now();
  const deadline = startedAt + options.limits.wallClockMs;
  let modelCalls = 0;
  let corrections = 0;
  let finished = false;
  options.onEvent({
    t: startedAt,
    bot: options.botName,
    kind: 'session',
    event: 'start',
    detail: wireModel,
  });
  try {
    validateProviderConfig({ apiKey, baseUrl, model: wireModel });
    const listed = await client.listTools();
    const tools = mapTools(listed);
    const allowedTools = new Set(tools.map((tool) => tool.function.name));
    const messages: ChatMessage[] = [
      { role: 'system', content: options.systemPrompt },
      {
        role: 'user',
        content: 'You are joined to an active lobby. Begin: call guide, then state.',
      },
    ];

    while (Date.now() < deadline && modelCalls < options.limits.maxModelCalls) {
      const timeoutMs = Math.max(1, Math.min(30_000, deadline - Date.now()));
      options.onEvent({
        t: Date.now(),
        bot: options.botName,
        kind: 'session',
        event: 'heartbeat',
        detail: 'provider request started',
      });
      options.onEvent({
        t: Date.now(),
        bot: options.botName,
        kind: 'model_request',
        model: wireModel,
        messages: redactValue(messages),
      });
      modelCalls++;
      const assistant = await retryProviderCall<CompletionResponse>({
        operation: (signal) =>
          requestCompletion({
            baseUrl,
            apiKey: apiKey ?? '',
            model: wireModel,
            messages,
            tools,
            signal,
          }),
        retryable: isRetryableProviderError,
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        hooks: {
          onRetry: (attempt, delayMs) =>
            options.onEvent({
              t: Date.now(),
              bot: options.botName,
              kind: 'session',
              event: 'retry',
              detail: `attempt=${attempt} delayMs=${delayMs}`,
            }),
          onTimeout: (elapsed) =>
            options.onEvent({
              t: Date.now(),
              bot: options.botName,
              kind: 'session',
              event: 'timeout',
              detail: `timeoutMs=${elapsed}`,
            }),
        },
      });
      options.onEvent({
        t: Date.now(),
        bot: options.botName,
        kind: 'session',
        event: 'heartbeat',
        detail: 'provider response received',
      });
      const toolCalls = toolCallsWithIds(assistant.toolCalls, modelCalls);
      options.onEvent({
        t: Date.now(),
        bot: options.botName,
        kind: 'model_response',
        ...(assistant.content !== null ? { text: assistant.content } : {}),
        ...(toolCalls.length
          ? {
              toolCalls: toolCalls.map((call) => ({
                name: call.function.name,
                args: redactValue(parseArguments(call.function.arguments) ?? {}),
              })),
            }
          : {}),
        ...(assistant.usage !== undefined ? { usage: assistant.usage } : {}),
      });
      messages.push({
        role: 'assistant',
        content: assistant.content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      if (!toolCalls.length) {
        messages.push({
          role: 'system',
          content: 'Not over until phase:finished — call state, wait, or a game action.',
        });
        continue;
      }

      const invalid = invalidToolCall(toolCalls, allowedTools);
      if (invalid) {
        corrections++;
        options.onEvent({
          t: Date.now(),
          bot: options.botName,
          kind: 'session',
          event: 'correction',
          detail: `count=${corrections} reason=${invalid}`,
        });
        if (corrections > MAX_CORRECTIONS)
          throw new ToolCorrectionExhaustedError(corrections, invalid);
        for (const call of toolCalls) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id ?? 'unreachable-tool-call-id',
            content: JSON.stringify({ error: 'tool call requires correction' }),
          });
        }
        messages.push({
          role: 'system',
          content: `Correct your tool call: ${invalid}. Use only advertised tool names and JSON object arguments.`,
        });
        continue;
      }

      for (const call of toolCalls) {
        const name = call.function.name;
        const args = parseArguments(call.function.arguments);
        if (!args)
          throw new ToolCorrectionExhaustedError(
            corrections,
            'tool call arguments changed after validation',
          );
        const toolCallId = call.id ?? `${name}-${modelCalls}`;
        options.onEvent({
          t: Date.now(),
          bot: options.botName,
          kind: 'tool_call',
          name,
          args: redactValue(args),
        });
        const result = await callTool(client, name, args);
        const event: ToolResultEvent = {
          t: Date.now(),
          bot: options.botName,
          kind: 'tool_result',
          name,
          result: redactValue(result.parsed),
          ...(result.isError ? { isError: true } : {}),
        };
        options.onEvent(event);
        options.onEvent({
          t: Date.now(),
          bot: options.botName,
          kind: 'session',
          event: 'heartbeat',
          detail: 'tool result received',
        });
        messages.push({ role: 'tool', tool_call_id: toolCallId, name, content: result.text });
        if (looksFinished(result.text)) finished = true;
      }
      if (finished) {
        options.onEvent({
          t: Date.now(),
          bot: options.botName,
          kind: 'session',
          event: 'finished',
        });
        return { finished: true, modelCalls, reason: 'finished' };
      }
    }
    options.onEvent({
      t: Date.now(),
      bot: options.botName,
      kind: 'session',
      event: 'cap',
      detail:
        Date.now() >= deadline
          ? 'wallClockMs exceeded'
          : `maxModelCalls (${options.limits.maxModelCalls}) reached`,
    });
    return { finished: false, modelCalls, reason: 'cap' };
  } catch (error) {
    const event = options.signal?.aborted
      ? 'cancelled'
      : error instanceof RuntimeTimeoutError
        ? 'timeout'
        : 'error';
    options.onEvent({
      t: Date.now(),
      bot: options.botName,
      kind: 'session',
      event,
      detail: redactedError(error),
    });
    return { finished: false, modelCalls, reason: 'error' };
  }
}

function redactedError(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown runtime failure';
}
