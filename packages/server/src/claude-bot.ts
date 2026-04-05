/**
 * Generic Claude bot harness — uses Agent SDK + GameClient.
 *
 * Bots get in-process MCP tools backed by GameClient (REST + pipeline).
 * Same code path as real players via CLI, just with server-issued tokens.
 * Uses Claude Agent SDK (local Claude subscription, no API key needed).
 */

import {
  query,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { GameClient } from './game-client.js';
import type { ToolPlugin } from '@coordination-games/engine';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const GENERIC_SYSTEM_PROMPT = `You are a competitive game-playing AI agent.

## Your First Turn
1. Call get_guide() to learn the game rules and available tools
2. Follow the guide's instructions exactly

## Every Turn After That
Follow the game loop described in the guide. Always:
- Check the game state
- Communicate with teammates (if team game)
- Submit your action

Be decisive and aggressive. You have limited time per turn. Always submit an action.`;

// ---------------------------------------------------------------------------
// Create in-process MCP server backed by GameClient
// ---------------------------------------------------------------------------

export function createBotMcpServer(client: GameClient, plugins: ToolPlugin[] = []) {
  // Core platform tools (always available)
  const coreTools = [
    tool('get_guide', 'Game rules, available tools, and your current status. Call this FIRST.', {},
      async () => jsonResult(await client.getGuide())),
    tool('get_state', 'Get current game/lobby state (fog-filtered).', {},
      async () => jsonResult(await client.getState())),
    tool('wait_for_update', 'YOUR MAIN LOOP — blocks until next event.', {},
      async () => jsonResult(await client.waitForUpdate())),
    tool('submit_move', 'Submit your move: direction array.', { path: z.array(z.string()).describe('e.g. ["N","NE"]') },
      async ({ path }) => jsonResult(await client.submitMove(path ?? []))),
    tool('list_lobbies', 'List available lobbies.', {},
      async () => jsonResult(await client.listLobbies())),
    tool('join_lobby', 'Join a lobby by ID.', { lobbyId: z.string() },
      async ({ lobbyId }) => jsonResult(await client.joinLobby(lobbyId))),
    tool('create_lobby', 'Create a new lobby.', { teamSize: z.number().min(2).max(6).optional() },
      async ({ teamSize }) => jsonResult(await client.createLobby(teamSize))),
    tool('propose_team', 'Invite another agent to your team by name.', { name: z.string().describe('Display name of the agent to invite') },
      async ({ name }) => jsonResult(await client.proposeTeam(name))),
    tool('accept_team', 'Accept a team invitation.', { teamId: z.string() },
      async ({ teamId }) => jsonResult(await client.acceptTeam(teamId))),
    tool('leave_team', 'Leave your current team.', {},
      async () => jsonResult(await client.leaveTeam())),
    tool('choose_class', 'Pick your unit class.', { class: z.enum(['rogue', 'knight', 'mage']) },
      async (args) => jsonResult(await client.chooseClass(args['class']))),
  ];

  // Plugin tools (mcpExpose: true only)
  const pluginTools = [];
  const mcpNames = new Set(coreTools.map((t: any) => t.name));
  for (const plugin of plugins) {
    for (const toolDef of plugin.tools ?? []) {
      if (!toolDef.mcpExpose) continue;
      if (mcpNames.has(toolDef.name)) {
        throw new Error(`MCP tool name collision: "${toolDef.name}" exposed by plugin "${plugin.id}" conflicts with existing tool.`);
      }
      mcpNames.add(toolDef.name);
      const pluginId = plugin.id;
      const toolName = toolDef.name;
      // Build zod schema from inputSchema
      const schema: Record<string, any> = {};
      for (const [key, prop] of Object.entries(toolDef.inputSchema?.properties ?? {}) as [string, any][]) {
        schema[key] = prop.type === 'number' ? z.number().describe(prop.description ?? '') : z.string().describe(prop.description ?? '');
      }
      pluginTools.push(
        tool(toolName, toolDef.description, schema,
          async (args) => jsonResult(await client.callPluginTool(pluginId, toolName, args))),
      );
    }
  }

  return createSdkMcpServer({
    name: 'game-server',
    version: '0.1.0',
    tools: [...coreTools, ...pluginTools],
  });
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

// ---------------------------------------------------------------------------
// Bot session management
// ---------------------------------------------------------------------------

export interface BotSession {
  id: string;
  handle: string;
  team: 'A' | 'B';
  client: GameClient;
  plugins: ToolPlugin[];
  sessionId: string | null;
  guideLoaded: boolean;
}

/**
 * Run a single Claude bot's turn using the Agent SDK.
 * Tools are backed by GameClient (REST + pipeline).
 */
export async function runClaudeBotTurn(
  bot: BotSession,
  turn: number,
): Promise<void> {
  const mcpServer = createBotMcpServer(bot.client, bot.plugins);
  const serverName = 'game-server';

  const prompt = turn === 1
    ? `Game starting! You are ${bot.handle} (${bot.id}, Team ${bot.team}). Call get_guide() first to learn the rules, then follow them.`
    : `Turn ${turn}. Follow your game loop: check state, communicate, submit your action.`;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30000);

  try {
    console.log(`[Bot ${bot.id}] Turn ${turn} | ${bot.sessionId ? 'RESUME' : 'NEW'}`);

    const q = query({
      prompt,
      options: {
        systemPrompt: GENERIC_SYSTEM_PROMPT,
        model: 'haiku',
        tools: [],
        mcpServers: { [serverName]: mcpServer },
        allowedTools: [`mcp__${serverName}__*`],
        maxTurns: 8,
        abortController,
        cwd: '/tmp',
        ...(bot.sessionId ? { resume: bot.sessionId } : { persistSession: true }),
      },
    });

    for await (const message of q) {
      if ('session_id' in message && (message as any).session_id && !bot.sessionId) {
        bot.sessionId = (message as any).session_id;
      }
    }

    if (!bot.guideLoaded && turn === 1) {
      bot.guideLoaded = true;
    }
  } catch (err: any) {
    const msg = err.message ?? String(err);
    if (err.name === 'AbortError' || msg.includes('abort')) {
      // Timeout — don't reset session
    } else {
      console.error(`Bot ${bot.id} error:`, msg);
      bot.sessionId = null;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Create bot sessions. Each bot gets a GameClient backed by a server-issued token.
 */
export function createBotSessions(
  bots: { id: string; handle: string; team: 'A' | 'B' }[],
  serverUrl: string,
  getToken: (id: string, handle: string) => string,
  plugins: ToolPlugin[] = [],
): BotSession[] {
  return bots.map((b) => ({
    id: b.id,
    handle: b.handle,
    team: b.team,
    client: new GameClient(serverUrl, { token: getToken(b.id, b.handle) }),
    plugins,
    sessionId: null,
    guideLoaded: false,
  }));
}

/**
 * Run all bots for a single turn in parallel.
 */
export async function runAllBotsTurn(
  sessions: BotSession[],
  turn: number,
  aliveBotIds?: Set<string>,
): Promise<void> {
  const active = aliveBotIds
    ? sessions.filter((bot) => aliveBotIds.has(bot.id))
    : sessions;

  await Promise.all(
    active.map((bot) =>
      runClaudeBotTurn(bot, turn).catch((err) => {
        console.error(`Bot ${bot.id} error:`, err.message ?? err);
      }),
    ),
  );
}
