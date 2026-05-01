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
import { TrustProjectorTragedyPlugin } from '@coordination-games/plugin-trust-projector-tragedy';

const DEFAULT_PLUGINS: ToolPlugin[] = [BasicChatPlugin, TrustProjectorTragedyPlugin];

let registeredPlugins: ToolPlugin[] = [...DEFAULT_PLUGINS];
let loader: PluginLoader | null = null;
let pipeline: PluginPipeline | null = null;

export function initPipeline(additionalPlugins: ToolPlugin[] = []): void {
  loader = new PluginLoader();
  registeredPlugins = [...DEFAULT_PLUGINS, ...additionalPlugins];

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
