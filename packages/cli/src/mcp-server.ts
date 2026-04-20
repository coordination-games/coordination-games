/**
 * MCP server for Coordination Games CLI.
 *
 * Creates a GameClient backed by the REST API and registers all game
 * tools via the shared registerGameTools() function. Supports stdio
 * transport (for Claude Code / Claude Desktop) and HTTP transport
 * (for OpenAI and other HTTP MCP clients).
 *
 * Auth is handled transparently by GameClient -- if a private key is
 * provided, it auto-authenticates via challenge-response before the
 * first API call. No auth tools are exposed to agents.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GameClient } from "./game-client.js";
import { registerGameTools } from "./mcp-tools.js";
import { loadConfig } from "./config.js";
import { BasicChatPlugin } from "@coordination-games/plugin-chat";
import { CaptureTheLobsterPlugin } from "@coordination-games/game-ctl";
import { OathbreakerPlugin } from "@coordination-games/game-oathbreaker";

export interface ServeOptions {
  serverUrl: string;
  privateKey?: string;
  name?: string;
  httpPort?: number;
}

function createMcpServerWithClient(options?: ServeOptions): { server: McpServer; client: GameClient } {
  const serverUrl = options?.serverUrl || loadConfig().serverUrl;
  const client = new GameClient(serverUrl, {
    privateKey: options?.privateKey,
    name: options?.name,
  });
  const server = new McpServer({
    name: "coordination-games",
    version: "0.1.0",
  });
  registerGameTools(server, client, {
    plugins: [BasicChatPlugin],
    games: [CaptureTheLobsterPlugin, OathbreakerPlugin],
  });
  return { server, client };
}

export async function startMcpServer(mode: "stdio" | "http", options?: ServeOptions) {
  const { server } = createMcpServerWithClient(options);

  if (mode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Server runs until stdin closes
  } else if (mode === "http") {
    const httpPort = options?.httpPort || 3000;
    try {
      const { StreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/streamableHttp.js"
      );
      const { isInitializeRequest } = await import(
        "@modelcontextprotocol/sdk/types.js"
      );
      const express = (await import("express")).default;
      const crypto = await import("node:crypto");

      const app = express();
      app.use(express.json());

      const transports = new Map<string, any>();

      app.post("/mcp", async (req: any, res: any) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
          const { server: newServer } = createMcpServerWithClient(options);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });
          transport.onclose = () => {
            const sid = (transport as any).sessionId;
            if (sid) transports.delete(sid);
          };
          await newServer.connect(transport);
          await transport.handleRequest(req, res);
          const sid = (transport as any).sessionId;
          if (sid) transports.set(sid, transport);
          return;
        }

        res.status(400).json({ error: "Bad request" });
      });

      app.get("/mcp", async (req: any, res: any) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }
        res.status(400).json({ error: "No session" });
      });

      app.listen(httpPort, () => {
        process.stderr.write(`MCP HTTP server listening on port ${httpPort}\n`);
      });
    } catch (err: any) {
      process.stderr.write(`Failed to start HTTP server: ${err.message}\n`);
      process.stderr.write(`Falling back to stdio transport.\n`);
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  }
}
