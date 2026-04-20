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

import { loadSession, saveSession } from './config.js';

let jsonRpcId = 1;

function nextId(): number {
  return jsonRpcId++;
}

/**
 * Parse an SSE response body to extract JSON-RPC messages.
 * Format: "event: message\ndata: {json}\n\n"
 */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  params?: unknown;
}

function parseSseResponse(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  const events = text.split('\n\n').filter((s) => s.trim());

  for (const event of events) {
    const lines = event.split('\n');
    let data = '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
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
async function readResponse(res: Response): Promise<JsonRpcMessage> {
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();

  if (contentType.includes('text/event-stream')) {
    const messages = parseSseResponse(text);
    // Return the last message with a result or error (skip notifications)
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && (m.result !== undefined || m.error !== undefined)) {
        return m;
      }
    }
    // If no result/error messages, return the last one
    return messages[messages.length - 1] ?? {};
  }

  // Plain JSON
  try {
    return JSON.parse(text) as JsonRpcMessage;
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
      jsonrpc: '2.0',
      id: nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'coga-cli', version: '0.1.1' },
      },
    };

    const res = await fetch(`${this.serverUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP initialize failed (${res.status}): ${text}`);
    }

    // Extract session ID from response header
    const sid = res.headers.get('mcp-session-id');
    if (sid) {
      this.sessionId = sid;
      const session = loadSession();
      session.mcpSessionId = sid;
      saveSession(session);
    }

    // Consume the SSE response body (don't need the init result)
    await readResponse(res).catch(() => {});

    // Send initialized notification
    await this.notify('notifications/initialized', {});
  }

  /** Send a JSON-RPC notification (no response expected) */
  private async notify(method: string, params: unknown): Promise<void> {
    const body = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    await fetch(`${this.serverUrl}/mcp`, {
      method: 'POST',
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
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureSession();

    const result = await this._callToolOnce(toolName, args);

    // Check if session expired (404 = session not found)
    if (
      result &&
      typeof result === 'object' &&
      (result as { __sessionExpired?: boolean }).__sessionExpired
    ) {
      this.sessionId = null;
      await this.initialize();
      return this._callToolOnce(toolName, args);
    }

    return result;
  }

  private async _callToolOnce(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const body = {
      jsonrpc: '2.0',
      id: nextId(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const res = await fetch(`${this.serverUrl}/mcp`, {
      method: 'POST',
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
    const result = json.result as
      | { content?: Array<{ type?: string; text?: string }> }
      | null
      | undefined;
    if (result?.content && Array.isArray(result.content)) {
      const textContent = result.content.find((c) => c.type === 'text');
      if (textContent?.text !== undefined) {
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
    const result = (await this.callTool('signin', { agentId: handle })) as {
      token?: string;
      agentId?: string;
      error?: string;
    } | null;

    if (result?.error) {
      throw new Error(result.error);
    }
    if (!result?.token || !result.agentId) {
      throw new Error('signin response missing token/agentId');
    }

    // Persist session state
    const session = loadSession();
    session.token = result.token;
    session.agentId = result.agentId;
    session.handle = handle;
    // @ts-expect-error TS2412: Type 'string | undefined' is not assignable to type 'string' with 'exactOptional — TODO(2.3-followup)
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
