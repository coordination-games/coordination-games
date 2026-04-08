/**
 * LLMAgent — LLM-powered agent for Comedy of the Commons.
 *
 * Usage:
 *   import { LLMAgent, AnthropicProvider } from "@coordination-games/agent-sdk";
 *
 *   const agent = new LLMAgent({
 *     provider: new AnthropicProvider(process.env.ANTHROPIC_API_KEY!),
 *     personaPath: "./personas/strategic.md",
 *   });
 *   agent.run();
 *
 * Or with Minimax:
 *   import { LLMAgent, MinimaxProvider } from "@coordination-games/agent-sdk";
 *
 *   const agent = new LLMAgent({
 *     provider: new MinimaxProvider(process.env.MINIMAX_API_KEY!),
 *     personaPath: "./personas/strategic.md",
 *   });
 *   agent.run();
 */

import { readFileSync } from "fs";
import { ComedyAgentBase, type AgentOptions } from "./agent-base.js";
import type {
  ComedyAgentView,
  GameMessage,
  GameAction,
  ProviderTool,
} from "./types.js";
import type { LLMProvider } from "./providers.js";

const MODEL_FAST = "claude-haiku-4-20250414";
const MODEL_SMART = "claude-sonnet-4-20250514";
const MAX_TOKENS = 1024;

const SUBMIT_ACTIONS_TOOL: ProviderTool = {
  name: "submit_actions",
  description: "Submit 1-2 actions for this round.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "build_road", "build_village", "upgrade_township", "upgrade_city",
                "build_beacon", "build_trade_post", "build_army", "move_army",
                "attack_structure", "trade_player", "trade_bank", "explore",
                "extract_commons", "restore_ecosystem", "sabotage",
                "crisis_contribute", "pass",
              ],
            },
            params: { type: "object" },
          },
          required: ["type", "params"],
        },
        minItems: 1,
        maxItems: 2,
      },
    },
    required: ["actions"],
  },
};

const SEND_MESSAGES_TOOL: ProviderTool = {
  name: "send_messages",
  description: "Send negotiation messages.",
  input_schema: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            recipient: { type: "string" },
            content: { type: "string" },
            type: { type: "string", enum: ["public", "private"] },
          },
          required: ["recipient", "content", "type"],
        },
      },
    },
    required: ["messages"],
  },
};

const GAME_RULES_SUMMARY = `
# Comedy of the Commons — Rules Summary

## Resources
Six types: Grain, Timber, Ore, Fish, Water, Energy. Max 14 total per player.

## Structures
- Road: 1G + 1T | Village: 1G+1T+1O+1W (1 VP) | Township: 2G+1T+1O+1W (2 VP)
- City: 2G+2O+1W (3 VP) | Beacon: 1O+1W+1E (1 VP) | Trade Post: 1T+1F+1W

## Actions (max 2 per round)
Build/upgrade, trade (player or 4:1 bank), extract/restore ecosystems, armies, crises, explore, sabotage, pass.

## Ecosystems
Shared across regions. Over-extraction degrades; restoration heals. Flourishing boosts production.

## Crises
Random events needing collective resources. Contributors earn VP/influence; non-contributors face penalties.

## Trust
Public. Keeping promises builds trust. Breaking deals and sabotage erode it.

## Winning
Hidden rounds. Highest VP wins. Commons health determines prize survival.
`;

export interface LLMAgentOptions extends AgentOptions {
  /** LLM provider (Anthropic, Minimax, OpenAI, etc.). Required. */
  provider: LLMProvider;
  personaPath?: string;
}

export class LLMAgent extends ComedyAgentBase {
  private readonly provider: LLMProvider;
  private persona = "";

  constructor(options: LLMAgentOptions) {
    super(options);
    if (!options.provider) {
      throw new Error("[LLMAgent] provider is required");
    }
    this.provider = options.provider;
    if (options.personaPath) {
      try {
        this.persona = readFileSync(options.personaPath, "utf-8");
      } catch {
        console.warn(`[LLMAgent] Could not read persona at ${options.personaPath}`);
      }
    }
  }

  async negotiate(state: ComedyAgentView, messages: GameMessage[]): Promise<GameMessage[]> {
    const prompt = this.buildNegotiationPrompt(state, messages);

    try {
      const result = await this.provider.complete({
        model: MODEL_SMART,
        system: this.buildSystemPrompt("negotiation"),
        userMessage: prompt,
        tools: [SEND_MESSAGES_TOOL],
      });

      const input = this.extractToolInput<{
        messages: Array<{ recipient: string; content: string; type: string }>;
      }>(result, "send_messages");

      if (!input?.messages) return [];

      return input.messages.map((m) => ({
        id: crypto.randomUUID(),
        sender: state.myId,
        recipient: m.recipient as string,
        content: m.content,
        type: m.type as "public" | "private",
        round: state.round,
        timestamp: Date.now(),
      }));
    } catch (err) {
      console.error("[LLMAgent] negotiate error:", err);
      return [];
    }
  }

  async act(state: ComedyAgentView): Promise<GameAction[]> {
    const prompt = this.buildActionPrompt(state);

    try {
      const result = await this.provider.complete({
        model: MODEL_FAST,
        system: this.buildSystemPrompt("action"),
        userMessage: prompt,
        tools: [SUBMIT_ACTIONS_TOOL],
      });

      const input = this.extractToolInput<{
        actions: Array<{ type: string; params: Record<string, unknown> }>;
      }>(result, "submit_actions");

      if (!input?.actions?.length) {
        return this.fallbackActions(state.round);
      }

      return input.actions.map((a) => ({
        type: a.type as GameAction["type"],
        params: a.params ?? {},
      }));
    } catch (err) {
      console.error("[LLMAgent] act error:", err);
      return this.fallbackActions(state.round);
    }
  }

  private buildSystemPrompt(phase: string): string {
    return [
      "You are an AI agent playing Comedy of the Commons.",
      "",
      "## Game Rules",
      GAME_RULES_SUMMARY,
      "",
      "## Your Persona",
      this.persona || "(no persona set)",
      "",
      `## Current Phase: ${phase}`,
      "",
      "## Important",
      "- Use the provided tools to respond.",
    ].join("\n");
  }

  private buildNegotiationPrompt(state: ComedyAgentView, messages: GameMessage[]): string {
    const parts: string[] = [
      `## Round ${state.round} — Negotiation Phase`,
      "",
      "### Your State",
      `Resources: ${JSON.stringify(state.myResources)}`,
      `VP: ${state.myVP} | Influence: ${state.myInfluence}`,
      "",
      "### Scores",
      ...Object.entries(state.allScores).map(
        ([id, score]) =>
          `  ${id === state.myId ? "(you)" : id}: ${score} VP, trust=${state.trustScores[id]?.toFixed(2) ?? "?"}`,
      ),
      "",
    ];

    if (state.activeCrisis) {
      parts.push(
        "### Active Crisis",
        `${state.activeCrisis.name}: ${state.activeCrisis.description}`,
        `Threshold: ${JSON.stringify(state.activeCrisis.threshold)}`,
        "",
      );
    }

    if (messages.length > 0) {
      parts.push("### Messages");
      for (const msg of messages.slice(-10)) {
        const label = msg.type === "public" ? "[PUBLIC]" : `[PRIVATE from ${msg.sender}]`;
        parts.push(`  ${label} ${msg.sender}: ${msg.content}`);
      }
      parts.push("");
    }

    parts.push(
      "### Your Task",
      "Send negotiation messages. Use send_messages with recipient='broadcast' or a player ID.",
    );

    return parts.join("\n");
  }

  private buildActionPrompt(state: ComedyAgentView): string {
    const r = state.myResources;
    const affordability: string[] = [];

    if (r.grain >= 1 && r.timber >= 1) affordability.push("build_road (1G+1T)");
    if (r.grain >= 1 && r.timber >= 1 && r.ore >= 1 && r.water >= 1)
      affordability.push("build_village (1G+1T+1O+1W)");
    if (r.energy >= 1 && r.ore >= 1) affordability.push("sabotage (1E+1O)");
    if (state.ecosystemStates.length > 0) affordability.push("extract_commons (low/medium/high)");
    affordability.push("explore (free)");
    affordability.push("pass (free)");

    const parts: string[] = [
      `## Round ${state.round} — Action Phase`,
      "",
      "### Your State",
      `Resources: ${JSON.stringify(state.myResources)}`,
      `VP: ${state.myVP} | Influence: ${state.myInfluence}`,
      "",
      "### What You Can Afford",
      ...affordability.map((a) => `  - ${a}`),
      "",
      "### Scores",
      ...Object.entries(state.allScores).map(
        ([id, score]) => `  ${id === state.myId ? "(you)" : id}: ${score} VP`,
      ),
      "",
    ];

    if (state.activeCrisis && !state.activeCrisis.resolved) {
      parts.push(
        "### Active Crisis (UNRESOLVED)",
        `${state.activeCrisis.name}: ${state.activeCrisis.description}`,
        "",
      );
    }

    parts.push(
      "### Your Task",
      "Choose 1-2 actions. For trade_player: { partnerId, give, receive }. For extract_commons: { ecosystemId, extractionLevel }.",
    );

    return parts.join("\n");
  }

  private extractToolInput<T>(
    response: { toolCalls: Array<{ name: string; input: Record<string, unknown> }> },
    toolName: string,
  ): T | null {
    const block = response.toolCalls.find((tc) => tc.name === toolName);
    return block ? (block.input as T) : null;
  }

  private fallbackActions(round: number): GameAction[] {
    return [
      { type: "explore", params: {} },
      { type: "pass", params: {} },
    ];
  }
}
