/**
 * Generic Claude bot harness — spawns `coga serve --bot-mode` subprocesses.
 *
 * Game-agnostic: the bot doesn't know what game it's playing until it
 * calls get_guide(). System prompt is generic, game rules come from the
 * server's MCP tools.
 *
 * Each bot gets a separate coga subprocess with an ephemeral private key.
 * The subprocess handles auth (challenge-response) and the client-side
 * plugin pipeline automatically.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

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
  key: string;               // Ephemeral private key (hex with 0x prefix)
  sessionId: string | null;  // Claude session ID for resume
  guideLoaded: boolean;      // Whether get_guide() has been called
}

// ---------------------------------------------------------------------------
// coga subprocess MCP config
// ---------------------------------------------------------------------------

const mcpServerName = 'game-server';

/**
 * Find the coga CLI binary — prefers the monorepo build, falls back to global.
 */
function getCogaPath(): string {
  const monorepoPath = path.resolve(__dirname, '../../cli/dist/index.cjs');
  try {
    fs.accessSync(monorepoPath);
    return monorepoPath;
  } catch {
    return 'coga'; // fall back to global install
  }
}

/**
 * Create an MCP stdio config that spawns a coga subprocess in bot mode.
 * Each bot gets an ephemeral private key for challenge-response auth.
 */
export function createBotMcpConfig(botName: string, key: string, serverUrl: string): McpStdioServerConfig {
  const cogaPath = getCogaPath();
  return {
    type: 'stdio',
    command: 'node',
    args: [cogaPath, 'serve', '--bot-mode', '--key', key, '--name', botName, '--server-url', serverUrl, '--stdio'],
  };
}

/**
 * Run a single Claude bot's turn using the Claude Agent SDK.
 * Spawns a coga subprocess via stdio MCP transport.
 */
export async function runClaudeBotTurn(
  bot: BotSession,
  turn: number,
  serverUrl: string,
): Promise<void> {
  const mcpConfig = createBotMcpConfig(bot.handle, bot.key, serverUrl);

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
 * Each bot gets an ephemeral private key for challenge-response auth.
 */
export function createBotSessions(
  bots: { id: string; handle: string; team: 'A' | 'B' }[],
): BotSession[] {
  return bots.map((b) => ({
    id: b.id,
    handle: b.handle,
    team: b.team,
    key: '0x' + crypto.randomBytes(32).toString('hex'),
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
