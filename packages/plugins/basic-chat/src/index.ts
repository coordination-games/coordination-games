/**
 * Basic Chat Plugin — Tier 2 (Relayed) chat for Coordination Games.
 *
 * Client-side plugin that:
 * - Formats outgoing messages as relay data (type: "messaging")
 * - In the pipeline, acts as a producer: reads relay messages of type
 *   "messaging" and provides them as the "messaging" capability
 * - Scope is determined by game phase (lobby=all, gameplay=team)
 *
 * This code runs on the agent's machine (CLI), NOT on the server.
 * The server just relays the typed data by scope.
 */

import type { ToolPlugin, Message } from '@lobster/platform';

/** A relay message as received from the server. */
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

/**
 * Format an outgoing chat message as relay data.
 * The CLI sends this to the server's relay endpoint.
 */
export function formatChatMessage(
  body: string,
  phase: string,
): { type: string; data: { body: string }; scope: 'team' | 'all'; pluginId: string } {
  const scope: 'team' | 'all' =
    phase === 'in_progress' || phase === 'pre_game' ? 'team' : 'all';

  return {
    type: 'messaging',
    data: { body },
    scope,
    pluginId: 'basic-chat',
  };
}

/**
 * Extract Message objects from raw relay messages.
 * This is the pipeline producer — it reads relay data of type "messaging"
 * and converts it into the canonical Message format for downstream plugins.
 */
export function extractMessages(relayMessages: RelayMessage[]): Message[] {
  return relayMessages
    .filter((msg) => msg.type === 'messaging')
    .map((msg) => {
      const data = msg.data as { body?: string; tags?: Record<string, any> };
      return {
        from: parseInt(msg.sender, 10) || 0,
        body: data.body ?? '',
        turn: msg.turn,
        scope: (msg.scope === 'team' || msg.scope === 'all') ? msg.scope : 'all',
        tags: {
          ...data.tags,
          source: msg.pluginId,
          sender: msg.sender,
          timestamp: msg.timestamp,
        },
      } satisfies Message;
    });
}

/**
 * The BasicChatPlugin for the client-side pipeline.
 *
 * As a pipeline producer, it takes raw relay messages (passed as initial
 * pipeline data under the key "relay-messages") and produces the
 * "messaging" capability for downstream plugins to consume.
 */
export const BasicChatPlugin: ToolPlugin = {
  id: 'basic-chat',
  version: '0.2.0',
  modes: [{ name: 'messaging', consumes: [], provides: ['messaging'] }],
  purity: 'pure',

  handleData(mode: string, inputs: Map<string, any>): Map<string, any> {
    // Read raw relay messages from pipeline input
    const relayMessages: RelayMessage[] = inputs.get('relay-messages') ?? [];
    const messages = extractMessages(relayMessages);
    return new Map([['messaging', messages]]);
  },
};
