import { RuntimeTimeoutError } from './runtime-reliability.js';

export type OpenAiTool = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: Record<string, unknown>;
  };
};

export type OpenAiToolCall = {
  readonly id?: string;
  readonly function: { readonly name: string; readonly arguments: string };
};

export type ChatMessage = {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly OpenAiToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
};

export type CompletionResponse = {
  readonly content: string | null;
  readonly toolCalls: readonly OpenAiToolCall[];
  readonly usage?: unknown;
};

export class ProviderConfigurationError extends Error {
  readonly name = 'ProviderConfigurationError';
  constructor(readonly reason: string) {
    super(`Provider configuration rejected: ${reason}`);
  }
}

export class ProviderHttpError extends Error {
  readonly name = 'ProviderHttpError';
  constructor(readonly status: number) {
    super(`Provider returned HTTP ${status}`);
  }
}

export class ProviderResponseError extends Error {
  readonly name = 'ProviderResponseError';
  constructor(readonly reason: string) {
    super(`Provider response rejected: ${reason}`);
  }
}

export function validateProviderConfig(input: {
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly model: string;
}): void {
  if (!input.apiKey?.trim()) throw new ProviderConfigurationError('missing API key');
  if (!input.model.trim()) throw new ProviderConfigurationError('model is empty');
  try {
    const url = new URL(input.baseUrl);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new ProviderConfigurationError('base URL must use HTTPS outside local development');
    }
  } catch (error) {
    if (error instanceof ProviderConfigurationError) throw error;
    throw new ProviderConfigurationError('base URL is not a valid URL');
  }
}

export function isRetryableProviderError(error: unknown): boolean {
  if (error instanceof RuntimeTimeoutError) return true;
  if (error instanceof ProviderHttpError) {
    return (
      error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return error instanceof TypeError;
}

export async function requestCompletion(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAiTool[];
  readonly signal: AbortSignal;
}): Promise<CompletionResponse> {
  const response = await fetch(`${input.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://games.coop',
      'X-Title': 'Coordination Games Harness',
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      ...(input.tools.length > 0 ? { tools: input.tools, tool_choice: 'auto' } : {}),
    }),
    signal: input.signal,
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  const text = await response.text();
  const body = parseJson(text);
  if (!isRecord(body)) throw new ProviderResponseError('response was not a JSON object');
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
  if (!message) throw new ProviderResponseError('response has no assistant message');
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return {
    content: typeof message.content === 'string' ? message.content : null,
    toolCalls: rawCalls.map(normalizeToolCall),
    ...(body.usage !== undefined ? { usage: body.usage } : {}),
  };
}

function normalizeToolCall(raw: unknown): OpenAiToolCall {
  const record = isRecord(raw) ? raw : {};
  const fn = isRecord(record.function) ? record.function : {};
  const argumentValue = fn.arguments;
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    function: {
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments:
        typeof argumentValue === 'string' ? argumentValue : JSON.stringify(argumentValue ?? {}),
    },
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
