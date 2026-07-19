import { buildCompletionRequestBody, type CompletionRequestInput } from './openai-provider.js';

type ScriptedTool = {
  readonly name: string;
  readonly arguments: string;
};

export async function scriptedTragedyCompletion(input: CompletionRequestInput) {
  input.onRequest?.(buildCompletionRequestBody(input));
  const calledTools = input.messages.flatMap((message) =>
    message.role === 'tool' && typeof message.name === 'string' ? [message.name] : [],
  );
  const lastToolResult = [...input.messages]
    .reverse()
    .find((message) => message.role === 'tool' && typeof message.name === 'string');
  const lastTool = lastToolResult?.name;
  const state = [...input.messages]
    .reverse()
    .find((message) => message.role === 'tool' && message.name === 'state')?.content;
  const ownHandle = input.messages[0]?.content?.match(/You are ([^,]+),/)?.[1] ?? '';
  const recipient = scriptedRecipientFromMessages(input.messages, ownHandle);
  const tool = scriptedTragedyTool({
    calledTools,
    lastTool,
    state,
    ownHandle,
    ...(recipient === undefined ? {} : { recipient }),
    availableTools: currentPhaseTools(input.messages),
    lastToolIsStateSource: lastToolIsStateSource(input.messages),
    ...(lastToolResult?.content !== undefined ? { lastToolResult: lastToolResult.content } : {}),
  });
  return {
    content: null,
    toolCalls: [{ id: `scripted-${tool.name}`, function: tool }],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };
}

export function scriptedTragedyTool(input: {
  readonly calledTools: readonly string[];
  readonly lastTool: string | undefined;
  readonly state: string | null | undefined;
  readonly ownHandle: string;
  readonly recipient?: string;
  readonly availableTools?: readonly string[];
  readonly lastToolIsStateSource?: boolean;
  readonly lastToolResult?: string | null;
}): ScriptedTool {
  if (!input.calledTools.includes('guide')) return { name: 'guide', arguments: '{}' };
  if (!input.calledTools.includes('state')) return { name: 'state', arguments: '{}' };
  if (!input.calledTools.includes('chat')) {
    return {
      name: 'chat',
      arguments: JSON.stringify({
        message: 'I will coordinate and act through this game.',
        scope: 'all',
      }),
    };
  }
  const recipient = input.recipient ?? scriptedRecipient(input.state, input.ownHandle);
  if (recipient && input.calledTools.filter((name) => name === 'chat').length < 2) {
    return {
      name: 'chat',
      arguments: JSON.stringify({ message: 'Private coordination confirmed.', scope: recipient }),
    };
  }
  if (lastTurnActionFailed(input.lastTool, input.lastToolResult)) {
    return { name: 'wait', arguments: '{}' };
  }
  if (input.lastTool !== 'state' && !input.lastToolIsStateSource)
    return { name: 'state', arguments: '{}' };
  const availableTools = input.availableTools ?? currentPhaseToolsFromState(input.state);
  if (availableTools.includes('place_starting_camp')) {
    return {
      name: 'place_starting_camp',
      arguments: JSON.stringify({ intersectionId: scriptedCamp(input.ownHandle) }),
    };
  }
  if (availableTools.includes('pass')) return { name: 'pass', arguments: '{}' };
  return { name: 'wait', arguments: '{}' };
}

function currentPhaseTools(messages: CompletionRequestInput['messages']): readonly string[] {
  let tools: readonly string[] = [];
  for (const message of messages) {
    if (
      message.role !== 'tool' ||
      (message.name !== 'state' && message.name !== 'wait') ||
      message.content === null
    )
      continue;
    const state = parseState(message.content);
    if (!state) continue;
    const currentPhase = state.currentPhase;
    if (isRecord(currentPhase) && Array.isArray(currentPhase.tools)) {
      tools = normalizeToolNames(currentPhase.tools);
      continue;
    }
    if (includesKey(state._removedKeys, 'currentPhase')) tools = [];
  }
  return tools;
}

function lastToolIsStateSource(messages: CompletionRequestInput['messages']): boolean {
  const latest = [...messages]
    .reverse()
    .find((message) => message.role === 'tool' && typeof message.name === 'string');
  return (
    latest?.name === 'state' ||
    (latest?.name === 'wait' && latest.content !== null && parseState(latest.content) !== undefined)
  );
}

function currentPhaseToolsFromState(state: string | null | undefined): readonly string[] {
  const parsed = state ? parseState(state) : undefined;
  const currentPhase = parsed?.currentPhase;
  return isRecord(currentPhase) && Array.isArray(currentPhase.tools)
    ? normalizeToolNames(currentPhase.tools)
    : [];
}

function lastTurnActionFailed(
  lastTool: string | undefined,
  result: string | null | undefined,
): boolean {
  if (lastTool !== 'pass' && lastTool !== 'place_starting_camp') return false;
  const parsed = result ? parseState(result) : undefined;
  return isRecord(parsed) && 'error' in parsed;
}

function normalizeToolNames(tools: readonly unknown[]): readonly string[] {
  return tools.flatMap((tool) => {
    if (typeof tool === 'string' && tool.length > 0) return [tool];
    if (isRecord(tool) && typeof tool.name === 'string' && tool.name.length > 0) return [tool.name];
    return [];
  });
}

function parseState(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function includesKey(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((key) => key === expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scriptedRecipient(
  state: string | null | undefined,
  ownHandle: string,
): string | undefined {
  if (!state) return undefined;
  return [...state.matchAll(/bot\d+-[a-f0-9]+/gi)]
    .map((match) => match[0])
    .find((handle) => handle !== ownHandle);
}

function scriptedRecipientFromMessages(
  messages: CompletionRequestInput['messages'],
  ownHandle: string,
): string | undefined {
  for (const message of messages) {
    if (message.role !== 'tool' || message.content === null) continue;
    const state = parseState(message.content);
    if (!state) continue;
    if (isRecord(state.handleMap)) {
      for (const [playerId, handle] of Object.entries(state.handleMap)) {
        if (typeof handle === 'string' && handle !== ownHandle) return playerId;
      }
    }
    const ownPlayerId =
      isRecord(state.you) && typeof state.you.id === 'string' ? state.you.id : undefined;
    if (ownPlayerId && Array.isArray(state.scoreboard)) {
      for (const player of state.scoreboard) {
        if (isRecord(player) && typeof player.id === 'string' && player.id !== ownPlayerId)
          return player.id;
      }
    }
  }
  return undefined;
}

function scriptedCamp(ownHandle: string): string {
  const index = Number(ownHandle.match(/^bot(\d+)-/)?.[1]);
  if (index === 2) return 'north';
  if (index === 3) return 'south';
  return 'northWest';
}
