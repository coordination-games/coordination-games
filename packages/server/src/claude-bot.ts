/**
 * Generic Claude bot harness — connects via real MCP HTTP endpoint.
 *
 * Game-agnostic: the bot doesn't know what game it's playing until it
 * calls get_guide(). System prompt is generic, game rules come from the
 * server's MCP tools.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpHttpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const GENERIC_SYSTEM_PROMPT = `You are a competitive game-playing AI agent. You connect to a game server via MCP tools.

## Your First Turn
1. Call get_guide() to learn the game rules and available tools
2. Follow the guide's instructions exactly

## Every Turn After That
Follow the game loop described in the guide. Always:
- Check the game state
- Communicate with teammates (if team game)
- Submit your action

Be decisive and aggressive. You have limited time per turn. Always submit an action.`;

/**
 * Persistent bot session — maintains conversation history across turns.
 */
export interface BotSession {
  id: string;
  handle: string;
  team: 'A' | 'B';
  token: string;            // MCP auth token (pre-registered)
  sessionId: string | null; // Claude session ID for resume
  guideLoaded: boolean;     // Whether get_guide() has been called
}

/**
 * Run a single Claude bot's turn using the Claude Agent SDK.
 * Connects to the game server via the real MCP HTTP endpoint.
 */
export async function runClaudeBotTurn(
  bot: BotSession,
  turn: number,
  serverUrl: string,
): Promise<void> {
  const mcpServerName = 'game-server';
  const mcpConfig: McpHttpServerConfig = {
    type: 'http',
    url: serverUrl,
    headers: {
      'Authorization': `Bearer ${bot.token}`,
    },
  };

  const prompt = turn === 1
    ? `Game starting! You are ${bot.handle} (${bot.id}, Team ${bot.team}). First call get_guide() to learn the rules, then follow its instructions for your first turn.`
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
        mcpServers: { [mcpServerName]: mcpConfig },
        allowedTools: [`mcp__${mcpServerName}__*`],
        maxTurns: 8,
        abortController,
        cwd: '/tmp',
        // Resume existing session if we have one
        ...(bot.sessionId ? { resume: bot.sessionId } : { persistSession: true }),
      },
    });

    // Drain messages, capture session ID
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
    const isAbort = err.name === 'AbortError' || msg.includes('abort');
    if (isAbort) {
      // Don't reset session on timeout — it's still valid on disk
    } else {
      console.error(`Claude bot ${bot.id} error:`, msg);
      // Only reset session on real errors (corrupt session, etc.)
      bot.sessionId = null;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Create bot sessions for all players.
 * Each bot gets a pre-registered auth token.
 */
export function createBotSessions(
  bots: { id: string; handle: string; team: 'A' | 'B'; token: string }[],
): BotSession[] {
  return bots.map((b) => ({
    id: b.id,
    handle: b.handle,
    team: b.team,
    token: b.token,
    sessionId: null,
    guideLoaded: false,
  }));
}

/**
 * Run all Claude bots for a single turn in parallel.
 * Game-agnostic: doesn't check game state directly.
 * Pass `aliveBotIds` to skip dead/inactive bots.
 */
export async function runAllBotsTurn(
  sessions: BotSession[],
  turn: number,
  serverUrl: string,
  aliveBotIds?: Set<string>,
): Promise<void> {
  const activeSessions = aliveBotIds
    ? sessions.filter((bot) => aliveBotIds.has(bot.id))
    : sessions;

  const promises = activeSessions.map((bot) =>
    runClaudeBotTurn(bot, turn, serverUrl).catch(
      (err) => {
        console.error(`Claude bot ${bot.id} error:`, err.message ?? err);
      },
    ),
  );

  await Promise.all(promises);
}
