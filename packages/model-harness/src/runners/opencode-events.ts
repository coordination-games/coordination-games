import type { TranscriptEvent } from '../types.js';
import {
  type CommunicationCorrection,
  OpenCodeCommunicationTracker,
} from './opencode-communication.js';

export type OpenCodeEventState = {
  readonly sessionId?: string;
  readonly finished: boolean;
  readonly modelCalls: number;
  readonly quotaTokens: number;
  readonly stopped: boolean;
  readonly publicChatSucceeded: boolean;
  readonly directChatSucceeded: boolean;
  readonly visibleTargetPlayerId?: string;
};

export class OpenCodeEventParser {
  #sessionId: string | undefined;
  #finished = false;
  #modelCalls = 0;
  #quotaTokens = 0;
  #stopped = false;
  #text = '';
  readonly #communication = new OpenCodeCommunicationTracker();

  constructor(
    private readonly bot: string,
    private readonly model: string,
  ) {}

  consume(line: string): readonly TranscriptEvent[] {
    const root = record(parseJson(line));
    if (!root) return [];
    const part = record(root.part);
    if (!part) return [];
    if (!['step_start', 'text', 'tool_use', 'step_finish'].includes(String(root.type))) return [];
    if (typeof root.sessionID === 'string' && root.sessionID) this.#sessionId = root.sessionID;
    switch (root.type) {
      case 'step_start':
        return this.stepStart(part);
      case 'text':
        this.text(part);
        return [];
      case 'tool_use':
        return this.tool(part);
      case 'step_finish':
        return this.stepFinish(part);
      default:
        return [];
    }
  }

  state(): OpenCodeEventState {
    return {
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
      finished: this.#finished,
      modelCalls: this.#modelCalls,
      quotaTokens: this.#quotaTokens,
      stopped: this.#stopped,
      ...this.#communication.state(),
    };
  }

  communicationCorrection(): CommunicationCorrection | undefined {
    return this.#communication.correction(this.#finished);
  }

  private stepStart(part: Record<string, unknown>): readonly TranscriptEvent[] {
    if (part.type !== 'step-start') return [];
    this.#modelCalls++;
    this.#stopped = false;
    return [
      {
        t: Date.now(),
        bot: this.bot,
        kind: 'model_request',
        model: this.model,
        messages: { redacted: true, source: 'opencode-cli' },
        request: { model: this.model, transport: 'opencode-cli' },
      },
    ];
  }

  private text(part: Record<string, unknown>): void {
    if (part.type !== 'text' || typeof part.text !== 'string') return;
    const text = part.text.trim();
    if (text) this.#text = this.#text ? `${this.#text}\n${text}` : text;
  }

  private tool(part: Record<string, unknown>): readonly TranscriptEvent[] {
    if (part.type !== 'tool' || typeof part.tool !== 'string' || !part.tool) return [];
    const state = record(part.state);
    if (!state || (state.status !== 'completed' && state.status !== 'error')) return [];
    const args = record(state.input) ?? {};
    const rawResult =
      state.status === 'completed' && typeof state.output === 'string'
        ? state.output
        : typeof state.error === 'string'
          ? state.error
          : '';
    const parsedResult = parseJson(rawResult) ?? rawResult;
    if (containsFinished(parsedResult)) this.#finished = true;
    this.#communication.observe({
      tool: part.tool,
      status: state.status,
      args,
      result: parsedResult,
    });
    return [
      { t: Date.now(), bot: this.bot, kind: 'tool_call', name: part.tool, args },
      {
        t: Date.now(),
        bot: this.bot,
        kind: 'tool_result',
        name: part.tool,
        result: parsedResult,
        ...(state.status === 'error' ? { isError: true } : {}),
        ...extractCursors(parsedResult),
      },
    ];
  }

  private stepFinish(part: Record<string, unknown>): readonly TranscriptEvent[] {
    if (part.type !== 'step-finish') return [];
    this.#stopped = part.reason === 'stop';
    const usage = tokenUsage(part.tokens);
    if (usage) this.#quotaTokens += usage.prompt_tokens + usage.completion_tokens;
    const event: TranscriptEvent = {
      t: Date.now(),
      bot: this.bot,
      kind: 'model_response',
      ...(this.#text ? { text: this.#text } : {}),
      ...(usage ? { usage } : {}),
    };
    this.#text = '';
    return [event];
  }
}

function tokenUsage(
  value: unknown,
): { readonly prompt_tokens: number; readonly completion_tokens: number } | undefined {
  const tokens = record(value);
  const cache = record(tokens?.cache);
  const input = tokens?.input;
  const output = tokens?.output;
  const reasoning = tokens?.reasoning;
  const cacheRead = cache?.read;
  const cacheWrite = cache?.write;
  if (
    !isTokenCount(input) ||
    !isTokenCount(output) ||
    !isTokenCount(reasoning) ||
    !isTokenCount(cacheRead) ||
    !isTokenCount(cacheWrite)
  )
    return undefined;
  const promptTokens = input + cacheRead + cacheWrite;
  const completionTokens = output + reasoning;
  if (!Number.isSafeInteger(promptTokens) || !Number.isSafeInteger(completionTokens))
    return undefined;
  if (promptTokens + completionTokens <= 0) return undefined;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens };
}

function containsFinished(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  const current = record(value);
  if (!current) return false;
  if (current.phase === 'finished') return true;
  return ['result', 'state', 'data'].some((key) => containsFinished(current[key], depth + 1));
}

function extractCursors(value: unknown): {
  readonly stateVersion?: number;
  readonly relayCursor?: number;
} {
  const root = record(value);
  const nested = [root, record(root?.result), record(root?.state)].filter(
    (entry): entry is Record<string, unknown> => entry !== undefined,
  );
  const stateVersion = nested
    .map((entry) => entry.stateVersion ?? entry.knownStateVersion)
    .find(isTokenCount);
  const relayCursor = nested.map((entry) => entry.sinceIdx).find(isTokenCount);
  return {
    ...(stateVersion !== undefined ? { stateVersion } : {}),
    ...(relayCursor !== undefined ? { relayCursor } : {}),
  };
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
