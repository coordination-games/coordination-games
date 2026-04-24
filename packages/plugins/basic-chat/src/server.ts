/**
 * BasicChatServerPlugin — server-side `ServerPlugin` shape for chat.
 *
 * Phase 5.1 introduces this so the workers-server `ServerPluginRuntime`
 * (Phase 4.3) can dispatch chat tool calls + claim the `messaging` relay
 * type without any DO knowing the literal string. Today the plugin's job
 * is small:
 *
 *   - It reserves the relay `type` (`CHAT_RELAY_TYPE`) by being the only
 *     plugin that registers a schema for it (`relayTypes` on the
 *     `ToolPlugin` half does that side-effect at import time). If this
 *     plugin is removed from the registered set, `validateRelayBody`
 *     throws on chat envelopes — chat is dead, exactly as Phase 5.1's
 *     acceptance test demands.
 *   - `handleCall(name='chat', args)` formats a relay envelope payload
 *     identical to what the CLI-side `BasicChatPlugin.handleCall` returns,
 *     so a future plugin-runtime tool dispatch (Phase 5.2+) can route
 *     `chat({message,scope})` through `runtime.handleCall('basic-chat',
 *     'chat', args)` without a parallel format function.
 *
 * `requires: []` — this plugin needs no caps today. When publish-from-
 * inside-the-runtime lands, it will declare `['relay']`. We keep it
 * structurally typed (no import from workers-server) to avoid a circular
 * package dependency: workers-server imports basic-chat for its side
 * effects + this shape.
 */

import { CHAT_RELAY_TYPE } from './index.js';

/**
 * Minimal structural shape the workers-server `ServerPluginRuntime`
 * accepts. Mirrors `ServerPlugin<never>` from the runtime — kept local so
 * basic-chat doesn't depend on the workers-server package.
 */
export interface BasicChatServerPluginShape {
  id: string;
  requires: readonly never[];
  init(caps: object, game: { gameId: string }): Promise<void>;
  handleCall(name: string, args: unknown): Promise<unknown>;
}

interface ChatToolArgs {
  message: string;
  scope?: string;
}

export const BasicChatServerPlugin: BasicChatServerPluginShape = {
  id: 'basic-chat',
  requires: [] as const,
  async init(_caps, _game) {
    // Nothing to wire today. The relay-type schema is registered as a
    // side effect of importing the plugin module (`./index.ts` →
    // `registerPluginRelayTypes`). When publish-from-runtime lands this
    // hook will stash `_caps.relay` for handleCall.
  },
  async handleCall(name, args): Promise<unknown> {
    if (name !== 'chat') {
      return { error: `Unknown tool: ${name}` };
    }
    const { message, scope } = (args ?? {}) as ChatToolArgs;
    return {
      relay: {
        type: CHAT_RELAY_TYPE,
        data: { body: message },
        scope: scope || 'team',
        pluginId: 'basic-chat',
      },
    };
  },
};
