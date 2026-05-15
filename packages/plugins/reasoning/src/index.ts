import {
  type AgentInfo,
  registerPluginRelayTypes,
  type ToolPlugin,
} from '@coordination-games/engine';
import { z } from 'zod';

export const REASONING_RELAY_TYPE = 'reasoning';

const ReasoningMessageSchema = z
  .object({
    body: z.string(),
    stage: z.string().optional(),
    tags: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface RelayMessage {
  type: string;
  data: unknown;
  scope: 'team' | 'all' | string;
  pluginId: string;
  sender: string;
  turn: number;
  timestamp: number;
  index: number;
}

export interface ReasoningEntry {
  from: string;
  body: string;
  turn: number;
  scope: 'team' | 'all' | string;
  stage?: string;
  tags: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRelayMessage(value: unknown): value is RelayMessage {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    'data' in value &&
    typeof value.scope === 'string' &&
    typeof value.pluginId === 'string' &&
    typeof value.sender === 'string' &&
    typeof value.turn === 'number' &&
    typeof value.timestamp === 'number' &&
    typeof value.index === 'number'
  );
}

export function formatReasoningMessage(message: string, scope = 'all', stage?: string) {
  return {
    type: REASONING_RELAY_TYPE,
    data: {
      body: message,
      ...(stage ? { stage } : {}),
    },
    scope,
    pluginId: 'reasoning',
  };
}

export function extractReasoningEntries(relayMessages: RelayMessage[]): ReasoningEntry[] {
  return relayMessages
    .filter((msg) => msg.type === REASONING_RELAY_TYPE)
    .map((msg) => {
      const data = isRecord(msg.data) ? msg.data : {};
      const tags = isRecord(data.tags) ? data.tags : {};
      return {
        from: msg.sender,
        body: typeof data.body === 'string' ? data.body : '',
        turn: msg.turn,
        scope: msg.scope,
        ...(typeof data.stage === 'string' ? { stage: data.stage } : {}),
        tags: {
          ...tags,
          source: msg.pluginId,
          sender: msg.sender,
          timestamp: msg.timestamp,
        },
      } satisfies ReasoningEntry;
    });
}

export const ReasoningPlugin: ToolPlugin = {
  id: 'reasoning',
  version: '0.1.0',
  modes: [{ name: 'reasoning', consumes: [], provides: ['reasoning'] }],
  purity: 'pure',
  relayTypes: { [REASONING_RELAY_TYPE]: ReasoningMessageSchema },
  agentEnvelopeKeys: { reasoning: 'reasoning' },
  tools: [
    {
      name: 'share_reasoning',
      description:
        'Publish an explicit authored reasoning entry to the relay. Use this for observable strategy notes or justification, not hidden chain-of-thought.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The reasoning or strategy note to publish.',
          },
          scope: {
            type: 'string',
            description:
              'Who receives it: "team", "all", or a specific agentId for a DM-like reasoning.',
          },
          stage: {
            type: 'string',
            description:
              'Optional phase label such as planning, negotiation, action, or reflection.',
          },
        },
        required: ['message'],
      },
      mcpExpose: true,
    },
  ],
  handleData(_mode: string, inputs: Map<string, unknown>): Map<string, unknown> {
    const rawRelayMessages = inputs.get('relay-messages');
    const relayMessages = Array.isArray(rawRelayMessages)
      ? rawRelayMessages.filter(isRelayMessage)
      : [];
    return new Map([['reasoning', extractReasoningEntries(relayMessages)]]);
  },
  handleCall(tool: string, args: unknown, _caller: AgentInfo): unknown {
    if (tool === 'share_reasoning') {
      if (!isRecord(args) || typeof args.message !== 'string') {
        return { error: 'share_reasoning requires a message string' };
      }
      const scope = typeof args.scope === 'string' ? args.scope : 'all';
      const stage = typeof args.stage === 'string' ? args.stage : undefined;
      return {
        relay: formatReasoningMessage(args.message, scope, stage),
      };
    }
    return { error: `Unknown tool: ${tool}` };
  },
};

registerPluginRelayTypes(ReasoningPlugin);
