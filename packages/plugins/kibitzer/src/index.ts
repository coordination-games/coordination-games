/**
 * Kibitzer Plugin — spectator-only commentary plugin (Phase 5.4 acceptance).
 *
 * Why this exists: Phase 5.4 of the system-cleanup plan is the keystone
 * acceptance test — implement a brand-new plugin end-to-end, both server-
 * side (`ServerPlugin`) and frontend (`WebToolPlugin`), and count how many
 * files we have to edit OUTSIDE this package. Target: ≤ 2. The kibitzer
 * was picked over `voting` / `trust-graph` because it's deliberately
 * non-chat-shaped:
 *
 *   - It both READS the relay (chat envelopes flowing past) AND WRITES
 *     to it (its own `kibitzer:comment` envelopes). That exercises both
 *     directions of the `RelayClient` capability.
 *   - It's spectator-only — its UI lives in the `game:overlay` slot and
 *     it has no MCP tool, so it doesn't piggy-back on the chat pipeline.
 *   - It owns its own envelope `type` (`kibitzer:comment`) and registers
 *     a Zod schema for it via `relayTypes` (Phase 4.2 contract).
 *
 * Subpath exports (see `package.json#exports`):
 *   `@coordination-games/plugin-kibitzer`         — this module: relay
 *                                                    type + schema +
 *                                                    self-registration.
 *   `@coordination-games/plugin-kibitzer/server`  — `createKibitzerServerPlugin()`
 *                                                    builder for `ServerPlugin`.
 *   `@coordination-games/plugin-kibitzer/web`     — `KibitzerWebPlugin`
 *                                                    `WebToolPlugin` for the
 *                                                    React shell.
 *
 * Subpath split keeps non-React consumers (workers-server, future CLI
 * surfaces) from pulling in `react` types — same shape basic-chat would
 * have used if its web piece had stayed in the plugin package.
 */

import { registerPluginRelayTypes } from '@coordination-games/engine';
import { z } from 'zod';

/**
 * The relay envelope `type` string this plugin owns. Exported so consumers
 * dispatch by type without spelling the literal.
 */
export const KIBITZER_COMMENT_TYPE = 'kibitzer:comment';

/** Plugin id — single source of truth for both server and web halves. */
export const KIBITZER_PLUGIN_ID = 'kibitzer';

/**
 * Zod schema for the body of a `kibitzer:comment` relay envelope.
 *
 *  - `text` is the commentary line (required, max 280 chars to match a
 *    sane upper bound — kibitzer is colour, not an essay).
 *  - `seq` is a monotonic counter the server bumps for each emitted
 *    comment. The web slot uses it to dedupe / order without relying on
 *    `index` (which is engine-assigned and not exposed to slot props).
 */
export const KibitzerCommentSchema = z
  .object({
    text: z.string().min(1).max(280),
    seq: z.number().int().min(0),
  })
  .strict();

export type KibitzerCommentBody = z.infer<typeof KibitzerCommentSchema>;

/**
 * The pool of templated commentary lines the server cycles through. Static
 * + cheap on purpose — Phase 5.4 is an architecture test, not an LLM-driven
 * commentary feature. The kibitzer's job is to prove the wiring; richer
 * commentary is a follow-up.
 *
 * `{n}` placeholders are filled by `renderCommentary` from the chat-message
 * count it observed. Templates without `{n}` render as-is.
 */
export const COMMENTARY_TEMPLATES: readonly string[] = [
  'Did anyone see that?!',
  'The crowd goes wild!',
  '{n} messages and counting — this game is heating up.',
  "Now THAT'S coordination.",
  'A bold move from the home team.',
  "Don't blink — you'll miss it.",
  'The kibitzer approves.',
  'Tactics on full display.',
  'A turning point if I ever saw one.',
  'And just like that — the tide shifts.',
] as const;

/**
 * Render a templated commentary line. Pure — exported so the server
 * plugin and any unit tests can share the rendering rule.
 *
 * @param seq    monotonic comment counter; selects the template via
 *               `seq % COMMENTARY_TEMPLATES.length`. Stable across DOs
 *               so a replay reproducing the same `seq` lands the same
 *               line — useful when we eventually replay-verify spectator
 *               payloads.
 * @param msgs   chat-message count observed when the comment was emitted;
 *               substituted for `{n}` in the template.
 */
export function renderCommentary(seq: number, msgs: number): string {
  const idx =
    ((seq % COMMENTARY_TEMPLATES.length) + COMMENTARY_TEMPLATES.length) %
    COMMENTARY_TEMPLATES.length;
  // biome-ignore lint/style/noNonNullAssertion: idx is bounded by template length
  const template = COMMENTARY_TEMPLATES[idx]!;
  return template.replace('{n}', String(msgs));
}

/**
 * Self-register the plugin's relay schema at module import time.
 *
 * Same pattern as basic-chat: any consumer that imports kibitzer (server
 * or web) gets the schema in the registry without an explicit bootstrap.
 * `DOStorageRelayClient.publish` rejects unknown types — so this side
 * effect is the contract that lets a kibitzer comment reach the wire.
 */
registerPluginRelayTypes({
  id: KIBITZER_PLUGIN_ID,
  relayTypes: { [KIBITZER_COMMENT_TYPE]: KibitzerCommentSchema },
});

export type { KibitzerServerPluginShape } from './server.js';
// Re-export the server builder so callers can do `import { createKibitzerServerPlugin } from
// '@coordination-games/plugin-kibitzer'` if they prefer the umbrella import. Web is NOT
// re-exported here — pulling React into the umbrella forces every server consumer to satisfy
// the React peer dep.
export { createKibitzerServerPlugin } from './server.js';
