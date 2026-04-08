/**
 * BuilderBot — Example custom agent for Comedy of the Commons.
 *
 * Focus: accumulate VP through building structures.
 * Demonstrates: implementing negotiate(), act(), and reflect().
 *
 * Run:
 *   npx tsx src/examples/BuilderBot.ts --arena ./comedy-mcp
 */

import { ComedyAgentBase } from "../agent-base.js";
import type { ComedyAgentView, GameMessage, GameAction, RoundResult } from "../types.js";

class BuilderBot extends ComedyAgentBase {
  async negotiate(state: ComedyAgentView, messages: GameMessage[]): Promise<GameMessage[]> {
    // Announce our building strategy to other players
    return [this.makeBroadcast("Building to connect and harvest the commons. Open to fair trades.")];
  }

  async act(state: ComedyAgentView): Promise<GameAction[]> {
    const { myResources, myStructures } = state;

    // Priority 1: Build a road (1 grain + 1 timber)
    // Roads connect hexes and are the cheapest structure.
    if (myResources.grain >= 1 && myResources.timber >= 1) {
      const hexes = state.visibleHexes;
      if (hexes.length > 0) {
        return [{
          type: "build_road",
          params: { location: hexes[0].coord },
        }];
      }
    }

    // Priority 2: Build a village (1 grain + 1 timber + 1 ore + 1 water)
    // Villages generate VP — the core scoring structure.
    if (
      myResources.grain >= 1 &&
      myResources.timber >= 1 &&
      myResources.ore >= 1 &&
      myResources.water >= 1 &&
      myStructures.villages < 4
    ) {
      const hexes = state.visibleHexes;
      if (hexes.length > 0) {
        return [{
          type: "build_village",
          params: { location: hexes[0].coord },
        }];
      }
    }

    // Priority 3: Trade with the bank to stock up for building
    if (myResources.grain >= 2) {
      return [{
        type: "trade_bank",
        params: {
          bankGiveType: "grain",
          bankGiveAmount: 2,
          bankReceiveType: "timber",
        },
      }];
    }

    // Explore to find more hexes
    if (myResources.grain >= 1) {
      return [{ type: "explore", params: {} }];
    }

    // Last resort: pass
    return [{ type: "pass", params: {} }];
  }

  async reflect(results: RoundResult): Promise<void> {
    const { outcomes, round, scoreChanges } = results;
    const totalVPChange = Object.values(scoreChanges).reduce((s, v) => s + v, 0);
    console.log(
      `[BuilderBot] Round ${round}: ${outcomes.length} actions, net VP delta: `
      + `${totalVPChange >= 0 ? "+" : ""}${totalVPChange}`
    );
  }
}

// CLI entry point
const { parseAgentArgs } = await import("../mcp-client.js");

const args = parseAgentArgs(process.argv.slice(2));

const bot = new BuilderBot({
  arenaPath: args.arenaPath,
  agentId: args.agentId,
});

console.log("[BuilderBot] Starting — building structures for VP...");
bot.run().catch((err) => {
  console.error("[BuilderBot] Fatal error:", err);
  process.exit(1);
});