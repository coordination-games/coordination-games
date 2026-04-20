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

import {
  type AgentInfo,
  type Message,
  type RelayEnvelope,
  registerPluginRelayTypes,
  type ToolPlugin,
} from '@coordination-games/engine';
import { z } from 'zod';

/**
 * A relay message as received from the server. Re-exported from the engine
 * type so the basic-chat plugin and the rest of the codebase share the same
 * canonical envelope shape.
 */
export type { RelayEnvelope as RelayMessage } from '@coordination-games/engine';

/**
 * Format an outgoing chat message as relay data.
 * The CLI sends this to the server's relay endpoint.
 */
export function formatChatMessage(
  body: string,
  phase: string,
): { type: string; data: { body: string }; scope: 'team' | 'all'; pluginId: string } {
  const scope: 'team' | 'all' = phase === 'in_progress' || phase === 'pre_game' ? 'team' : 'all';

  return {
    type: 'messaging',
    data: { body },
    scope,
    pluginId: 'basic-chat',
  };
}

/**
 * Extract Message objects from raw relay envelopes.
 * This is the pipeline producer — it reads relay data of type "messaging"
 * and converts it into the canonical Message format for downstream plugins.
 */
export function extractMessages(relayMessages: RelayEnvelope[]): Message[] {
  return relayMessages
    .filter((msg) => msg.type === 'messaging')
    .map((msg) => {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
      const data = msg.data as { body?: string; tags?: Record<string, any> };
      // Map the discriminated scope to the simpler chat scope ('team' | 'all').
      // DMs surface as 'all' for the pipeline-consumer view (recipient still
      // sees the message, scope distinction lives in the envelope).
      const chatScope: 'team' | 'all' = msg.scope.kind === 'team' ? 'team' : 'all';
      return {
        from: msg.sender,
        body: data.body ?? '',
        turn: msg.turn,
        scope: chatScope,
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
 * Zod schema for the body of a `type: 'messaging'` relay envelope.
 *
 * The shape is intentionally LOOSE so existing chat traffic (CLI, bots,
 * test fixtures, downstream plugins that enrich `tags`) continues to pass:
 *  - `body` is required (the message text). Empty string allowed because
 *    older flows have leaned on `extractMessages` defaulting an absent body
 *    to '' — schema accepts the body explicitly so the legacy `data: {}`
 *    case still fails fast and gets surfaced.
 *  - `tags` is an open record so trust-scoring / spam plugins can enrich
 *    payloads without a schema bump.
 *  - `passthrough()` accepts any other top-level keys present on the wire
 *    (defence in depth for any older sender we missed).
 */
export const ChatMessageSchema = z
  .object({
    body: z.string(),
    // Open tag bag — trust/spam/etc plugins enrich freely. `unknown` keeps
    // downstream consumers honest at narrow sites without schema versioning.
    tags: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * The BasicChatPlugin for the client-side pipeline.
 *
 * As a pipeline producer, it takes raw relay messages (passed as initial
 * pipeline data under the key "relay-messages") and produces the
 * "messaging" capability for downstream plugins to consume.
 */
export const BasicChatPlugin: ToolPlugin = {
  id: 'basic-chat',
  version: '0.3.0',
  modes: [{ name: 'messaging', consumes: [], provides: ['messaging'] }],
  purity: 'pure',
  relayTypes: { messaging: ChatMessageSchema },

  /** MCP tool: send a chat message */
  tools: [
    {
      name: 'chat',
      description:
        'Send a message. In the lobby, visible to everyone. During class selection and in-game, visible to your team only.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Your message' },
          scope: {
            type: 'string',
            description:
              'Who receives it: "team" (teammates only), "all" (everyone in game/lobby), or a player display name for a DM (e.g. "Clawdia")',
          },
        },
        required: ['message', 'scope'],
      },
      mcpExpose: true,
    },
  ],

  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
  handleData(_mode: string, inputs: Map<string, any>): Map<string, any> {
    // Read raw relay envelopes from pipeline input
    const relayMessages: RelayEnvelope[] = inputs.get('relay-messages') ?? [];
    const messages = extractMessages(relayMessages);
    return new Map([['messaging', messages]]);
  },

  handleCall(tool: string, args: unknown, _caller: AgentInfo): unknown {
    if (tool === 'chat') {
      const { message, scope } = args as { message: string; scope: string };
      // Return relay data — the server sends it through the typed relay as-is.
      // Agent chooses scope: 'team', 'all', or a specific agentId for DM.
      return {
        relay: {
          type: 'messaging',
          data: { body: message },
          scope: scope || 'team',
          pluginId: 'basic-chat',
        },
      };
    }
    return { error: `Unknown tool: ${tool}` };
  },
};

/**
 * Self-register the plugin's relay schemas at module import time.
 *
 * Why side-effect on import: the workers-server has no central plugin loader
 * for `ToolPlugin`s today (games register via `registerGame()` side effects;
 * tool plugins are imported by callers that need them). Registering here
 * means any consumer that imports basic-chat — CLI, workers-server DOs,
 * tests — gets the `'messaging'` schema in the registry without an extra
 * bootstrap step. The registry's collision check guards against double
 * registration if multiple modules import this file.
 */
registerPluginRelayTypes(BasicChatPlugin);
