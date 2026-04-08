/**
 * SimpleAgent — rule-based agent for Comedy of the Commons.
 *
 * Demonstrates the SDK interface with scripted strategies.
 * Useful for testing, simulation, and as a starting point for custom agents.
 *
 * Usage:
 *   import { SimpleAgent } from "@coordination-games/agent-sdk";
 *
 *   const bot = new SimpleAgent({
 *     strategy: "cooperator",
 *     arenaPath: "./comedy-mcp",
 *   });
 *   bot.run();
 */

import { ComedyAgentBase } from "./agent-base.js";
import type { ComedyAgentView, GameMessage, GameAction, ResourceInventory } from "./types.js";

export type Strategy = "cooperator" | "defector" | "tit_for_tat" | "builder" | "diplomat" | "opportunist";

export interface SimpleAgentOptions {
  strategy?: Strategy;
  arenaPath?: string;
  onRound?: (round: number, phase: string, state: ComedyAgentView) => void;
}

interface Memory {
  lastBehavior: Record<string, "cooperated" | "defected" | "unknown">;
  allies: Set<string>;
  enemies: Set<string>;
  roundCount: number;
}

export class SimpleAgent extends ComedyAgentBase {
  private readonly strategy: Strategy;
  private memory: Memory = {
    lastBehavior: {},
    allies: new Set(),
    enemies: new Set(),
    roundCount: 0,
  };

  constructor(options: SimpleAgentOptions = {}) {
    super(options);
    this.strategy = options.strategy ?? "cooperator";
    console.log(`[SimpleAgent] Strategy: ${this.strategy}`);
  }

  async negotiate(state: ComedyAgentView, messages: GameMessage[]): Promise<GameMessage[]> {
    this.memory.roundCount = state.round;
    this.processIncomingMessages(messages, state.myId);

    switch (this.strategy) {
      case "cooperator":    return this.negotiateCooperator(state);
      case "defector":      return this.negotiateDefector(state);
      case "tit_for_tat":   return this.negotiateTitForTat(state);
      case "builder":       return this.negotiateBuilder(state);
      case "diplomat":      return this.negotiateDiplomat(state);
      case "opportunist":   return this.negotiateOpportunist(state);
      default:              return [];
    }
  }

  async act(state: ComedyAgentView): Promise<GameAction[]> {
    const actions: GameAction[] = [];

    if (state.activeCrisis && !state.activeCrisis.resolved && this.strategy !== "defector") {
      const contrib = this.decideCrisisContribution(state);
      if (contrib) {
        actions.push({
          type: "crisis_contribute",
          params: { crisisId: state.activeCrisis.id, contribution: contrib },
        });
      }
    }

    if (actions.length < 2) {
      const build = this.decideBuild(state);
      if (build) actions.push(build);
    }

    if (actions.length < 2) {
      const secondary = this.decideSecondary(state);
      if (secondary) actions.push(secondary);
    }

    if (actions.length === 0) {
      actions.push({ type: "pass", params: {} });
    }

    return actions;
  }

  private negotiateCooperator(state: ComedyAgentView): GameMessage[] {
    const msgs: GameMessage[] = [];
    const surplus = this.getSurplus(state);
    const need = this.getNeeded(state);

    if (surplus && need) {
      msgs.push(this.makeBroadcast(`I'll trade 1 ${surplus} for 1 ${need} — fair deals only!`));
    } else {
      msgs.push(this.makeBroadcast("Looking to cooperate. Let's build together!"));
    }
    return msgs;
  }

  private negotiateDefector(state: ComedyAgentView): GameMessage[] {
    return [this.makeBroadcast("I'm a team player! Who wants to trade?")];
  }

  private negotiateTitForTat(state: ComedyAgentView): GameMessage[] {
    const msgs: GameMessage[] = [];
    for (const [id] of Object.entries(state.allScores)) {
      if (id === state.myId) continue;
      const last = this.memory.lastBehavior[id] ?? "unknown";
      if (last === "cooperated" || last === "unknown") {
        msgs.push(this.makePrivate(id, "You've been reliable. Let's trade!"));
      } else {
        msgs.push(this.makePrivate(id, "You broke trust. No trades until you prove yourself."));
      }
    }
    return msgs;
  }

  private negotiateBuilder(state: ComedyAgentView): GameMessage[] {
    const need = this.getNeeded(state);
    if (need) {
      return [this.makeBroadcast(`Need ${need}! Will trade fairly.`)];
    }
    return [];
  }

  private negotiateDiplomat(state: ComedyAgentView): GameMessage[] {
    return [this.makeBroadcast("I propose a crisis response coalition. Contributors get priority trades.")];
  }

  private negotiateOpportunist(state: ComedyAgentView): GameMessage[] {
    const myScore = state.myVP;
    const others = Object.entries(state.allScores)
      .filter(([id]) => id !== state.myId)
      .map(([, score]) => score);
    const maxOther = others.length ? Math.max(...others) : 0;

    if (myScore >= maxOther - 2) {
      return [this.makeBroadcast("Great game! Let's keep growing together.")];
    }
    return [this.makeBroadcast("Who wants to team up against the leader?")];
  }

  private decideBuild(state: ComedyAgentView): GameAction | null {
    const r = state.myResources;
    const total = state.myStructures.villages + state.myStructures.townships + state.myStructures.cities;

    if (r.ore >= 1 && r.energy >= 1 && state.myStructures.villages >= 1) {
      return { type: "build_army", params: {} };
    }
    if (r.grain >= 2 && r.ore >= 2 && r.water >= 1 && state.myStructures.townships >= 1) {
      return { type: "upgrade_city", params: {} };
    }
    if (r.grain >= 2 && r.timber >= 1 && r.ore >= 1 && r.water >= 1 && state.myStructures.villages >= 1) {
      return { type: "upgrade_township", params: {} };
    }
    if (r.grain >= 1 && r.timber >= 1 && r.ore >= 1 && r.water >= 1 && total < 5) {
      return { type: "build_village", params: {} };
    }
    if (r.grain >= 1 && r.timber >= 1) {
      return { type: "build_road", params: {} };
    }
    return null;
  }

  private decideSecondary(state: ComedyAgentView): GameAction | null {
    if (state.round <= 3) {
      return { type: "explore", params: {} };
    }
    const eco = state.ecosystemStates[0];
    if (eco && eco.status !== "collapsed") {
      const level = eco.health > eco.maxHealth * 0.7 ? "medium" : "low";
      return { type: "extract_commons", params: { ecosystemId: eco.id, extractionLevel: level } };
    }
    return { type: "explore", params: {} };
  }

  private decideCrisisContribution(state: ComedyAgentView): Partial<ResourceInventory> | null {
    if (!state.activeCrisis) return null;
    const threshold = state.activeCrisis.threshold;
    const contrib: Partial<ResourceInventory> = {};
    let total = 0;

    for (const [res, needed] of Object.entries(threshold)) {
      const r = res as keyof ResourceInventory;
      if ((needed as number) > 0 && state.myResources[r] > 1) {
        const amount = Math.min(2, state.myResources[r] - 1, needed as number);
        if (amount > 0) {
          (contrib as Record<string, number>)[res] = amount;
          total += amount;
        }
      }
    }
    return total > 0 ? contrib : null;
  }

  private getSurplus(state: ComedyAgentView): string | null {
    let maxRes = "grain";
    let maxVal = 0;
    for (const [res, val] of Object.entries(state.myResources)) {
      if ((val as number) > maxVal) { maxVal = val as number; maxRes = res; }
    }
    return maxVal >= 2 ? maxRes : null;
  }

  private getNeeded(state: ComedyAgentView): string | null {
    let minRes = "grain";
    let minVal = Infinity;
    for (const [res, val] of Object.entries(state.myResources)) {
      if ((val as number) < minVal) { minVal = val as number; minRes = res; }
    }
    return minVal < 2 ? minRes : null;
  }

  private processIncomingMessages(messages: GameMessage[], myId: string): void {
    for (const msg of messages) {
      if (msg.sender === myId) continue;
      const lower = msg.content.toLowerCase();
      if (lower.includes("alliance") || lower.includes("cooperat")) {
        if (!this.memory.lastBehavior[msg.sender]) {
          this.memory.lastBehavior[msg.sender] = "unknown";
        }
      }
    }
  }
}
