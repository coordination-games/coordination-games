/**
 * Test: Can an MCP tool call stay open and send multiple elicitations
 * over several minutes (simulating a game)?
 *
 * Uses InMemoryTransport for simplicity — tests the protocol behavior,
 * not the HTTP transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const TURNS = 5;
const TURN_DELAY_MS = 3000; // 3 seconds per turn

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'elicitation-test',
  version: '0.1.0',
});

server.tool(
  'play_game',
  'Join a game.',
  { playerName: z.string() },
  async ({ playerName }, extra) => {
    console.log(`[Server] ${playerName} joined the game`);
    const results = [];

    for (let turn = 1; turn <= TURNS; turn++) {
      console.log(`[Server] Turn ${turn}/${TURNS} — sending elicitation...`);

      const elicitResult = await extra.sendRequest(
        {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: `Turn ${turn}/${TURNS}. Position: (${turn},${-turn}). What's your move?`,
            requestedSchema: {
              type: 'object',
              properties: {
                move: { type: 'string', title: 'Move', enum: ['N', 'NE', 'SE', 'S', 'SW', 'NW', 'HOLD'] },
                chat: { type: 'string', title: 'Chat' },
              },
              required: ['move'],
            },
          },
        },
        ElicitResultSchema,
      );

      if (elicitResult.action === 'accept') {
        console.log(`[Server] Move: ${elicitResult.content?.move}, Chat: "${elicitResult.content?.chat || ''}"`);
        results.push({ turn, move: elicitResult.content?.move });
      } else {
        console.log(`[Server] Player ${elicitResult.action} on turn ${turn}`);
        break;
      }

      if (turn < TURNS) {
        await new Promise(r => setTimeout(r, TURN_DELAY_MS));
      }
    }

    return {
      content: [{ type: 'text', text: `Game over. ${results.length} turns. Moves: ${JSON.stringify(results)}` }],
    };
  },
);

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const client = new Client(
  { name: 'test-agent', version: '0.1.0' },
  { capabilities: { elicitation: { form: {} } } },
);

let elicitationCount = 0;
client.setRequestHandler(ElicitRequestSchema, async (request) => {
  elicitationCount++;
  const params = request.params;
  console.log(`[Client] Elicitation #${elicitationCount}: ${params.message?.substring(0, 60)}...`);

  const moves = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];
  return {
    action: 'accept',
    content: {
      move: moves[elicitationCount % moves.length],
      chat: elicitationCount === 1 ? 'Heading north, cover me!' : '',
    },
  };
});

// ---------------------------------------------------------------------------
// Connect and run
// ---------------------------------------------------------------------------

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

await server.connect(serverTransport);
await client.connect(clientTransport);

console.log(`[Test] Connected. Starting play_game (${TURNS} turns, ${TURN_DELAY_MS}ms between turns)...\n`);
const startTime = Date.now();

try {
  const result = await client.callTool({ name: 'play_game', arguments: { playerName: 'TestBot' } });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[Result] Tool returned after ${elapsed}s:`);
  console.log(result.content?.[0]?.text);
  console.log(`\n✅ SUCCESS: ${elicitationCount} elicitations handled over ${elapsed}s`);
  console.log(`   Average: ${(elapsed / elicitationCount).toFixed(1)}s per elicitation`);
  console.log(`   Connection held open for the full duration ✓`);
} catch (err) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n❌ FAILED after ${elapsed}s:`, err.message);
}

await client.close();
process.exit(0);
