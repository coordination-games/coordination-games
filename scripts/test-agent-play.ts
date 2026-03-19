/**
 * Test: spawn a Claude agent that plays Capture the Lobster
 * via the external MCP endpoint. Uses a polling loop — each iteration
 * sends a new prompt to the agent based on the current game phase.
 */

import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:5173';

async function main() {
  // 1. Create a lobby with an external slot
  console.log('Creating lobby...');
  const lobbyRes = await fetch(`${SERVER_URL}/api/lobbies/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamSize: 2, externalSlots: 1 }),
  });
  const { lobbyId } = await lobbyRes.json() as any;
  console.log(`Lobby created: ${lobbyId}`);

  // 2. Register as external agent
  console.log('Registering...');
  const regRes = await fetch(`${SERVER_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId }),
  });
  const { token, agentId } = await regRes.json() as any;
  console.log(`Registered as ${agentId}, token: ${token}\n`);

  // 3. MCP HTTP session
  let mcpSessionId: string | null = null;

  async function mcpCall(toolName: string, args: Record<string, any>): Promise<string> {
    if (!mcpSessionId) {
      const initRes = await fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 0, method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-agent', version: '0.1' } },
        }),
      });
      mcpSessionId = initRes.headers.get('mcp-session-id') || 'default';
      await initRes.text(); // drain
    }

    const res = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${token}`,
        ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Math.floor(Math.random() * 10000),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });

    const text = await res.text();
    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    if (dataLine) {
      const json = JSON.parse(dataLine.slice(6));
      if (json.result?.content?.[0]?.text) return json.result.content[0].text;
      if (json.error) return JSON.stringify(json.error);
    }
    return text;
  }

  // 4. Create wrapper MCP server for the SDK agent
  const mcpServer = createSdkMcpServer({
    name: 'lobster-game',
    version: '0.1.0',
    tools: [
      tool('get_lobby', 'Get the current lobby state', {}, async () => {
        return { content: [{ type: 'text' as const, text: await mcpCall('get_lobby', {}) }] };
      }),
      tool('lobby_chat', 'Send a message to the lobby', { message: z.string() }, async ({ message }) => {
        return { content: [{ type: 'text' as const, text: await mcpCall('lobby_chat', { message }) }] };
      }),
      tool('propose_team', 'Invite an agent to your team', { agentId: z.string() }, async ({ agentId: tid }) => {
        return { content: [{ type: 'text' as const, text: await mcpCall('propose_team', { agentId: tid }) }] };
      }),
      tool('accept_team', 'Accept a team invitation', { teamId: z.string() }, async ({ teamId }) => {
        return { content: [{ type: 'text' as const, text: await mcpCall('accept_team', { teamId }) }] };
      }),
      tool('get_team_state', 'Get your team composition', {}, async () => {
        return { content: [{ type: 'text' as const, text: await mcpCall('get_team_state', {}) }] };
      }),
      tool('choose_class', 'Pick your class', { unitClass: z.enum(['rogue', 'knight', 'mage']) }, async ({ unitClass }) => {
        return { content: [{ type: 'text' as const, text: await mcpCall('choose_class', { class: unitClass }) }] };
      }),
      tool('team_chat', 'Send a message to your team', { message: z.string() }, async ({ message }) => {
        return { content: [{ type: 'text' as const, text: await mcpCall('team_chat', { message }) }] };
      }),
      tool('get_game_state', 'Get the game state from your perspective', {}, async () => {
        return { content: [{ type: 'text' as const, text: await mcpCall('get_game_state', {}) }] };
      }),
      tool('submit_move', 'Submit your movement path', { path: z.array(z.string()) }, async ({ path }) => {
        return { content: [{ type: 'text' as const, text: await mcpCall('submit_move', { path }) }] };
      }),
    ],
  });

  const allTools = [
    'mcp__lobster-game__get_lobby', 'mcp__lobster-game__lobby_chat',
    'mcp__lobster-game__propose_team', 'mcp__lobster-game__accept_team',
    'mcp__lobster-game__get_team_state', 'mcp__lobster-game__choose_class',
    'mcp__lobster-game__team_chat', 'mcp__lobster-game__get_game_state',
    'mcp__lobster-game__submit_move',
  ];

  // Helper to run a single agent turn
  async function runAgentTurn(prompt: string, maxTurns = 8): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 25000);

    try {
      const q = query({
        prompt,
        options: {
          model: 'haiku',
          tools: [],
          mcpServers: { 'lobster-game': mcpServer },
          allowedTools: allTools,
          maxTurns,
          persistSession: false,
          cwd: '/tmp',
          abortController,
        },
      });

      for await (const msg of q) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') console.log(`[Agent]: ${block.text}`);
            else if (block.type === 'tool_use') console.log(`[Tool]: ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`);
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') console.error(`[Error]: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ==================== LOBBY PHASE ====================
  console.log('=== LOBBY PHASE ===\n');

  for (let round = 0; round < 6; round++) {
    const lobbyState = await mcpCall('get_lobby', {});
    const lobby = JSON.parse(lobbyState);

    // Check if we've moved past lobby
    if (lobby.phase === 'pre_game' || lobby.phase === 'game') {
      console.log(`\nLobby phase complete! Moving to ${lobby.phase}\n`);
      break;
    }

    const prompt = round === 0
      ? `You are playing "Capture the Lobster" — a team-based CTF game for AI agents.

You just joined a lobby. Your agent ID is ${agentId}. Here's the current lobby state:
${lobbyState}

Introduce yourself in lobby_chat, then propose_team with one of the other agents. Pick the agent with the highest ELO. If someone already proposed to you, use accept_team to join their team. Be direct — don't waste time.`
      : `Lobby update — here's the current state:
${lobbyState}

Check if your team proposals were accepted. If you're still solo, try proposing to a different agent. If you're on a team, great — wait for the game to start. Keep chatting to coordinate.`;

    await runAgentTurn(prompt, 5);
    await new Promise(r => setTimeout(r, 3000)); // Wait for bots to catch up
  }

  // ==================== PRE-GAME PHASE ====================
  console.log('=== PRE-GAME PHASE ===\n');

  for (let round = 0; round < 3; round++) {
    const teamState = await mcpCall('get_team_state', {});
    const team = JSON.parse(teamState);

    // Check if game started
    if (team.error?.includes('game') || team.phase === 'game') break;

    const gameState = await mcpCall('get_game_state', {});
    if (!gameState.includes('error')) {
      console.log('Game started! Moving to game phase.\n');
      break;
    }

    const prompt = round === 0
      ? `Pre-game! Your team:
${teamState}

Discuss class composition with team_chat. For a 2v2, a good combo is Rogue + Knight.
Then choose_class. Pick a class that complements your teammate. Be strategic!`
      : `Pre-game update:
${teamState}

Make sure you've chosen a class. If your teammate hasn't, remind them via team_chat.`;

    await runAgentTurn(prompt, 5);
    await new Promise(r => setTimeout(r, 5000));
  }

  // ==================== GAME PHASE ====================
  console.log('=== GAME PHASE ===\n');

  let lastTurn = -1;
  let gameOver = false;

  for (let iter = 0; iter < 35; iter++) {
    // Check game state
    const stateStr = await mcpCall('get_game_state', {});

    if (stateStr.includes('No game in progress') || stateStr.includes('not started')) {
      console.log('Waiting for game to start...');
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    let state: any;
    try {
      state = JSON.parse(stateStr);
    } catch {
      console.log('Unexpected response:', stateStr.slice(0, 100));
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    if (state.winner !== undefined && state.winner !== null) {
      console.log(`\n🦞 GAME OVER! Winner: Team ${state.winner}\n`);
      gameOver = true;
      break;
    }

    if (state.phase === 'finished') {
      console.log(`\n🦞 GAME OVER! ${state.winner ? 'Winner: Team ' + state.winner : 'Draw!'}\n`);
      gameOver = true;
      break;
    }

    const turn = state.turn ?? 0;
    if (turn === lastTurn) {
      // Same turn — wait for it to resolve
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    lastTurn = turn;

    const moveSubmitted = state.moveSubmitted || false;
    if (moveSubmitted) {
      console.log(`Turn ${turn}: move already submitted, waiting...`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    console.log(`\n--- Turn ${turn} ---`);

    const prompt = `Capture the Lobster — Turn ${turn}.

You are ${agentId} (${state.yourUnit?.unitClass}, Team ${state.yourUnit?.team}).
Position: (${state.yourUnit?.position?.q}, ${state.yourUnit?.position?.r})
Alive: ${state.yourUnit?.alive}
Carrying flag: ${state.yourUnit?.carryingFlag}

Game state:
${stateStr}

IMPORTANT:
1. First, use team_chat to tell your teammate what you see and your plan
2. Then use submit_move with your movement path (array of directions: N/NE/SE/S/SW/NW)
   - Rogue: up to 3 steps, Knight: up to 2, Mage: up to 1
   - Move toward the enemy flag to capture it, or defend your own flag
   - Avoid enemies that counter your class!

Submit your move NOW. Be decisive.`;

    await runAgentTurn(prompt, 5);
    await new Promise(r => setTimeout(r, 3000)); // Wait for turn to resolve
  }

  if (!gameOver) {
    console.log('\nMax iterations reached.');
  }

  console.log('\nDone!');
}

main().catch(console.error);
