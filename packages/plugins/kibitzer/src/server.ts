/**
 * KibitzerServerPlugin — server-side `ServerPlugin` shape for kibitzer.
 *
 * What it does at runtime (per-DO instance, registered in
 * `GameRoomDO.getPluginRuntime()`):
 *
 *   - On `init`, captures the `relay` capability handed to it by the
 *     runtime. This is THE gate that proves capability injection works
 *     end-to-end for a brand-new plugin (Phase 4.3 + Phase 5.4).
 *   - On `handleRelay` for chat envelopes (`messaging`), counts them and
 *     emits a `kibitzer:comment` envelope every Nth message. The emitted
 *     envelope is RETURNED from `handleRelay` rather than published
 *     directly — `ServerPluginRuntime.handleRelay` doesn't currently
 *     drain the returned list back into the relay (a known gap; see the
 *     plugin's tests for the explicit expectation), so the kibitzer also
 *     publishes via `caps.relay.publish` for the live path. Returning the
 *     envelope keeps a clean contract for when the runtime starts
 *     fanning return values back through.
 *   - On `handleCall('comment', { text? })`, forces an immediate emission
 *     (testing surface; admin/spectator viewers only).
 *
 * `requires: ['relay']` — exercises the capability-subset feature: the
 * plugin can reach `caps.relay` but NOT `caps.chain` / `caps.alarms` /
 * `caps.d1` / `caps.storage`. Attempting any of those at the type level
 * fails to compile, which is exactly the safety this contract is meant
 * to provide.
 *
 * Structurally typed (no import from workers-server) so this package has
 * a single `engine + zod` dependency footprint and consumers don't pull
 * in workers-server's Cloudflare types just to register the plugin.
 */

import type { RelayEnvelope, RelayScope } from '@coordination-games/engine';
import { KIBITZER_COMMENT_TYPE, KIBITZER_PLUGIN_ID, renderCommentary } from './index.js';

/**
 * Default — emit a comment after every 3 chat messages. Picked low so a
 * smoke test sees commentary without scripting hundreds of chat lines.
 * Override via `createKibitzerServerPlugin({ commentEvery })`.
 */
export const DEFAULT_COMMENT_EVERY = 3;

/**
 * Minimal RelayClient shape the plugin needs. Mirrors the
 * `RelayClient.publish` signature from `workers-server/src/plugins/capabilities.ts`
 * — kept local so this package stays workers-server-free.
 */
export interface KibitzerRelayCap {
  publish(env: {
    type: string;
    pluginId: string;
    sender: string;
    scope: RelayScope;
    turn: number | null;
    data: unknown;
  }): Promise<void>;
}

/**
 * Capability subset this plugin requests from the runtime. Mirrors
 * `Pick<Capabilities, 'relay'>` without depending on workers-server.
 */
export interface KibitzerCaps {
  relay: KibitzerRelayCap;
}

/**
 * GameContext passed to `init`. Mirrors the runtime's `GameContext`.
 */
export interface KibitzerGameContext {
  gameId: string;
}

/**
 * Server-side plugin shape. Mirrors `ServerPlugin<'relay'>` from
 * `workers-server/src/plugins/runtime.ts` — kept local so this package
 * stays workers-server-free.
 */
export interface KibitzerServerPluginShape {
  id: string;
  requires: readonly ['relay'];
  init(caps: KibitzerCaps, game: KibitzerGameContext): Promise<void>;
  handleRelay(env: RelayEnvelope): Promise<RelayEnvelope[] | undefined>;
  handleCall(name: string, args: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface KibitzerOptions {
  /**
   * Emit a comment after every Nth chat message. Defaults to
   * `DEFAULT_COMMENT_EVERY`. Set to `0` to disable auto-emit (manual
   * `handleCall('comment', …)` only).
   */
  commentEvery?: number;
}

/**
 * The chat relay type this plugin watches. Hard-coded as a literal here
 * to AVOID importing from `@coordination-games/plugin-chat` — the
 * acceptance test would otherwise prove "kibitzer is plug-and-play" by
 * silently coupling itself to chat. Kibitzer should react to any chat
 * plugin that publishes envelopes typed `messaging` (the wire format),
 * not to the specific basic-chat package. The integration boundary IS
 * the wire format.
 */
const CHAT_TYPE = 'messaging';

/**
 * Build the kibitzer ServerPlugin. The returned plugin is `register()`able
 * with a per-DO `ServerPluginRuntime` whose `caps.relay` is the DO's
 * `DOStorageRelayClient`.
 */
export function createKibitzerServerPlugin(opts: KibitzerOptions = {}): KibitzerServerPluginShape {
  const commentEvery = opts.commentEvery ?? DEFAULT_COMMENT_EVERY;
  let relay: KibitzerRelayCap | null = null;
  let game: KibitzerGameContext | null = null;
  let chatCount = 0;
  let seq = 0;

  async function emit(text: string, turn: number | null): Promise<RelayEnvelope> {
    if (!relay) throw new Error('kibitzer plugin not initialised (relay cap missing)');
    const partial = {
      type: KIBITZER_COMMENT_TYPE,
      pluginId: KIBITZER_PLUGIN_ID,
      // Spectators see commentary as if from a built-in narrator. Use a
      // sentinel sender — never a player id — so the UI can render it
      // distinctly without inspecting `pluginId`.
      sender: 'kibitzer',
      // Commentary is public by definition; team/DM scopes don't apply.
      scope: { kind: 'all' as const },
      turn,
      data: { text, seq } satisfies { text: string; seq: number },
    };
    seq += 1;
    await relay.publish(partial);
    // Synthesize what the published envelope would look like for the
    // return value — index/timestamp are runtime-assigned by the
    // RelayClient implementation, but callers (and the runtime fan-out)
    // generally only care about `type` / `data` / `pluginId` / `sender`.
    return {
      ...partial,
      index: -1,
      timestamp: Date.now(),
    } as RelayEnvelope;
  }

  return {
    id: KIBITZER_PLUGIN_ID,
    requires: ['relay'] as const,

    async init(caps, ctx) {
      relay = caps.relay;
      game = ctx;
      // No-op log for now; Phase 7 may wire structured logs through caps.
      void game;
    },

    async handleRelay(env) {
      // We only care about chat. Engine envelopes (settlement, etc.) and our
      // own `kibitzer:comment` echoes are ignored.
      if (env.type !== CHAT_TYPE) return undefined;
      chatCount += 1;
      if (commentEvery <= 0) return undefined;
      if (chatCount % commentEvery !== 0) return undefined;
      const text = renderCommentary(seq, chatCount);
      const emitted = await emit(text, env.turn);
      return [emitted];
    },

    async handleCall(name, args) {
      if (name === 'comment') {
        const a = (args ?? {}) as { text?: string; turn?: number | null };
        const text = (a.text ?? renderCommentary(seq, chatCount)).slice(0, 280);
        await emit(text, a.turn ?? null);
        return { ok: true, seq };
      }
      if (name === 'state') {
        // Diagnostic — useful for tests and future admin surfaces.
        return { chatCount, seq };
      }
      return { error: `Unknown kibitzer call: ${name}` };
    },

    async dispose() {
      relay = null;
      game = null;
      chatCount = 0;
      seq = 0;
    },
  };
}
