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

import { PluginLoader, PluginPipeline } from '@coordination-games/engine';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';
import type { ToolPlugin } from '@coordination-games/engine';

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
export function runPipeline(
  relayMessages: unknown[],
): Map<string, any> {
  if (!pipeline) {
    initPipeline();
  }

  return pipeline!.execute(
    new Map([['relay-messages', relayMessages]]),
  );
}

/**
 * Process a full state response from the server.
 * Runs the pipeline over relay messages and combines with game state.
 */
export function processState(serverResponse: {
  gameState?: any;
  relayMessages?: unknown[];
  [key: string]: any;
}): {
  gameState: any;
  messages: any[];
  rationales: any[];
  pipelineOutput: Map<string, any>;
  raw: any;
} {
  const relayMessages = serverResponse.relayMessages ?? [];
  const pipelineOutput = runPipeline(relayMessages);

  return {
    gameState: serverResponse.gameState ?? serverResponse,
    messages: pipelineOutput.get('messaging') ?? [],
    rationales: pipelineOutput.get('rationale') ?? [],
    pipelineOutput,
    raw: serverResponse,
  };
}

export { loader, pipeline };
