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
 *   3. Combine game state + pipeline output for the agent
 */

import type { ToolPlugin } from '@coordination-games/engine';
import { PluginLoader, type PluginPipeline } from '@coordination-games/engine';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';

// Default plugins — always available
const DEFAULT_PLUGINS: ToolPlugin[] = [BasicChatPlugin];

let loader: PluginLoader | null = null;
let pipeline: PluginPipeline | null = null;

/**
 * Initialize the pipeline with installed plugins.
 * Called once on startup or when plugin config changes.
 */
export function initPipeline(additionalPlugins: ToolPlugin[] = []): void {
  loader = new PluginLoader();
  const allPlugins = [...DEFAULT_PLUGINS, ...additionalPlugins];

  for (const plugin of allPlugins) {
    loader.register(plugin);
  }

  const pluginIds = allPlugins.map((p) => p.id);
  pipeline = loader.buildPipeline(pluginIds);
}

/**
 * Run the pipeline over relay messages.
 * Returns the pipeline output (capability type → processed data).
 */
// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
export function runPipeline(relayMessages: unknown[]): Map<string, any> {
  if (!pipeline) {
    initPipeline();
  }

  // @ts-expect-error TS2322: Type 'Map<string, any> | undefined' is not assignable to type 'Map<string, any>' — TODO(2.3-followup)
  return pipeline?.execute(new Map([['relay-messages', relayMessages]]));
}

/**
 * Process a full state response from the server.
 * Runs the pipeline over relay messages and combines with game state.
 */
export function processState(serverResponse: {
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  gameState?: any;
  relayMessages?: unknown[];
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  [key: string]: any;
}): {
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  gameState: any;
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  messages: any[];
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  pipelineOutput: Map<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  raw: any;
} {
  const relayMessages = serverResponse.relayMessages ?? [];
  const pipelineOutput = runPipeline(relayMessages);

  return {
    gameState: serverResponse.gameState ?? serverResponse,
    messages: pipelineOutput.get('messaging') ?? [],
    pipelineOutput,
    raw: serverResponse,
  };
}

export { loader, pipeline };
