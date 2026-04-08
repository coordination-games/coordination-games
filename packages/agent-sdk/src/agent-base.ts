/**
 * ComedyAgentBase — abstract base class for Comedy of the Commons agents.
 *
 * Handles the game lifecycle and MCP communication. Subclasses only need to
 * implement the three decision methods:
 *
 *   negotiate(state, messages) → GameMessage[]
 *   act(state)                → GameAction[]
 *   reflect(results)          → void (async)
 *
 * Example — a simple agent that cooperates:
 *
 *   class CooperativeBot extends ComedyAgentBase {
 *     async negotiate(state, messages) {
 *       return [state.makeBroadcast(`I'll trade!`)];
 *     }
 *     async act(state) {
 *       return [{ type: "pass", params: {} }];
 *     }
 *   }
 *
 *   const bot = new CooperativeBot({ arenaPath: "./comedy-mcp" });
 *   await bot.run();
 */

import { ComedyMcpClient } from "./mcp-client.js";
import type {
  ComedyAgentView,
  GameMessage,
  GameAction,
  RoundResult,
  GameGuide,
  ExtractionLevel,
  ResourceInventory,
} from "./types.js";

export interface AgentOptions {
  /** Path to the arena MCP binary. */
  arenaPath?: string;
  /** Additional args to the arena process. */
  arenaArgs?: string[];
  /** Agent ID (optional). */
  agentId?: string;
  /** Called with each round's state for logging. */
  onRound?: (round: number, phase: string, state: ComedyAgentView) => void;
  /** Called when the agent receives game results. */
  onResult?: (result: RoundResult) => void;
  /** Called when the agent receives messages. */
  onMessages?: (messages: GameMessage[]) => void;
}

/**
 * Abstract agent base class.
 * Manages MCP connection, game lifecycle, and round loop.
 * Subclass implements the three decision hooks.
 */
export abstract class ComedyAgentBase {
  protected readonly client: ComedyMcpClient;
  protected readonly onRound?: AgentOptions["onRound"];
  protected readonly onResult?: AgentOptions["onResult"];
  protected readonly onMessages?: AgentOptions["onMessages"];
  protected guide: GameGuide | null = null;
  protected state: ComedyAgentView | null = null;
  protected agentId: string | null = null;
  protected running = false;

  constructor(options: AgentOptions = {}) {
    this.client = new ComedyMcpClient({
      arenaPath: options.arenaPath,
      arenaArgs: options.arenaArgs,
    });
    this.onRound = options.onRound;
    this.onResult = options.onResult;
    this.onMessages = options.onMessages;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to the arena MCP server and run the game loop.
   * Blocks until the game ends or an error occurs.
   */
  async run(): Promise<void> {
    await this.client.connect();
    console.log("[Agent] Connected to arena MCP server");

    // Fetch the guide first
    this.guide = (await this.client.getGuide()) as GameGuide;
    console.log(`[Agent] Game: ${this.guide.game}`);
    console.log(`[Agent] Tools: ${this.guide.tools.join(", ")}`);

    this.running = true;
    let lastRound = 0;

    while (this.running) {
      try {
        const result = await this.client.getGameState();
        const state = this.parseState(result);

        if (!state) {
          // Game ended or not started
          await this.sleep(1_000);
          continue;
        }

        // Notify on round change
        if (state.round !== lastRound) {
          console.log(`[Agent] Round ${state.round} — ${state.phase}`);
          lastRound = state.round;
        }

        this.state = state;
        this.agentId = state.myId;
        this.onRound?.(state.round, state.phase, state);

        switch (state.phase) {
          case "negotiation":
            await this.handleNegotiation(state);
            break;
          case "action":
            await this.handleAction(state);
            break;
          case "resolution":
          case "production":
          case "crisis":
          case "setup":
          case "end":
            // Nothing to do; wait for next update
            break;
          default:
            // Unknown phase — wait
            break;
        }

        await this.sleep(500);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timed out") || msg.includes("not connected")) {
          console.warn("[Agent] Connection issue, retrying…");
          await this.sleep(2_000);
          continue;
        }
        console.error("[Agent] Error in game loop:", err);
        break;
      }
    }

    await this.client.disconnect();
    console.log("[Agent] Disconnected");
  }

  /** Stop the game loop. Call this to cleanly shut down. */
  stop(): void {
    this.running = false;
  }

  // -------------------------------------------------------------------------
  // Phase handlers — call the decision hooks
  // -------------------------------------------------------------------------

  private async handleNegotiation(state: ComedyAgentView): Promise<void> {
    try {
      const result = await this.client.getGameState();
      const fresh = this.parseState(result);
      if (!fresh) return;

      // Collect any messages visible to us
      const messages = fresh.messageHistory ?? [];
      this.onMessages?.(messages);

      const myMessages = await this.negotiate(fresh, messages);

      for (const msg of myMessages) {
        await this.client.sendMessage(
          msg.type as "public" | "private" | "broadcast" | "diary",
          msg.content,
          msg.recipient === "broadcast" ? undefined : msg.recipient,
        );
      }
    } catch (err) {
      console.error("[Agent] Error in negotiation phase:", err);
    }
  }

  private async handleAction(state: ComedyAgentView): Promise<void> {
    try {
      const result = await this.client.getGameState();
      const fresh = this.parseState(result);
      if (!fresh) return;

      const actions = await this.act(fresh);

      for (const action of actions) {
        await this.client.submitAction(action.type, (action.params ?? {}) as Record<string, unknown>);
      }

      if (actions.length === 0) {
        await this.client.passTurn();
      }
    } catch (err) {
      console.error("[Agent] Error in action phase:", err);
      // Safety: always submit something
      try {
        await this.client.passTurn();
      } catch {
        // ignore
      }
    }
  }

  // -------------------------------------------------------------------------
  // Decision hooks — implement these in subclasses
  // -------------------------------------------------------------------------

  /**
   * Called during the negotiation phase.
   * Return messages to send to other players.
   *
   * @param state - Current game state
   * @param messages - Messages visible to this agent this round
   */
  async negotiate(state: ComedyAgentView, messages: GameMessage[]): Promise<GameMessage[]> {
    return []; // Default: no messages
  }

  /**
   * Called during the action phase.
   * Return 1-2 actions to submit. If empty, passTurn() is called.
   *
   * @param state - Current game state
   */
  async act(state: ComedyAgentView): Promise<GameAction[]> {
    return [{ type: "pass", params: {} }]; // Default: pass
  }

  /**
   * Called after each round resolution with the round result.
   *
   * @param results - Round outcome data
   */
  async reflect(results: RoundResult): Promise<void> {
    this.onResult?.(results);
  }

  // -------------------------------------------------------------------------
  // Protected helpers
  // -------------------------------------------------------------------------

  /**
   * Create a public broadcast message.
   */
  protected makeBroadcast(content: string): GameMessage {
    return {
      id: crypto.randomUUID(),
      sender: this.agentId ?? "unknown",
      recipient: "broadcast",
      content,
      type: "public",
      round: this.state?.round ?? 0,
      timestamp: Date.now(),
    };
  }

  /**
   * Create a private message to a specific player.
   */
  protected makePrivate(to: string, content: string): GameMessage {
    return {
      id: crypto.randomUUID(),
      sender: this.agentId ?? "unknown",
      recipient: to,
      content,
      type: "private",
      round: this.state?.round ?? 0,
      timestamp: Date.now(),
    };
  }

  /**
   * Get the list of other player IDs (excluding self).
   */
  protected otherPlayers(state: ComedyAgentView): string[] {
    return Object.keys(state.allScores).filter((id) => id !== state.myId);
  }

  /**
   * Find an ecosystem by name or ID.
   */
  protected findEcosystem(
    state: ComedyAgentView,
    query: string,
  ): ComedyAgentView["ecosystemStates"][0] | undefined {
    const q = query.toLowerCase();
    return state.ecosystemStates.find(
      (e) => e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q),
    );
  }

  /**
   * Check if the agent can afford a structure.
   */
  protected canAfford(state: ComedyAgentView, cost: Partial<ResourceInventory>): boolean {
    for (const [res, amount] of Object.entries(cost)) {
      const r = res as keyof ResourceInventory;
      const have = state.myResources[r] ?? 0;
      if (have < (amount as number)) return false;
    }
    return true;
  }

  private parseState(raw: unknown): ComedyAgentView | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    const state = obj.state;
    if (!state || typeof state !== "object") return null;
    return state as ComedyAgentView;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
