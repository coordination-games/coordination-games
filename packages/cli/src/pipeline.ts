/**
 * Client-side pipeline runner.
 *
 * Runs the plugin pipeline locally over relay messages received from
 * the server. The pipeline is personal — each agent's installed plugins
 * determine what they see.
 *
 * Usage:
 *   1. Fetch raw state + relay messages from server
 *   2. Run pipeline over relay messages
 *   3. Merge the pipeline's envelope extensions into the agent response
 */

import type { ToolPlugin } from '@coordination-games/engine';
import { PluginLoader, type PluginPipeline } from '@coordination-games/engine';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';

// Client-side plugins only. Trust projection is deliberately NOT here: it is a
// server-side projection (GameRoomDO.applyTrustProjector) that every player and
// spectator reads from their state payload — agents *consume* trust, they don't
// recompute it. Running it client-side too was duplicate work over a relay
// *delta* (the pipeline only sees new messages since the cursor), so the client
// copy was both redundant and evidence-degraded. The canonical computation lives
// server-side; clients read results. See wiki/architecture/plugin-pipeline.md and
// docs/plans/trust-attestations.md ("server-side canonical, client-side consumption").
const DEFAULT_PLUGINS: ToolPlugin[] = [BasicChatPlugin];

let registeredPlugins: ToolPlugin[] = [...DEFAULT_PLUGINS];
let loader: PluginLoader | null = null;
let pipeline: PluginPipeline | null = null;

/**
 * Per-agent client-side plugin ablation knob. Reads the COGA_DISABLE_PLUGINS
 * denylist (comma-separated plugin ids) from the environment so the harness — or
 * a human running `coga serve` — can disable a client-side plugin for a run and
 * measure the behavioral delta. Server-side projections (trust) are gated
 * separately on the server; see GameRoomDO.applyTrustProjector.
 */
function disabledPluginIdsFromEnv(): Set<string> {
  const raw = process.env.COGA_DISABLE_PLUGINS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function initPipeline(additionalPlugins: ToolPlugin[] = []): void {
  loader = new PluginLoader();
  const disabled = disabledPluginIdsFromEnv();
  registeredPlugins = [...DEFAULT_PLUGINS, ...additionalPlugins].filter((p) => !disabled.has(p.id));

  for (const plugin of registeredPlugins) {
    loader.register(plugin);
  }

  pipeline = loader.buildPipeline(registeredPlugins.map((p) => p.id));
}

export function runPipeline(input: {
  readonly relayMessages: unknown[];
  readonly gameState?: unknown;
  readonly gameMeta?: unknown;
}): Map<string, unknown> {
  if (!pipeline) initPipeline();
  if (!pipeline) return new Map<string, unknown>();
  const initial = new Map<string, unknown>([['relay-messages', input.relayMessages]]);
  if (input.gameState !== undefined) initial.set('game-state', input.gameState);
  if (input.gameMeta !== undefined) initial.set('game-meta', input.gameMeta);
  return pipeline.execute(initial);
}

/**
 * Project pipeline output into an agent-envelope-shaped object using each
 * plugin's `agentEnvelopeKeys` declaration. Capabilities without a declared
 * envelope key stay internal to the pipeline (not exposed to agents).
 */
export function buildEnvelopeExtensions(
  pipelineOutput: Map<string, unknown>,
): Record<string, unknown> {
  const ext: Record<string, unknown> = {};
  for (const plugin of registeredPlugins) {
    if (!plugin.agentEnvelopeKeys) continue;
    for (const [capability, envelopeKey] of Object.entries(plugin.agentEnvelopeKeys)) {
      const value = pipelineOutput.get(capability);
      if (value !== undefined) ext[envelopeKey] = value;
    }
  }
  return ext;
}

export function processState(serverResponse: {
  gameState?: unknown;
  relayMessages?: unknown[];
  [key: string]: unknown;
}): {
  gameState: unknown;
  envelopeExtensions: Record<string, unknown>;
  pipelineOutput: Map<string, unknown>;
  raw: unknown;
} {
  const relayMessages = serverResponse.relayMessages ?? [];
  const gameState = serverResponse.gameState ?? serverResponse;
  const pipelineOutput = runPipeline({
    relayMessages,
    gameState,
    gameMeta: serverResponse.meta,
  });

  return {
    gameState,
    envelopeExtensions: buildEnvelopeExtensions(pipelineOutput),
    pipelineOutput,
    raw: serverResponse,
  };
}

export { loader, pipeline };
