/**
 * MCP Client — connects to the Comedy MCP server over stdio.
 *
 * The arena runs a local MCP server (via `comedy-mcp` CLI or embedded).
 * This client wraps the JSON-RPC-over-stdio protocol so agents can
 * call tools and receive responses without knowing the transport details.
 *
 * Usage:
 *   const client = new ComedyMcpClient({ arenaPath: './node_modules/.bin/comedy-mcp' });
 *   await client.connect();
 *   const guide = await client.getGuide();
 *   const state = await client.getGameState();
 */

import { spawn, ChildProcess } from "child_process";
import { parseArgs } from "util";

export interface M2pClientOptions {
  /** Path to the arena MCP binary. Defaults to 'comedy-mcp'. */
  arenaPath?: string;
  /** Additional args to pass to the arena process. */
  arenaArgs?: string[];
  /** Timeout for each tool call in ms. Default 30_000. */
  callTimeoutMs?: number;
  /** Called with each JSON-RPC request sent (debug). */
  onSend?: (msg: unknown) => void;
  /** Called with each JSON-RPC response received (debug). */
  onReceive?: (msg: unknown) => void;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// ComedyMcpClient
// ---------------------------------------------------------------------------

export class ComedyMcpClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private msgId = 0;
  private connected = false;
  private readonly callTimeoutMs: number;
  private readonly arenaPath: string;
  private readonly arenaArgs: string[];
  private readonly onSend?: (msg: unknown) => void;
  private readonly onReceive?: (msg: unknown) => void;

  // Line buffer for stdio
  private buffer = "";

  constructor(options: M2pClientOptions = {}) {
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.arenaPath = options.arenaPath ?? "comedy-mcp";
    this.arenaArgs = options.arenaArgs ?? [];
    this.onSend = options.onSend;
    this.onReceive = options.onReceive;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Spawn the arena MCP process and establish the stdio transport.
   * Call this once before any tool calls.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    const args = this.arenaArgs;

    this.proc = spawn(this.arenaPath, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env },
    });

    if (!this.proc.stdin || !this.proc.stdout) {
      throw new Error("Failed to spawn arena process — stdin/stdout not available");
    }

    this.proc.on("error", (err) => {
      console.error("[ComedyMcpClient] process error:", err);
    });

    this.proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[ComedyMcpClient] arena process exited with code ${code}`);
      }
    });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          this.handleLine(line);
        }
      }
    });

    // Wait for the transport to initialize
    await this.initializeTransport();
    this.connected = true;
  }

  /** Shut down the arena process. Call when done. */
  async disconnect(): Promise<void> {
    if (!this.proc) return;
    this.proc.stdin?.end();
    await new Promise<void>((resolve) => {
      if (!this.proc) return resolve();
      this.proc.once("exit", () => resolve());
      setTimeout(resolve, 1_000); // timeout safety
    });
    this.connected = false;
  }

  private async initializeTransport(): Promise<void> {
    // Send the MCP handshake: initialize
    const result = await this.sendRaw({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        clientInfo: { name: "agent-sdk", version: "0.1.0" },
      },
    });
    // The server responds with its capabilities; we don't need to do anything with them
    return result as void;
  }

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  /**
   * Get the game rules, available tools, and MCP resources.
   * Call this first — it contains everything the agent needs to understand the game.
   */
  async getGuide(): Promise<unknown> {
    return this.callTool("get_guide", {});
  }

  /**
   * Get the current game state visible to this agent.
   * Returns a ComedyAgentView.
   */
  async getGameState(): Promise<unknown> {
    return this.callTool("get_game_state", {});
  }

  /**
   * Alias for getGameState (coordination-games compatible).
   */
  async getState(): Promise<unknown> {
    return this.callTool("get_state", {});
  }

  /**
   * Submit an action during the action phase.
   * @param action_type - e.g. "build_village", "trade_player", "pass"
   * @param params - Action parameters
   */
  async submitAction(
    action_type: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.callTool("submit_action", { action_type, params });
  }

  /**
   * Submit an action using the coordination-games action object format.
   */
  async submitMove(action: Record<string, unknown>): Promise<unknown> {
    return this.callTool("submit_move", { action });
  }

  /**
   * Send a negotiation message.
   * @param channel - "public", "private", "broadcast", or "diary"
   * @param text - Message content
   * @param recipient - Agent ID (required for "private")
   */
  async sendMessage(
    channel: "public" | "private" | "broadcast" | "diary",
    text: string,
    recipient?: string,
  ): Promise<unknown> {
    return this.callTool("send_message", { channel, text, recipient });
  }

  /**
   * Propose a resource trade to another player.
   */
  async proposeTrade(
    partner: string,
    offer: Record<string, number>,
    request: Record<string, number>,
  ): Promise<unknown> {
    return this.callTool("propose_trade", { partner, offer, request });
  }

  /**
   * Accept or reject a pending trade proposal.
   */
  async respondTrade(trade_id: string, accept: boolean): Promise<unknown> {
    return this.callTool("respond_trade", { trade_id, accept });
  }

  /**
   * Extract from a shared ecosystem.
   */
  async extractEcosystem(
    ecosystem_id: string,
    level: "low" | "medium" | "high",
  ): Promise<unknown> {
    return this.callTool("extract_ecosystem", { ecosystem_id, level });
  }

  /**
   * Contribute resources to an active crisis.
   */
  async contributeCrisis(
    crisis_id: string,
    resources: Record<string, number>,
  ): Promise<unknown> {
    return this.callTool("contribute_crisis", { crisis_id, resources });
  }

  /**
   * Send an alliance formation proposal.
   */
  async formAlliance(partner_id: string): Promise<unknown> {
    return this.callTool("form_alliance", { partner_id });
  }

  /**
   * Send an alliance break notice.
   */
  async breakAlliance(partner_id: string): Promise<unknown> {
    return this.callTool("break_alliance", { partner_id });
  }

  /**
   * Build or upgrade a structure.
   * @param structure_type - "road", "village", "township", "city", "beacon", "trade_post"
   * @param location - Optional hex location
   */
  async build(
    structure_type: string,
    location?: unknown,
  ): Promise<unknown> {
    return this.callTool("build", { structure_type, location });
  }

  /** Pass the current turn (no-op). */
  async passTurn(): Promise<unknown> {
    return this.callTool("pass_turn", {});
  }

  // ---------------------------------------------------------------------------
  // Low-level JSON-RPC
  // ---------------------------------------------------------------------------

  private async callTool(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.connected) {
      throw new Error("Not connected — call connect() first");
    }
    const result = await this.sendRaw({
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "tools/call",
      params: { name: method, arguments: params },
    });

    if (!result) {
      throw new Error(`Tool ${method} returned no result`);
    }

    // The MCP result is wrapped; extract the content
    const wrapped = result as { content?: Array<{ type: string; text?: string }> };
    if (wrapped.content?.[0]?.type === "text") {
      try {
        return JSON.parse(wrapped.content[0].text ?? "{}");
      } catch {
        return wrapped;
      }
    }
    return wrapped;
  }

  private sendRaw(msg: JsonRpcRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        return reject(new Error("Process stdin not available"));
      }

      const id = msg.id;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP call timed out after ${this.callTimeoutMs}ms: ${msg.method}`));
      }, this.callTimeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      const line = JSON.stringify(msg) + "\n";
      this.onSend?.(msg);
      this.proc.stdin.write(line);
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    this.onReceive?.(msg);

    if (msg.id === undefined) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;

    if (msg.error) {
      pending.reject(new Error(`MCP error: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result ?? {});
    }
  }

  private nextId(): number {
    return ++this.msgId;
  }
}

// ---------------------------------------------------------------------------
// CLI helper
// ---------------------------------------------------------------------------

export interface CliOptions {
  /** Path to the arena MCP binary. */
  arenaPath?: string;
  /** URL of the game server (for remote play). */
  serverUrl?: string;
  /** Agent ID (optional — server may assign one). */
  agentId?: string;
  /** Path to a persona markdown file. */
  personaPath?: string;
  /** Run with the simple bot instead of an LLM. */
  /** Run with the simple bot instead of an LLM. */
  simple?: string;
}

/** Parse agent CLI arguments. */
export function parseAgentArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      arena: { type: "string" },
      server: { type: "string" },
      id: { type: "string" },
      persona: { type: "string" },
      simple: { type: "string" },
    },
    allowPositionals: true,
  });

  return {
    arenaPath: values.arena,
    serverUrl: values.server,
    agentId: values.id,
    personaPath: values.persona,
    simple: values.simple,
  };
}
