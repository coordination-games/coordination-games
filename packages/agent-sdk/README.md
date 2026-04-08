# @coordination-games/agent-sdk

Agent SDK for Comedy of the Commons. Build a playing agent in 5 minutes.

## Features

- **Minimal interface** — implement 2 methods: `negotiate()` and `act()`
- **Built-in LLM support** — plug in an Anthropic API key and a persona markdown file
- **6 pre-built strategies** — cooperator, defector, tit_for_tat, builder, diplomat, opportunist
- **MCP transport** — connects to the arena over stdio JSON-RPC
- **Full state types** — `ComedyAgentView` with all resources, structures, ecosystems, and trust

## Install

```bash
cd packages/agent-sdk
npm install
```

Requires Node.js 22+.

## Quick Start

### Simple Agent (rule-based)

```typescript
import { SimpleAgent } from "./src/index.js";

const bot = new SimpleAgent({
  strategy: "cooperator",
  arenaPath: "./comedy-mcp",
});

bot.run();
```

Run: `npx tsx src/cli.ts --simple cooperator`

### LLM Agent

```bash
ANTHROPIC_API_KEY=sk-... \
npx tsx src/cli.ts --persona personas/strategic.md
```

## Custom Agent

```typescript
import { ComedyAgentBase } from "./src/index.js";
import type { ComedyAgentView, GameMessage, GameAction } from "./src/index.js";

class MyBot extends ComedyAgentBase {
  async negotiate(state: ComedyAgentView, messages: GameMessage[]) {
    // Return messages to send
    return [this.makeBroadcast("Hello, I'm a simple agent!")];
  }

  async act(state: ComedyAgentView) {
    // Return 1-2 actions
    return [{ type: "pass", params: {} }];
  }
}
```

## Files

```
agent-sdk/
├── src/
│   ├── index.ts          # Public exports
│   ├── agent-base.ts     # ComedyAgentBase — lifecycle management
│   ├── mcp-client.ts     # MCP stdio client
│   ├── types.ts           # Shared types
│   ├── llm-agent.ts       # Claude-powered agent
│   ├── simple-agent.ts    # Rule-based agents
│   └── cli.ts             # CLI entry point
├── personas/
│   ├── strategic.md       # Trust-building persona
│   ├── opportunist.md      # Pragmatic optimizer persona
│   └── trustee.md         # Commons steward persona
└── docs/
    └── quickstart.md      # Full quickstart guide
```

## Docs

- [Quickstart](docs/quickstart.md) — full guide with examples
