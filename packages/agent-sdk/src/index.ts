/**
 * Agent SDK — Comedy of the Commons
 *
 * @example
 * // A minimal agent in 10 lines
 * import { ComedyAgentBase } from "@coordination-games/agent-sdk";
 *
 * class MyBot extends ComedyAgentBase {
 *   async negotiate(state, messages) {
 *     return [this.makeBroadcast("Hello, I'm a simple agent!")];
 *   }
 *   async act(state) {
 *     return [{ type: "pass", params: {} }];
 *   }
 * }
 *
 * const bot = new MyBot({ arenaPath: "./comedy-mcp" });
 * bot.run().catch(console.error);
 */

export { ComedyAgentBase } from "./agent-base.js";
export type { AgentOptions } from "./agent-base.js";

export { ComedyMcpClient } from "./mcp-client.js";
export type { M2pClientOptions, CliOptions } from "./mcp-client.js";
export { parseAgentArgs } from "./mcp-client.js";

export * from "./types.js";

export { LLMAgent } from "./llm-agent.js";
export { SimpleAgent } from "./simple-agent.js";

export {
  LLMProvider,
  LLMProviderOptions,
  AnthropicProvider,
  MinimaxProvider,
  MinimaxProviderOptions,
} from "./providers.js";
