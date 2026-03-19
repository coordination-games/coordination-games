/**
 * Test: Connect as an external agent and play the game via MCP tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const SERVER_URL = 'http://localhost:5174/mcp';
const TOKEN = process.argv[2];

if (!TOKEN) {
  console.error('Usage: node test-play.mjs <token>');
  process.exit(1);
}

async function main() {
  const client = new Client(
    { name: 'test-external-agent', version: '0.1.0' },
  );

  const transport = new StreamableHTTPClientTransport(
    new URL(SERVER_URL),
    { requestInit: { headers: { 'Authorization': `Bearer ${TOKEN}` } } },
  );

  console.log('Connecting to MCP server...');
  await client.connect(transport);
  console.log('Connected!');

  // List available tools
  const tools = await client.listTools();
  console.log('\nAvailable tools:', tools.tools.map(t => t.name).join(', '));

  // Get lobby state
  console.log('\nCalling get_lobby...');
  const lobbyResult = await client.callTool({ name: 'get_lobby', arguments: {} });
  console.log('Lobby state:', lobbyResult.content?.[0]?.text?.substring(0, 200));

  // Send a chat message
  console.log('\nSending lobby chat...');
  const chatResult = await client.callTool({
    name: 'lobby_chat',
    arguments: { message: 'Hey everyone! External agent here, ready to play!' }
  });
  console.log('Chat result:', chatResult.content?.[0]?.text);

  // Check lobby again
  console.log('\nChecking lobby again...');
  const lobby2 = await client.callTool({ name: 'get_lobby', arguments: {} });
  const lobbyData = JSON.parse(lobby2.content?.[0]?.text ?? '{}');
  console.log('Agents:', lobbyData.agents?.length, 'Teams:', Object.keys(lobbyData.teams || {}).length);
  console.log('Chat messages:', lobbyData.chat?.length);

  // Game loop — poll for game state
  console.log('\nWaiting for game to start (polling every 3s)...');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));

    try {
      const stateResult = await client.callTool({ name: 'get_game_state', arguments: {} });
      const stateText = stateResult.content?.[0]?.text ?? '';

      if (stateText.includes('error') || stateText.includes('No game')) {
        process.stdout.write('.');
        continue;
      }

      const state = JSON.parse(stateText);
      console.log(`\n\nGame started! Turn ${state.turn}, I'm at (${state.yourUnit?.position?.q},${state.yourUnit?.position?.r})`);
      console.log(`Class: ${state.yourUnit?.unitClass}, Alive: ${state.yourUnit?.alive}`);
      console.log(`Visible tiles: ${state.visibleTiles?.length}`);

      // Submit a move
      const dirs = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];
      const move = dirs[state.turn % dirs.length];

      console.log(`Submitting move: ${move}`);
      const moveResult = await client.callTool({
        name: 'submit_move',
        arguments: { path: [move] }
      });
      console.log('Move result:', moveResult.content?.[0]?.text);

      // Chat
      await client.callTool({
        name: 'team_chat',
        arguments: { message: `Turn ${state.turn}: Moving ${move}!` }
      });

      if (state.phase === 'finished') {
        console.log('Game over!');
        break;
      }
    } catch (err) {
      process.stdout.write('x');
    }
  }

  await client.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
