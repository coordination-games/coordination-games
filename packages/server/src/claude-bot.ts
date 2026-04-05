import {
  query,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  Direction,
  UnitClass,
} from '@coordination-games/game-ctl';
import type { CtlSession } from './game-session.js';
import { getStateForAgent, submitCtlMove } from './game-session.js';
import type { GameRelay } from './typed-relay.js';

const VALID_DIRECTIONS: Direction[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];

const SYSTEM_PROMPT = `You are competing in Capture the Lobster, a team-based capture-the-flag game for AI agents on a hex grid.

## Game Rules
- Hex grid with fog of war. You can only see tiles within your vision radius.
- Two teams (A and B). Capture the enemy flag (the lobster) and bring it to YOUR base to win.
- Three classes: Rogue (speed 3, vision 4, beats mage), Knight (speed 2, vision 2, beats rogue), Mage (speed 1, vision 3, range 2, beats knight). Rock-paper-scissors combat.
- Combat is adjacent (distance 1) for rogue/knight, range 2 for mage. If an enemy that beats your class is adjacent to your final position, you die.
- On death: respawn at base next turn, flag returns to enemy base if you were carrying it.
- Turns are simultaneous — everyone moves at the same time.
- First team to capture the enemy flag wins. 30-turn limit, then draw.

## Hex Grid
Flat-top hexagons with axial coordinates (q, r). (0,0) is the map center. Coordinates are absolute — all players share the same coordinate system. Valid directions: N, NE, SE, S, SW, NW (no E/W).

## Strategy Tips
- COMMUNICATE with chat. Your teammates can't see what you see.
- Rogues are flag runners — fast, grab the flag and run home.
- Knights guard — chase rogues, protect your flag.
- Mages control space — ranged kills on knights, stay away from rogues.
- Coordinate! Tell your team what you see, what you're doing, and what you need.
- Remember what happened in previous turns! Use that knowledge to adapt.

## Each Turn — ALWAYS do all 3 steps
1. get_state — see the board
2. chat — ALWAYS send a message. Share enemy positions, your plan, flag status. Your teammate is blind without your intel.
3. submit_move — your movement path

NEVER skip chat. Even "heading north, no enemies visible" is valuable. Your teammate literally cannot see what you see.

You have 30 SECONDS per turn. Be decisive and aggressive. Always submit a move.`;

/**
 * Create an MCP server with game tools scoped to a specific agent.
 */
function createGameMcpServer(game: CtlSession, agentId: string, relay?: GameRelay) {
  return createSdkMcpServer({
    name: `lobster-${agentId}`,
    version: '0.1.0',
    tools: [
      tool(
        'get_state',
        'Get the current game state from your perspective. Shows your unit info, visible tiles (fog of war applied), flag statuses, recent team messages, and score.',
        {},
        async () => {
          try {
            const state = getStateForAgent(game, agentId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(state) }] };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
          }
        },
      ),
      tool(
        'submit_move',
        'Submit your movement path for this turn. Provide an array of direction strings. Valid directions: N, NE, SE, S, SW, NW. Max path length = your class speed (rogue=3, knight=2, mage=1). Empty array to stay put.',
        { path: z.array(z.string()).describe('Array of directions, e.g. ["N", "NE"]') },
        async ({ path }) => {
          const directions = (path ?? []).filter((d: string): d is Direction =>
            VALID_DIRECTIONS.includes(d as Direction),
          );
          const result = submitCtlMove(game, agentId, directions);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'chat',
        'Send a message to your teammates. They cannot see what you see — share intel about enemy positions, flag location, and your plan.',
        { message: z.string().describe('Message to send to your team') },
        async ({ message }) => {
          if (relay) {
            relay.send(agentId, game.state.turn, { type: 'messaging', data: { body: message }, scope: 'team', pluginId: 'basic-chat' });
          }
          const recentMessages = relay ? relay.getSpectatorMessages(game.state.turn).filter(m => m.type === 'messaging').slice(-10).map(m => ({ from: m.sender, message: (m.data as { body?: string })?.body ?? '', turn: m.turn })) : [];
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, recentMessages }) }] };
        },
      ),
    ],
  });
}

/**
 * Persistent bot session — maintains conversation history across turns.
 */
export interface BotSession {
  id: string;
  unitClass: UnitClass;
  team: 'A' | 'B';
  sessionId: string | null;  // Claude session ID for resume
}

/**
 * Run a single Claude bot's turn using the Claude Agent SDK.
 * If the bot has a sessionId, resumes the existing conversation.
 */
export async function runClaudeBotTurn(
  game: CtlSession,
  bot: BotSession,
  turn: number,
  relay?: GameRelay,
): Promise<void> {
  const mcpServer = createGameMcpServer(game, bot.id, relay);
  const serverName = `lobster-${bot.id}`;

  const prompt = turn === 1
    ? `Game starting! You are ${bot.id} (${bot.unitClass}, Team ${bot.team}). Do these 3 things in order: 1) get_state 2) chat to tell your teammate what you see and your plan 3) submit_move`
    : `Turn ${turn}. Do these 3 things in order: 1) get_state 2) chat what you see and your plan 3) submit_move`;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30000);

  try {
    console.log(`[Bot ${bot.id}] Turn ${turn} | ${bot.sessionId ? 'RESUME' : 'NEW'}`);

    const q = query({
      prompt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: 'haiku',
        tools: [],
        mcpServers: { [serverName]: mcpServer },
        allowedTools: [
          `mcp__${serverName}__get_state`,
          `mcp__${serverName}__submit_move`,
          `mcp__${serverName}__chat`,
        ],
        maxTurns: 5,
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
 */
export function createBotSessions(
  bots: { id: string; unitClass: UnitClass; team: 'A' | 'B' }[],
): BotSession[] {
  return bots.map((b) => ({
    id: b.id,
    unitClass: b.unitClass,
    team: b.team,
    sessionId: null,
  }));
}

/**
 * Run all Claude bots for a single turn in parallel.
 */
export async function runAllBotsTurn(
  game: CtlSession,
  sessions: BotSession[],
  turn: number,
  relay?: GameRelay,
): Promise<void> {
  const aliveSessions = sessions.filter((bot) => {
    const unit = game.state.units.find((u: { id: string }) => u.id === bot.id);
    return unit && unit.alive;
  });

  const promises = aliveSessions.map((bot) =>
    runClaudeBotTurn(game, bot, turn, relay).catch(
      (err) => {
        console.error(`Claude bot ${bot.id} error:`, err.message ?? err);
      },
    ),
  );

  await Promise.all(promises);

  // Submit empty moves for any bots that didn't submit (timeout/error/dead)
  for (const bot of sessions) {
    if (!game.hasSubmitted(bot.id)) {
      const unit = game.state.units.find((u: { id: string }) => u.id === bot.id);
      if (unit?.alive) submitCtlMove(game, bot.id, []);
    }
  }
}
