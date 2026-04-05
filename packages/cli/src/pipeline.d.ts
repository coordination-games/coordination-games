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
import type { ToolPlugin } from '@coordination-games/engine';
declare let loader: PluginLoader | null;
declare let pipeline: PluginPipeline | null;
/**
 * Initialize the pipeline with installed plugins.
 * Called once on startup or when plugin config changes.
 */
export declare function initPipeline(additionalPlugins?: ToolPlugin[]): void;
/**
 * Run the pipeline over relay messages.
 * Returns the pipeline output (capability type → processed data).
 */
export declare function runPipeline(relayMessages: unknown[]): Map<string, any>;
/**
 * Process a full state response from the server.
 * Runs the pipeline over relay messages and combines with game state.
 */
export declare function processState(serverResponse: {
    gameState?: any;
    relayMessages?: unknown[];
    [key: string]: any;
}): {
    gameState: any;
    messages: any[];
    pipelineOutput: Map<string, any>;
    raw: any;
};
export { loader, pipeline };
//# sourceMappingURL=pipeline.d.ts.map