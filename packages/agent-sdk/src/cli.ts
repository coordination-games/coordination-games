#!/usr/bin/env node
/**
 * comedy-agent CLI — Run a Comedy of the Commons agent.
 *
 * Usage:
 *   npx tsx src/cli.ts --simple cooperator
 *   npx tsx src/cli.ts --persona ./personas/strategic.md
 */

import { parseAgentArgs } from "./mcp-client.js";
import { LLMAgent, AnthropicProvider, MinimaxProvider } from "./index.js";
import { SimpleAgent } from "./simple-agent.js";
import type { Strategy } from "./simple-agent.js";

async function main() {
  const args = parseAgentArgs(process.argv.slice(2));

  if (args.simple) {
    const strategies: Strategy[] = ["cooperator", "defector", "tit_for_tat", "builder", "diplomat", "opportunist"];
    if (!strategies.includes(args.simple as Strategy)) {
      console.error(`Unknown strategy: ${args.simple}`);
      console.error(`Available: ${strategies.join(", ")}`);
      process.exit(1);
    }

    const agent = new SimpleAgent({
      strategy: args.simple as Strategy,
      arenaPath: args.arenaPath,
    });

    agent.run().catch((err) => {
      console.error("[CLI] Agent error:", err);
      process.exit(1);
    });
    return;
  }

  if (args.personaPath) {
    const minimaxKey = process.env.MINIMAX_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    let provider;
    if (minimaxKey) {
      provider = new MinimaxProvider(minimaxKey);
      console.log("[CLI] Using Minimax provider");
    } else if (anthropicKey) {
      provider = new AnthropicProvider(anthropicKey);
      console.log("[CLI] Using Anthropic provider");
    } else {
      console.error("MINIMAX_API_KEY or ANTHROPIC_API_KEY environment variable is required for LLM agents.");
      process.exit(1);
    }

    const agent = new LLMAgent({
      provider,
      personaPath: args.personaPath,
      arenaPath: args.arenaPath,
    });

    agent.run().catch((err) => {
      console.error("[CLI] Agent error:", err);
      process.exit(1);
    });
    return;
  }

  console.error(`
comedy-agent CLI

Usage:
  npx tsx src/cli.ts --simple <strategy>   Run a rule-based agent
  npx tsx src/cli.ts --persona <path>       Run an LLM-powered agent

Examples:
  npx tsx src/cli.ts --simple cooperator
  npx tsx src/cli.ts --simple tit_for_tat --arena ./comedy-mcp
  MINIMAX_API_KEY=... npx tsx src/cli.ts --persona personas/strategic.md

Strategies (--simple):
  cooperator    Always cooperates, trades freely
  defector      Exploits others, breaks promises
  tit_for_tat   Cooperates first, mirrors opponent
  builder       Focuses on structures
  diplomat      Maximizes trust and influence
  opportunist   Cooperates when ahead, defects when behind

Environment:
  MINIMAX_API_KEY   Minimax (OpenAI-compatible) — preferred
  ANTHROPIC_API_KEY  Anthropic Claude — fallback
`);
  process.exit(1);
}

main();
