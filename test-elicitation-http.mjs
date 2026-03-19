/**
 * Test: Same elicitation loop but over Streamable HTTP transport.
 * Proves it works over the network, not just in-memory.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import http from 'http';
import crypto from 'node:crypto';

const PORT = 9877;
const TURNS = 5;
const TURN_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// HTTP Server with per-session MCP servers
// ---------------------------------------------------------------------------

const httpServer = http.createServer();
const sessions = new Map(); // sessionId -> { transport, server }

function createSessionServer() {
  const mcpServer = new McpServer({
    name: 'elicitation-http-test',
    version: '0.1.0',
  });

  mcpServer.tool(
    'play_game',
    'Join a game.',
    { playerName: z.string() },
    async ({ playerName }, extra) => {
      console.log(`[Server] ${playerName} joined`);
      const results = [];

      for (let turn = 1; turn <= TURNS; turn++) {
        console.log(`[Server] Turn ${turn}/${TURNS}`);

        const elicitResult = await extra.sendRequest(
          {
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: `Turn ${turn}/${TURNS}. Move?`,
              requestedSchema: {
                type: 'object',
                properties: {
                  move: { type: 'string', enum: ['N', 'NE', 'SE', 'S', 'SW', 'NW'] },
                },
                required: ['move'],
              },
            },
          },
          ElicitResultSchema,
        );

        if (elicitResult.action === 'accept') {
          console.log(`[Server] Move: ${elicitResult.content?.move}`);
          results.push({ turn, move: elicitResult.content?.move });
        } else break;

        if (turn < TURNS) await new Promise(r => setTimeout(r, TURN_DELAY_MS));
      }

      return { content: [{ type: 'text', text: `Done. ${results.length} turns.` }] };
    },
  );

  return mcpServer;
}

httpServer.on('request', async (req, res) => {
  if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }

  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId).transport.handleRequest(req, res);
    return;
  }

  // New session
  const mcpServer = createSessionServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await mcpServer.connect(transport);

  // After connect, we can get the session ID from the transport
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await transport.handleRequest(req, res);

  if (transport.sessionId) {
    sessions.set(transport.sessionId, { transport, server: mcpServer });
  }
});

httpServer.listen(PORT, () => {
  console.log(`[Server] Listening on http://localhost:${PORT}/mcp`);
  setTimeout(runClient, 500);
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

async function runClient() {
  const client = new Client(
    { name: 'test-http-agent', version: '0.1.0' },
    { capabilities: { elicitation: { form: {} } } },
  );

  let count = 0;
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    count++;
    console.log(`[Client] Elicitation #${count}`);
    const moves = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];
    return { action: 'accept', content: { move: moves[count % moves.length] } };
  });

  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
  await client.connect(transport);
  console.log('[Client] Connected via HTTP');

  const start = Date.now();
  try {
    const result = await client.callTool({ name: 'play_game', arguments: { playerName: 'HTTPBot' } });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n✅ HTTP SUCCESS: ${count} elicitations over ${elapsed}s`);
    console.log(result.content?.[0]?.text);
  } catch (err) {
    console.error(`\n❌ HTTP FAILED:`, err.message);
  }

  await client.close();
  httpServer.close();
  process.exit(0);
}
