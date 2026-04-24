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

import { CaptureTheLobsterPlugin } from '@coordination-games/game-ctl';
import { OathbreakerPlugin } from '@coordination-games/game-oathbreaker';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { GameClient } from './game-client.js';
import { registerGameTools } from './mcp-tools.js';

export interface ServeOptions {
  serverUrl: string;
  privateKey?: string;
  name?: string;
  httpPort?: number;
}

function createMcpServerWithClient(options?: ServeOptions): {
  server: McpServer;
  client: GameClient;
} {
  const serverUrl = options?.serverUrl || loadConfig().serverUrl;
  const clientOptions: { privateKey?: string; name?: string } = {};
  if (options?.privateKey) clientOptions.privateKey = options.privateKey;
  if (options?.name) clientOptions.name = options.name;
  const client = new GameClient(serverUrl, clientOptions);
  const server = new McpServer({
    name: 'coordination-games',
    version: '0.1.0',
  });
  registerGameTools(server, client, {
    plugins: [BasicChatPlugin],
    games: [CaptureTheLobsterPlugin, OathbreakerPlugin],
  });
  return { server, client };
}

export async function startMcpServer(mode: 'stdio' | 'http', options?: ServeOptions) {
  const { server } = createMcpServerWithClient(options);

  if (mode === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Server runs until stdin closes
  } else if (mode === 'http') {
    const httpPort = options?.httpPort || 3000;
    try {
      const { StreamableHTTPServerTransport } = await import(
        '@modelcontextprotocol/sdk/server/streamableHttp.js'
      );
      const { isInitializeRequest } = await import('@modelcontextprotocol/sdk/types.js');
      const express = (await import('express')).default;
      const crypto = await import('node:crypto');

      const app = express();
      app.use(express.json());

      // Local shape of the express req/res we actually use. @types/express is
      // not installed at the CLI level, so we declare the minimum surface
      // instead of pulling in another dep. The StreamableHTTPServerTransport's
      // `sessionId` field is runtime-available but not in its public types.
      type ExpressReq = {
        headers: Record<string, string | string[] | undefined>;
        body: unknown;
      };
      type ExpressRes = {
        status: (code: number) => { json: (body: unknown) => void };
      };
      type TransportWithSession = InstanceType<typeof StreamableHTTPServerTransport> & {
        sessionId?: string;
        handleRequest: (req: ExpressReq, res: ExpressRes) => Promise<void>;
      };

      const transports = new Map<string, TransportWithSession>();

      app.post('/mcp', async (req: ExpressReq, res: ExpressRes) => {
        const sessionId =
          typeof req.headers['mcp-session-id'] === 'string'
            ? req.headers['mcp-session-id']
            : undefined;

        if (sessionId) {
          const transport = transports.get(sessionId);
          if (transport) {
            await transport.handleRequest(req, res);
            return;
          }
        }

        if (!sessionId && isInitializeRequest(req.body)) {
          const { server: newServer } = createMcpServerWithClient(options);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          }) as TransportWithSession;
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) transports.delete(sid);
          };
          // MCP SDK's `Transport` interface declares `onclose: () => void`
          // (required), but `StreamableHTTPServerTransport` declares it
          // `onclose?: () => void`. Under `exactOptionalPropertyTypes`, that's
          // a mismatch; at runtime connect() handles both shapes fine.
          // @ts-expect-error MCP SDK onclose optionality mismatch
          await newServer.connect(transport);
          await transport.handleRequest(req, res);
          const sid = transport.sessionId;
          if (sid) transports.set(sid, transport);
          return;
        }

        res.status(400).json({ error: 'Bad request' });
      });

      app.get('/mcp', async (req: ExpressReq, res: ExpressRes) => {
        const sessionId =
          typeof req.headers['mcp-session-id'] === 'string'
            ? req.headers['mcp-session-id']
            : undefined;
        if (sessionId) {
          const transport = transports.get(sessionId);
          if (transport) {
            await transport.handleRequest(req, res);
            return;
          }
        }
        res.status(400).json({ error: 'No session' });
      });

      app.listen(httpPort, () => {
        process.stderr.write(`MCP HTTP server listening on port ${httpPort}\n`);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Failed to start HTTP server: ${msg}\n`);
      process.stderr.write(`Falling back to stdio transport.\n`);
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  }
}
