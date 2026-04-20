/**
 * Basic Chat Plugin — Tier 2 (Relayed) chat for Coordination Games.
 *
 * Two surfaces share one plugin id:
 *   1. `BasicChatPlugin` (ToolPlugin)   — runs on the agent's machine (CLI):
 *      formats outgoing messages, runs the pipeline producer that hands
 *      `messaging` to downstream plugins, exposes the `chat` MCP tool.
 *   2. `BasicChatServerPlugin` (ServerPlugin) — runs in the workers-server
 *      `ServerPluginRuntime`. It claims the chat relay `type` (currently
 *      `'messaging'`, exported as `CHAT_RELAY_TYPE`) so DOs can dispatch by
 *      relay type without hard-coding the string. handleCall accepts
 *      `{ name: 'chat', args }` for parity with the CLI tool.
 *
 * Consumers (LobbyDO, GameRoomDO, CtL plugin spectator filter, web
 * components) MUST import `CHAT_RELAY_TYPE` from this module rather than
 * spelling the literal — that's the contract Phase 5.1 enforces. If this
 * plugin is ever removed from the registered set, the relay type goes
 * unregistered and chat envelopes are rejected at publish time.
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
 * The relay envelope `type` string this plugin owns. Exported so consumers
 * can dispatch by type without spelling the literal. The value is wire
 * format and changing it is a breaking change — that's why it lives in the
 * plugin module rather than the engine.
 */
export const CHAT_RELAY_TYPE = 'messaging';

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
    type: CHAT_RELAY_TYPE,
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
    .filter((msg) => msg.type === CHAT_RELAY_TYPE)
    .map((msg) => {
      const data = msg.data as { body?: string; tags?: Record<string, unknown> };
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
 * Zod schema for the body of a chat (`CHAT_RELAY_TYPE`) relay envelope.
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
  relayTypes: { [CHAT_RELAY_TYPE]: ChatMessageSchema },

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

  handleData(_mode: string, inputs: Map<string, unknown>): Map<string, unknown> {
    // Read raw relay envelopes from pipeline input
    const relayMessages = (inputs.get('relay-messages') ?? []) as RelayEnvelope[];
    const messages = extractMessages(relayMessages);
    return new Map<string, unknown>([['messaging', messages]]);
  },

  handleCall(tool: string, args: unknown, _caller: AgentInfo): unknown {
    if (tool === 'chat') {
      const { message, scope } = args as { message: string; scope: string };
      // Return relay data — the server sends it through the typed relay as-is.
      // Agent chooses scope: 'team', 'all', or a specific agentId for DM.
      return {
        relay: {
          type: CHAT_RELAY_TYPE,
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
 * tests — gets the chat relay schema in the registry without an extra
 * bootstrap step. The registry's collision check guards against double
 * registration if multiple modules import this file.
 */
registerPluginRelayTypes(BasicChatPlugin);

// ---------------------------------------------------------------------------
// Server-side surface (Phase 5.1) — see ./server.js
// ---------------------------------------------------------------------------

export { BasicChatServerPlugin, type BasicChatServerPluginShape } from './server.js';
