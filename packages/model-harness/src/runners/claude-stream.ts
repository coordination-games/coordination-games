import type { TranscriptEvent } from '../types.js';

export function tryParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function parseStreamLine(
  line: string,
  bot: string,
): {
  readonly events: readonly TranscriptEvent[];
  readonly seenFinished: boolean;
} {
  const parsed = record(tryParse(line));
  if (!parsed) return { events: [], seenFinished: false };
  const now = Date.now();
  if (parsed.type === 'assistant') return parseAssistant(parsed, bot, now);
  if (parsed.type === 'user') return parseUser(parsed, bot, now);
  return { events: [], seenFinished: false };
}

function parseAssistant(value: Record<string, unknown>, bot: string, now: number) {
  const message = record(value.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const events: TranscriptEvent[] = [];
  let text: string | undefined;
  const toolCalls: { name: string; args: unknown }[] = [];
  for (const item of content) {
    const block = record(item);
    if (!block) continue;
    if (block.type === 'text') {
      const next = typeof block.text === 'string' ? block.text.trim() : '';
      if (next) text = `${text ?? ''}${next}`;
    }
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : '';
      const args = block.input ?? {};
      toolCalls.push({ name, args });
      events.push({ t: now, bot, kind: 'tool_call', name, args });
    }
  }
  events.push({
    t: now,
    bot,
    kind: 'model_response',
    ...(text !== undefined ? { text } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(message?.usage !== undefined ? { usage: message.usage } : {}),
  });
  return { events, seenFinished: false };
}

function parseUser(value: Record<string, unknown>, bot: string, now: number) {
  const message = record(value.message);
  const content = message && Array.isArray(message.content) ? message.content : [];
  const events: TranscriptEvent[] = [];
  let seenFinished = false;
  for (const item of content) {
    const block = record(item);
    if (!block || block.type !== 'tool_result') continue;
    const raw = toolResultBody(block.content);
    const result = tryParse(raw);
    const cursors = extractCursors(result);
    if (isFinished(result)) seenFinished = true;
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
    const name =
      typeof block.name === 'string' && block.name ? block.name : `[${toolUseId ?? 'unknown'}]`;
    events.push({
      t: now,
      bot,
      kind: 'tool_result',
      name,
      result: result ?? raw,
      ...(block.is_error === true ? { isError: true } : {}),
      ...cursors,
    });
  }
  return { events, seenFinished };
}

function toolResultBody(value: unknown): string {
  return Array.isArray(value)
    ? value
        .map((item) =>
          record(item)?.type === 'text' ? String(record(item)?.text ?? '') : JSON.stringify(item),
        )
        .join(' ')
    : JSON.stringify(value ?? '');
}

function isFinished(value: unknown): boolean {
  const result = record(value);
  return (
    result?.phase === 'finished' ||
    record(result?.result)?.phase === 'finished' ||
    record(result?.state)?.phase === 'finished'
  );
}

function extractCursors(value: unknown): {
  readonly stateVersion?: number;
  readonly relayCursor?: number;
} {
  const root = record(value);
  const candidates = [root, record(root?.result), record(root?.state), record(root?.meta)].filter(
    (candidate): candidate is Record<string, unknown> => candidate !== undefined,
  );
  let stateVersion: number | undefined;
  let relayCursor: number | undefined;
  for (const candidate of candidates) {
    if (stateVersion === undefined && typeof candidate.knownStateVersion === 'number')
      stateVersion = candidate.knownStateVersion;
    if (stateVersion === undefined && typeof candidate.stateVersion === 'number')
      stateVersion = candidate.stateVersion;
    if (relayCursor === undefined && typeof candidate.sinceIdx === 'number')
      relayCursor = candidate.sinceIdx;
    const meta = record(candidate.meta);
    if (relayCursor === undefined && typeof meta?.sinceIdx === 'number')
      relayCursor = meta.sinceIdx;
  }
  return {
    ...(stateVersion !== undefined ? { stateVersion } : {}),
    ...(relayCursor !== undefined ? { relayCursor } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
