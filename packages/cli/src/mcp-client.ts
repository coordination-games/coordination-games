/**
 * Lightweight MCP JSON-RPC client for Capture the Lobster server.
 *
 * Handles the MCP session lifecycle:
 *   1. Send "initialize" request to get a session ID
 *   2. Use session ID header on all subsequent requests
 *   3. Call tools via "tools/call" JSON-RPC method
 *
 * The server returns SSE (text/event-stream) responses. We parse those
 * to extract the JSON-RPC result.
 */

import { loadSession, saveSession } from "./config.js";

let jsonRpcId = 1;

function nextId(): number {
  return jsonRpcId++;
}

/**
 * Parse an SSE response body to extract JSON-RPC messages.
 * Format: "event: message\ndata: {json}\n\n"
 */
function parseSseResponse(text: string): any[] {
  const messages: any[] = [];
  const events = text.split("\n\n").filter((s) => s.trim());

  for (const event of events) {
    const lines = event.split("\n");
    let data = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        data += line.slice(6);
      }
    }
    if (data) {
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Skip unparseable data lines
      }
    }
  }

  return messages;
}

/**
 * Read a response body, handling both JSON and SSE content types.
 * Returns the parsed JSON-RPC response object.
 */
async function readResponse(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  if (contentType.includes("text/event-stream")) {
    const messages = parseSseResponse(text);
    // Return the last message with a result or error (skip notifications)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].result !== undefined || messages[i].error !== undefined) {
        return messages[i];
      }
    }
    // If no result/error messages, return the last one
    return messages[messages.length - 1] || {};
  }

  // Plain JSON
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid response: ${text.slice(0, 200)}`);
  }
}

export class McpClient {
  private serverUrl: string;
  private sessionId: string | null = null;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
    // Try to restore session from saved state
    const session = loadSession();
    if (session.mcpSessionId) {
      this.sessionId = session.mcpSessionId;
    }
  }

  /** Initialize the MCP session (required before calling tools) */
  async initialize(): Promise<void> {
    const body = {
      jsonrpc: "2.0",
      id: nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "coga-cli", version: "0.1.1" },
      },
    };

    const res = await fetch(`${this.serverUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP initialize failed (${res.status}): ${text}`);
    }

    // Extract session ID from response header
    const sid = res.headers.get("mcp-session-id");
    if (sid) {
      this.sessionId = sid;
      const session = loadSession();
      session.mcpSessionId = sid;
      saveSession(session);
    }

    // Consume the SSE response body (don't need the init result)
    await readResponse(res).catch(() => {});

    // Send initialized notification
    await this.notify("notifications/initialized", {});
  }

  /** Send a JSON-RPC notification (no response expected) */
  private async notify(method: string, params: any): Promise<void> {
    const body = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    await fetch(`${this.serverUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  /** Ensure we have an active session, initializing if needed */
  private async ensureSession(): Promise<void> {
    if (!this.sessionId) {
      await this.initialize();
    }
  }

  /**
   * Call an MCP tool and return the parsed result.
   * Automatically initializes session if needed.
   * If the session expired, re-initializes and retries once.
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    await this.ensureSession();

    const result = await this._callToolOnce(toolName, args);

    // Check if session expired (404 = session not found)
    if (result.__sessionExpired) {
      this.sessionId = null;
      await this.initialize();
      return this._callToolOnce(toolName, args);
    }

    return result;
  }

  private async _callToolOnce(toolName: string, args: Record<string, any>): Promise<any> {
    const body = {
      jsonrpc: "2.0",
      id: nextId(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const res = await fetch(`${this.serverUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (res.status === 404) {
      // Session expired
      return { __sessionExpired: true };
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP call failed (${res.status}): ${text}`);
    }

    const json = await readResponse(res);

    if (json.error) {
      throw new Error(`MCP error: ${json.error.message || JSON.stringify(json.error)}`);
    }

    // Extract text content from MCP result
    const result = json.result;
    if (result && result.content && Array.isArray(result.content)) {
      const textContent = result.content.find((c: any) => c.type === "text");
      if (textContent) {
        try {
          return JSON.parse(textContent.text);
        } catch {
          return textContent.text;
        }
      }
    }

    return result;
  }

  /**
   * Sign in to get an auth token. Saves token + agentId to session.
   */
  async signin(handle: string): Promise<{ token: string; agentId: string }> {
    const result = await this.callTool("signin", { agentId: handle });

    if (result.error) {
      throw new Error(result.error);
    }

    // Persist session state
    const session = loadSession();
    session.token = result.token;
    session.agentId = result.agentId;
    session.handle = handle;
    session.mcpSessionId = this.sessionId || undefined;
    saveSession(session);

    return { token: result.token, agentId: result.agentId };
  }

  /** Get the saved token, or null if not signed in */
  getToken(): string | null {
    const session = loadSession();
    return session.token || null;
  }
}
