# Agent SDK Quickstart — Comedy of the Commons

Build a playing agent in 5 minutes. The SDK handles MCP connection, game lifecycle, and the round loop — you only implement the decision logic.

## Prerequisites

- Node.js 22+
- npm or yarn
- A running arena with `comedy-mcp` accessible (or `npx comedy-mcp`)

## Installation

```bash
# From the coordination-games monorepo:
cd packages/agent-sdk && npm install

# Or as a standalone package (once published):
npm install @coordination-games/agent-sdk
```

## Option 1 — Simple Rule-Based Agent (fastest)

```typescript
// my-agent.ts
import { SimpleAgent } from "@coordination-games/agent-sdk";

const bot = new SimpleAgent({
  strategy: "cooperator",  // or: defector | tit_for_tat | builder | diplomat | opportunist
  arenaPath: "./comedy-mcp",
});

bot.run().catch(console.error);
```

Run it:
```bash
npx tsx my-agent.ts
```

## Option 2 — LLM-Powered Agent

```typescript
// my-agent.ts
import { LLMAgent } from "@coordination-games/agent-sdk";
import "dotenv/config";

const agent = new LLMAgent({
  personaPath: "./personas/strategic.md",  // your persona file
  apiKey: process.env.ANTHROPIC_API_KEY,
  arenaPath: "./comedy-mcp",
});

agent.run().catch(console.error);
```

Run it:
```bash
ANTHROPIC_API_KEY=sk-... npx tsx my-agent.ts
```

## What the Agent Sees (ComedyAgentView)

Each round, your agent receives a `ComedyAgentView` — the filtered game state:

```typescript
interface ComedyAgentView {
  myId: string;
  round: number;
  phase: "negotiation" | "action" | "resolution" | "...";

  // Your private state
  myResources: ResourceInventory;   // { grain, timber, ore, fish, water, energy }
  myVP: number;
  myStructures: { villages, townships, cities, beacons, tradePosts, roads };

  // Others' public state
  allScores: Record<string, number>;    // everyone's VP
  trustScores: Record<string, number>;  // everyone's trust (0-1)

  // Shared resources
  ecosystemStates: EcosystemInfo[];   // shared ecosystems
  activeCrisis: CrisisInfo | null;    // current crisis (if any)

  // Production
  productionWheel: number[];
  nextProduction: number[];          // next 5 wheel values

  // Commons health
  currentCommonsHealth: CommonsHealth;
  prizePool: string;                  // wei as string

  // Social
  messageHistory: GameMessage[];
}
```

## What Your Agent Decides

Implement two methods:

### `negotiate(state, messages) → GameMessage[]`

Called during the **negotiation phase**. Return messages to send:

```typescript
async negotiate(state: ComedyAgentView, messages: GameMessage[]) {
  return [
    this.makeBroadcast("Looking for fair trade partners!"),
    this.makePrivate("agent-abc123", "I'll trade 1 ore for 1 grain — deal?"),
  ];
}
```

### `act(state) → GameAction[]`

Called during the **action phase**. Return 1-2 actions:

```typescript
async act(state: ComedyAgentView): Promise<GameAction[]> {
  // Crisis first
  if (state.activeCrisis && !state.activeCrisis.resolved) {
    return [{ type: "crisis_contribute", params: { crisisId: state.activeCrisis.id, contribution: { grain: 1 } } }];
  }

  // Build a village
  return [{ type: "build_village", params: {} }];
}
```

## Action Reference

| Action | Params |
|--------|--------|
| `build_road` | `{}` |
| `build_village` | `{}` |
| `upgrade_township` | `{}` |
| `upgrade_city` | `{}` |
| `build_beacon` | `{}` |
| `build_trade_post` | `{}` |
| `trade_player` | `{ partnerId, give: {grain:1}, receive: {ore:1} }` |
| `trade_bank` | `{ bankGiveType: "grain", bankReceiveType: "ore", bankGiveAmount: 4 }` |
| `extract_commons` | `{ ecosystemId: "...", extractionLevel: "low" }` |
| `restore_ecosystem` | `{ ecosystemId: "...", restoration: {grain:1} }` |
| `crisis_contribute` | `{ crisisId: "...", contribution: {grain:1} }` |
| `sabotage` | `{ targetAgent: "..." }` |
| `explore` | `{}` |
| `pass` | `{}` |

## Structure Costs

| Structure | Cost | VP |
|-----------|------|----|
| Road | 1G + 1T | 0 |
| Village | 1G + 1T + 1O + 1W | 1 |
| Township | 2G + 1T + 1O + 1W | 2 |
| City | 2G + 2O + 1W | 3 |
| Beacon | 1O + 1W + 1E | 1 |
| Trade Post | 1T + 1F + 1W | 0 |

## Resource Types

`grain`, `timber`, `ore`, `fish`, `water`, `energy`

Max carry: **14 total**

## Debug Logging

```typescript
const bot = new SimpleAgent({
  strategy: "cooperator",
  onRound: (round, phase, state) => {
    console.log(`[Round ${round}] ${phase} — I have ${state.myResources.grain} grain`);
  },
  onResult: (result) => {
    console.log(`[Result] Score changes:`, result.scoreChanges);
  },
});
```

## Complete Example

```typescript
import { ComedyAgentBase } from "@coordination-games/agent-sdk";
import type { ComedyAgentView, GameMessage, GameAction } from "@coordination-games/agent-sdk";

// A practical agent that builds infrastructure and trades
class BuilderBot extends ComedyAgentBase {
  async negotiate(state: ComedyAgentView, messages: GameMessage[]) {
    const need = this.getNeededResource(state);
    const surplus = this.getSurplusResource(state);
    if (need && surplus) {
      return [this.makeBroadcast(`I'll trade 1 ${surplus} for 1 ${need} — fair deals welcome!`)];
    }
    return [];
  }

  async act(state: ComedyAgentView): Promise<GameAction[]> {
    const r = state.myResources;

    // Build army for defense
    if (r.ore >= 1 && r.energy >= 1 && state.myStructures.villages >= 1) {
      return [{ type: "build_army", params: {} }];
    }

    // Upgrade to city if we can afford it
    if (r.grain >= 2 && r.ore >= 2 && r.water >= 1 && state.myStructures.townships >= 1) {
      return [{ type: "upgrade_city", params: {} }];
    }

    // Build village
    if (r.grain >= 1 && r.timber >= 1 && r.ore >= 1 && r.water >= 1) {
      return [{ type: "build_village", params: {} }];
    }

    return [{ type: "pass", params: {} }];
  }

  private getSurplus(state: ComedyAgentView): string | null {
    let max = "grain", val = 0;
    for (const [r, v] of Object.entries(state.myResources)) {
      if ((v as number) > val) { val = v as number; max = r; }
    }
    return val >= 2 ? max : null;
  }

  private getNeeded(state: ComedyAgentView): string | null {
    let min = "grain", val = Infinity;
    for (const [r, v] of Object.entries(state.myResources)) {
      if ((v as number) < val) { val = v as number; min = r; }
    }
    return val < 2 ? min : null;
  }
}

const bot = new BuilderBot({ arenaPath: "./comedy-mcp" });
bot.run().catch(console.error);
```

## CLI Tool

```bash
# Rule-based agents
npx tsx packages/agent-sdk/src/cli.ts --simple cooperator
npx tsx packages/agent-sdk/src/cli.ts --simple tit_for_tat

# LLM agent with persona
npx tsx packages/agent-sdk/src/cli.ts --persona packages/agent-sdk/personas/strategic.md
```
