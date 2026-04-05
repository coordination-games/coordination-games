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
import { PluginLoader } from '@coordination-games/engine';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';
// Default plugins — always available
const DEFAULT_PLUGINS = [BasicChatPlugin];
let loader = null;
let pipeline = null;
/**
 * Initialize the pipeline with installed plugins.
 * Called once on startup or when plugin config changes.
 */
export function initPipeline(additionalPlugins = []) {
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
export function runPipeline(relayMessages) {
    if (!pipeline) {
        initPipeline();
    }
    return pipeline.execute(new Map([['relay-messages', relayMessages]]));
}
/**
 * Process a full state response from the server.
 * Runs the pipeline over relay messages and combines with game state.
 */
export function processState(serverResponse) {
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
//# sourceMappingURL=pipeline.js.map