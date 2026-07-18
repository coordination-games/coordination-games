import type { ResolvedModelProfile } from '../model-profiles.js';
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

export type CompletionRequestInput = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAiTool[];
  readonly signal: AbortSignal;
  readonly profile?: ResolvedModelProfile;
  readonly onRequest?: (body: CompletionRequestBody) => void;
};

export type CompletionRequestBody = {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly OpenAiTool[];
  readonly tool_choice?: 'auto';
  readonly temperature?: number;
  readonly top_p?: number;
  readonly max_tokens?: number;
  readonly reasoning_split?: boolean;
  readonly reasoning_effort?: string;
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

export function resolveProfileProviderConfig(profile: ResolvedModelProfile): {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
} {
  if (!profile.baseUrl) throw new ProviderConfigurationError('profile has no base URL');
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined,
  };
}

export function buildCompletionRequestBody(input: {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly OpenAiTool[];
  readonly profile?: ResolvedModelProfile;
}): CompletionRequestBody {
  const tuning = input.profile;
  return {
    model: input.model,
    messages: input.messages,
    ...(input.tools.length > 0 ? { tools: input.tools, tool_choice: 'auto' as const } : {}),
    ...(tuning?.temperature !== undefined ? { temperature: tuning.temperature } : {}),
    ...(tuning?.topP !== undefined ? { top_p: tuning.topP } : {}),
    ...(tuning?.maxCompletionTokens !== undefined
      ? { max_tokens: tuning.maxCompletionTokens }
      : {}),
    ...(tuning?.reasoningSplit !== undefined ? { reasoning_split: tuning.reasoningSplit } : {}),
    ...(tuning?.reasoningEffort !== undefined ? { reasoning_effort: tuning.reasoningEffort } : {}),
  };
}

export async function requestCompletion(
  input: CompletionRequestInput,
): Promise<CompletionResponse> {
  const body = buildCompletionRequestBody(input);
  input.onRequest?.(body);
  const response = await fetch(`${input.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://games.coop',
      'X-Title': 'Coordination Games Harness',
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  const text = await response.text();
  const responseBody = parseJson(text);
  if (!isRecord(responseBody)) throw new ProviderResponseError('response was not a JSON object');
  const choice = Array.isArray(responseBody.choices) ? responseBody.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
  if (!message) throw new ProviderResponseError('response has no assistant message');
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return {
    content: typeof message.content === 'string' ? message.content : null,
    toolCalls: rawCalls.map(normalizeToolCall),
    ...(responseBody.usage !== undefined ? { usage: responseBody.usage } : {}),
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
