import {
  query,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  GameManager,
  Direction,
  UnitClass,
} from '@lobster/engine';

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

## Hex Directions
The grid uses flat-top hexagons. Valid directions: N, NE, SE, S, SW, NW (no E/W).

## Strategy Tips
- COMMUNICATE with team_chat. Your teammates can't see what you see.
- Rogues are flag runners — fast, grab the flag and run home.
- Knights guard — chase rogues, protect your flag.
- Mages control space — ranged kills on knights, stay away from rogues.
- Coordinate! Tell your team what you see, what you're doing, and what you need.
- Remember what happened in previous turns! Use that knowledge to adapt.

## Each Turn
1. Use get_game_state to see the board from your perspective
2. Send a team_chat message sharing what you see and your plan
3. Use submit_move with your movement path (array of directions)

Be decisive and aggressive. Don't waste turns. Always submit a move.`;

/**
 * Create an MCP server with game tools scoped to a specific agent.
 */
function createGameMcpServer(game: GameManager, agentId: string) {
  return createSdkMcpServer({
    name: `lobster-${agentId}`,
    version: '0.1.0',
    tools: [
      tool(
        'get_game_state',
        'Get the current game state from your perspective. Shows your unit info, visible tiles (fog of war applied), flag statuses, recent team messages, and score.',
        {},
        async () => {
          try {
            const state = game.getStateForAgent(agentId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }] };
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
          const result = game.submitMove(agentId, directions);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'team_chat',
        'Send a message to your teammates. They cannot see what you see — share intel about enemy positions, flag location, and your plan.',
        { message: z.string().describe('Message to send to your team') },
        async ({ message }) => {
          game.submitChat(agentId, message);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
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
  game: GameManager,
  bot: BotSession,
  turn: number,
): Promise<void> {
  const mcpServer = createGameMcpServer(game, bot.id);
  const serverName = `lobster-${bot.id}`;

  const prompt = turn === 1
    ? `Game starting! You are ${bot.id} (${bot.unitClass}, Team ${bot.team}). Check the board and make your first move. Communicate with your team!`
    : `Turn ${turn}. Check the board, coordinate with your team, and submit your move.`;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 15000);

  try {
    const q = query({
      prompt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: 'haiku',
        tools: [],
        mcpServers: { [serverName]: mcpServer },
        allowedTools: [
          `mcp__${serverName}__get_game_state`,
          `mcp__${serverName}__submit_move`,
          `mcp__${serverName}__team_chat`,
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
      if ('session_id' in message && message.session_id && !bot.sessionId) {
        bot.sessionId = message.session_id;
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.error(`Claude bot ${bot.id} error:`, err.message ?? err);
      // If session is corrupt, reset it
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
  game: GameManager,
  sessions: BotSession[],
  turn: number,
): Promise<void> {
  const aliveSessions = sessions.filter((bot) => {
    const unit = game.units.find((u) => u.id === bot.id);
    return unit && unit.alive;
  });

  const promises = aliveSessions.map((bot) =>
    runClaudeBotTurn(game, bot, turn).catch(
      (err) => {
        console.error(`Claude bot ${bot.id} error:`, err.message ?? err);
      },
    ),
  );

  await Promise.all(promises);

  // Submit empty moves for any bots that didn't submit (timeout/error/dead)
  for (const bot of sessions) {
    if (!game.moveSubmissions.has(bot.id)) {
      const unit = game.units.find((u) => u.id === bot.id);
      if (unit?.alive) game.submitMove(bot.id, []);
    }
  }
}
