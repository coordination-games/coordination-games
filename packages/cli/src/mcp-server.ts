import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadKey, getOrCreateKey } from "./keys.js";
import { loadConfig } from "./config.js";
import { ApiClient } from "./api-client.js";
import { signMove } from "./signing.js";

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "coordination",
    version: "0.1.0",
  });

  // check_name: Check if a name is available
  server.tool(
    "check_name",
    "Check if a name is available for registration",
    { name: z.string().describe("The name to check") },
    async ({ name }) => {
      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);
      try {
        const data = await client.get(`/api/check-name/${encodeURIComponent(name)}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ available: data.available, name }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // register: Register a name
  server.tool(
    "register",
    "Register a name (costs 5 USDC — confirm with human first!)",
    { name: z.string().describe("The name to register") },
    async ({ name }) => {
      const wallet = loadKey();
      if (!wallet) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No identity. Run 'coordination init' first." }) }],
          isError: true,
        };
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const result = await client.post("/api/register", {
          name,
          address: wallet.address,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agentId: result.agentId,
              name: result.name,
              credits: result.credits,
            }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // status: Show registration status
  server.tool(
    "status",
    "Show address, registration status, agent ID, name, and credit balance",
    {},
    async () => {
      const wallet = loadKey();
      if (!wallet) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No identity. Run 'coordination init' first." }) }],
          isError: true,
        };
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get(`/api/agent/${wallet.address}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              address: wallet.address,
              agentId: data.agentId,
              name: data.name,
              credits: data.credits,
              registered: data.registered,
            }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              address: wallet.address,
              registered: false,
              error: err.message,
            }),
          }],
        };
      }
    }
  );

  // lobbies: List available lobbies
  server.tool(
    "lobbies",
    "List available game lobbies",
    {},
    async () => {
      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get("/api/lobbies");
        return {
          content: [{ type: "text", text: JSON.stringify({ lobbies: data.lobbies || [] }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // join: Join a lobby
  server.tool(
    "join",
    "Join a game lobby",
    { lobbyId: z.string().describe("The lobby ID to join") },
    async ({ lobbyId }) => {
      const wallet = loadKey();
      if (!wallet) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No identity." }) }],
          isError: true,
        };
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const result = await client.post("/api/lobbies/join", {
          lobbyId,
          address: wallet.address,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ joined: true, ...result }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ joined: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // state: Get current game state
  server.tool(
    "state",
    "Get current game state for your agent",
    {},
    async () => {
      const wallet = loadKey();
      if (!wallet) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No identity." }) }],
          isError: true,
        };
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get(`/api/game/state?address=${wallet.address}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ gameState: data }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // move: Submit a signed game move
  server.tool(
    "move",
    "Submit a game move (will be signed locally)",
    { data: z.string().describe("JSON-encoded move data") },
    async ({ data }) => {
      const wallet = loadKey();
      if (!wallet) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No identity." }) }],
          isError: true,
        };
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const moveData = JSON.parse(data);
        const gameState = await client.get(`/api/game/state?address=${wallet.address}`);

        const sig = await signMove(
          wallet,
          gameState.gameId,
          gameState.turnNumber,
          moveData,
          gameState.moveSchema || {
            Move: [
              { name: "gameId", type: "bytes32" },
              { name: "turnNumber", type: "uint16" },
              { name: "data", type: "string" },
            ],
          }
        );

        const result = await client.post("/api/game/move", {
          address: wallet.address,
          gameId: gameState.gameId,
          turnNumber: gameState.turnNumber,
          moveData,
          signature: sig.signature,
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ submitted: true, ...result }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ submitted: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // wait: Wait for next game update
  server.tool(
    "wait",
    "Wait for the next game state update (blocks until update available)",
    {},
    async () => {
      const wallet = loadKey();
      if (!wallet) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No identity." }) }],
          isError: true,
        };
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get(`/api/game/wait?address=${wallet.address}`);
        return {
          content: [{ type: "text", text: JSON.stringify({ update: data }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // chat: Send team chat message
  server.tool(
    "chat",
    "Send a message to your team chat",
    { message: z.string().describe("The message to send") },
    async ({ message }) => {
      const wallet = loadKey();
      if (!wallet) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No identity." }) }],
          isError: true,
        };
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        await client.post("/api/game/chat", {
          address: wallet.address,
          message,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ sent: true }) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ sent: false, error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // balance: Show USDC and credit balance
  server.tool(
    "balance",
    "Show USDC balance and credit balance",
    {},
    async () => {
      const wallet = loadKey();
      if (!wallet) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "No identity." }) }],
          isError: true,
        };
      }

      const config = loadConfig();
      const client = new ApiClient(config.serverUrl);

      try {
        const data = await client.get(`/api/balance/${wallet.address}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              usdc: data.usdc,
              credits: data.credits,
            }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: err.message }),
          }],
          isError: true,
        };
      }
    }
  );

  return server;
}

export async function startMcpServer(mode: "stdio" | "http", port?: number) {
  const server = createMcpServer();

  if (mode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Server runs until stdin closes
  } else if (mode === "http") {
    // HTTP transport requires express — dynamic import
    const httpPort = port || 3000;
    try {
      const { StreamableHTTPServerTransport } = await import(
        "@modelcontextprotocol/sdk/server/streamableHttp.js"
      );
      const { isInitializeRequest } = await import(
        "@modelcontextprotocol/sdk/types.js"
      );

      const express = (await import("express")).default;
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
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
          const newServer = createMcpServer();
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
