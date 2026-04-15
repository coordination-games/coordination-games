import type { ToolPlugin, AgentInfo } from '@coordination-games/engine';

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

export interface RationaleEntry {
  from: string;
  body: string;
  turn: number;
  scope: 'team' | 'all' | string;
  stage?: string;
  tags: Record<string, any>;
}

export function formatRationaleMessage(message: string, scope = 'all', stage?: string) {
  return {
    type: 'rationale',
    data: {
      body: message,
      ...(stage ? { stage } : {}),
    },
    scope,
    pluginId: 'rationale',
  };
}

export function extractRationales(relayMessages: RelayMessage[]): RationaleEntry[] {
  return relayMessages
    .filter((msg) => msg.type === 'rationale')
    .map((msg) => {
      const data = msg.data as { body?: string; stage?: string; tags?: Record<string, any> };
      return {
        from: msg.sender,
        body: data.body ?? '',
        turn: msg.turn,
        scope: msg.scope,
        stage: data.stage,
        tags: {
          ...data.tags,
          source: msg.pluginId,
          sender: msg.sender,
          timestamp: msg.timestamp,
        },
      } satisfies RationaleEntry;
    });
}

export const RationalePlugin: ToolPlugin = {
  id: 'rationale',
  version: '0.1.0',
  modes: [{ name: 'rationale', consumes: [], provides: ['rationale'] }],
  purity: 'pure',
  tools: [
    {
      name: 'share_rationale',
      description:
        'Publish an explicit authored rationale entry to the relay. Use this for observable strategy notes or justification, not hidden chain-of-thought.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The rationale or strategy note to publish.' },
          scope: { type: 'string', description: 'Who receives it: "team", "all", or a specific agentId for a DM-like rationale.' },
          stage: { type: 'string', description: 'Optional phase label such as planning, negotiation, action, or reflection.' },
        },
        required: ['message'],
      },
      mcpExpose: true,
    },
  ],
  handleData(_mode: string, inputs: Map<string, any>): Map<string, any> {
    const relayMessages: RelayMessage[] = inputs.get('relay-messages') ?? [];
    return new Map([['rationale', extractRationales(relayMessages)]]);
  },
  handleCall(tool: string, args: unknown, _caller: AgentInfo): unknown {
    if (tool === 'share_rationale') {
      const { message, scope, stage } = args as { message: string; scope?: string; stage?: string };
      return {
        relay: formatRationaleMessage(message, scope || 'all', stage),
      };
    }
    return { error: `Unknown tool: ${tool}` };
  },
};
