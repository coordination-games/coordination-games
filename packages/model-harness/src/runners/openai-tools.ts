import { isRecord, type OpenAiTool, type OpenAiToolCall } from './openai-provider.js';

export type ToolClient = {
  readonly listTools: () => Promise<{
    readonly tools?: readonly {
      readonly name: string;
      readonly description?: string | undefined;
      readonly inputSchema?: Record<string, unknown> | undefined;
    }[];
  }>;
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<{ readonly content: unknown; readonly isError?: boolean | undefined }>;
};

const EMPTY_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export function mapTools(listed: Awaited<ReturnType<ToolClient['listTools']>>): OpenAiTool[] {
  return (listed.tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema ?? EMPTY_SCHEMA,
    },
  }));
}

export function invalidToolCall(
  calls: readonly OpenAiToolCall[],
  allowed: ReadonlySet<string>,
): string | undefined {
  for (const call of calls) {
    if (!call.function.name) return 'tool name is missing';
    if (!allowed.has(call.function.name)) return 'tool name is unsupported';
    if (!parseArguments(call.function.arguments)) return 'tool arguments are not a JSON object';
  }
  return undefined;
}

export function parseArguments(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function toolCallsWithIds(
  calls: readonly OpenAiToolCall[],
  modelCalls: number,
): OpenAiToolCall[] {
  return calls.map((call, index) =>
    call.id ? call : { ...call, id: `tool-call-${modelCalls}-${index + 1}` },
  );
}

export async function callTool(
  client: ToolClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly text: string; readonly parsed: unknown; readonly isError: boolean }> {
  try {
    const response = await client.callTool({ name, arguments: args });
    const text = stringifyContent(response.content);
    return { text, parsed: parseJson(text), isError: response.isError === true };
  } catch (error) {
    return {
      text: JSON.stringify({ error: 'tool dispatch failed' }),
      parsed: { error: error instanceof Error ? error.name : 'unknown tool failure' },
      isError: true,
    };
  }
}

export function looksFinished(value: string): boolean {
  return /"phase"\s*:\s*"finished"/.test(value);
}

function stringifyContent(content: unknown): string {
  if (!Array.isArray(content))
    return typeof content === 'string' ? content : JSON.stringify(content ?? {});
  return content
    .map((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : JSON.stringify({ type: isRecord(block) ? (block.type ?? 'unknown') : 'unknown' }),
    )
    .join('\n');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { text: value };
  }
}
