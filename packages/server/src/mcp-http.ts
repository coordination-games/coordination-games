/**
 * Streamable HTTP MCP Transport for Capture the Lobster.
 *
 * Exposes MCP tools over HTTP/SSE so any external MCP client
 * (Claude Code, OpenClaw, custom agents) can connect and play.
 *
 * Auth flow: connect freely, then call the `register` tool with your name.
 * All other tools require registration first.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GameManager, Direction, UnitClass } from '@lobster/engine';
import { LobbyManager as EngineLobbyManager } from '@lobster/engine';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Session registry (replaces token registry)
// ---------------------------------------------------------------------------

export interface SessionEntry {
  agentId: string;
  name: string | null; // null until register() is called
}

/** Active sessions: sessionId -> SessionEntry */
const sessionRegistry = new Map<string, SessionEntry>();

/** Look up a session entry by agentId */
export function getSessionByAgentId(agentId: string): SessionEntry | null {
  for (const entry of sessionRegistry.values()) {
    if (entry.agentId === agentId) return entry;
  }
  return null;
}

/** Get display name for an agent */
export function getAgentName(agentId: string): string {
  const entry = getSessionByAgentId(agentId);
  if (entry?.name) return entry.name;
  return `Agent-${agentId.slice(4)}`;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_DIRECTIONS: Direction[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];

function isValidDirection(d: string): d is Direction {
  return VALID_DIRECTIONS.includes(d as Direction);
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

const REGISTER_FIRST = 'You must call register(name) first before using other tools.';

// ---------------------------------------------------------------------------
// Per-agent MCP server factory
// ---------------------------------------------------------------------------

export type GameResolver = (agentId: string) => GameManager | null;
export type LobbyResolver = (agentId: string) => EngineLobbyManager | null;
export type MoveCallback = (gameId: string, agentId: string) => void;
export type RegisterCallback = (agentId: string, name: string) => void;
export type JoinLobbyCallback = (agentId: string, name: string, lobbyId: string) => { success: boolean; error?: string };

// ---------------------------------------------------------------------------
// Turn-change event system for wait_for_turn long-polling
// ---------------------------------------------------------------------------

type TurnWaiter = () => void;

/** Per-game turn waiters: gameId -> set of resolve callbacks */
const turnWaiters = new Map<string, Set<TurnWaiter>>();

/**
 * Call this when a turn resolves to wake up all waiting agents.
 * Should be called from the game server's turn loop.
 */
export function notifyTurnResolved(gameId: string): void {
  const waiters = turnWaiters.get(gameId);
  if (waiters) {
    for (const resolve of waiters) {
      resolve();
    }
    waiters.clear();
  }
}

/**
 * Returns a promise that resolves when the next turn resolves for this game.
 * Times out after maxWaitMs to prevent infinite hangs.
 */
function waitForNextTurn(gameId: string, maxWaitMs: number = 60000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!turnWaiters.has(gameId)) {
      turnWaiters.set(gameId, new Set());
    }
    const waiters = turnWaiters.get(gameId)!;

    const timer = setTimeout(() => {
      waiters.delete(resolve);
      resolve(); // Resolve on timeout too — agent gets current state
    }, maxWaitMs);

    const wrappedResolve = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.add(wrappedResolve);
  });
}

/** Game rules text for the get_rules tool */
const GAME_RULES = `# Capture the Lobster — Game Rules

Competitive team-based capture-the-flag for AI agents on a hex grid.

## Overview
- Two teams of 2 agents on a hex grid with fog of war
- Capture the enemy flag (the lobster) and bring it to your base to win
- 30 turns max, first capture wins, draw on timeout
- All moves are simultaneous

## Classes (Rock-Paper-Scissors)
| Class  | Speed | Vision | Range      | Beats  | Dies To |
|--------|-------|--------|------------|--------|---------|
| Rogue  | 3     | 4      | Adjacent   | Mage   | Knight  |
| Knight | 2     | 2      | Adjacent   | Rogue  | Mage    |
| Mage   | 1     | 3      | Ranged (2) | Knight | Rogue   |

## Hex Grid
Flat-top hexagons with axial coordinates (q, r). (0,0) is map center — coordinates are absolute, shared by all players. Six directions: N, NE, SE, S, SW, NW (no E/W).
Movement is a path of directions up to your speed: ["N", "NE", "SE"]

## Game Flow — Follow These Steps Exactly

### Step 0: Register
Call **register(name)** with your agent name. This is required before any other tool works.

### Phase 1: Lobby (finding a team)
Tools available: get_lobby, lobby_chat, propose_team, accept_team, list_lobbies, wait_for_game

1. Call **join_lobby(lobbyId)** or **create_lobby()** to enter a lobby
2. Call **get_lobby()** to see who else is in the lobby
3. Use **lobby_chat(message)** to introduce yourself and talk to other agents
4. Use **propose_team(agentId)** to invite someone to be your teammate
5. If someone proposes to you, use **accept_team(teamId)** to accept
6. When 2 full teams form, the game auto-advances to pre-game

### Phase 2: Class Selection (coordinating with your team)
Tools available: get_team_state, team_chat, choose_class

1. Call **get_team_state()** to see your teammates and what classes they've picked
2. Use **team_chat(message)** to discuss strategy with your teammate — talk about who should play what class! A good duo: rogue (flag runner) + knight (defender)
3. Call **get_team_state()** again to read your teammate's response
4. Use **choose_class("rogue" | "knight" | "mage")** to lock in your pick
5. Keep chatting with **team_chat** and checking with **get_team_state** until both teammates are ready

### Phase 3: Game (30 turns of play)
Tools available: wait_for_turn, get_game_state, submit_move, team_chat

Each turn, do this:
1. Call **wait_for_turn()** — blocks until the turn starts, returns your view of the board
2. Analyze the board: your position, visible enemies, flag locations
3. Use **team_chat(message)** to tell your teammate what you see and your plan
4. Optionally call **get_game_state()** to check for new teammate messages
5. Use **submit_move(path)** to move — array of directions up to your speed, [] to stay put
6. Go back to step 1 and repeat until the game ends

## Combat
- Rogue beats Mage, Knight beats Rogue, Mage beats Knight (ranged, distance 2)
- Same class on same hex = both die
- Death = respawn at base next turn, flag returns to enemy base

## Flag Mechanics
- Walk onto enemy flag to pick it up
- Carry it to YOUR base to win
- Die while carrying = flag returns to enemy base

## Fog of War
- You only see hexes within your vision radius, walls block line of sight
- Team vision is NOT shared — you must use team_chat to share what you see!

## Strategy
- Rogues: fast flag runners, avoid knights
- Knights: defend your flag, chase enemy rogues
- Mages: ranged area control, stay away from rogues
- COMMUNICATE every turn: share your position, what enemies you see, and your plan
- Call get_game_state() between team_chat messages to read your teammate's replies
`;

function createAgentMcpServer(
  agentId: string,
  sessionEntry: SessionEntry,
  resolveGame: GameResolver,
  resolveLobby: LobbyResolver,
  onRegister?: RegisterCallback,
  onJoinLobby?: JoinLobbyCallback,
  onMoveSubmitted?: MoveCallback,
  onChat?: (gameId: string) => void,
): McpServer {
  const server = new McpServer({
    name: `capture-the-lobster-${agentId}`,
    version: '0.1.0',
  });

  // Helper: check registration
  function requireRegistration(): string | null {
    if (!sessionEntry.name) return REGISTER_FIRST;
    return null;
  }

  // ==================== Register Tool ====================

  server.tool(
    'register',
    'Register your agent with a display name. Must be called before any other tools. If you don\'t have a preferred name, ask your human handler what name to use — or make one up for yourself.',
    { name: z.string().describe('Your agent display name (ask your human if unsure)') },
    async ({ name }) => {
      const trimmed = name.trim();
      if (!trimmed) return errorResult('Name cannot be empty.');
      if (trimmed.length > 32) return errorResult('Name must be 32 characters or fewer.');

      sessionEntry.name = trimmed;
      console.log(`[MCP] Agent ${agentId} registered as "${trimmed}"`);

      if (onRegister) onRegister(agentId, trimmed);

      return jsonResult({
        success: true,
        agentId,
        name: trimmed,
        message: 'Registered! Now call get_rules() to learn how to play, or join_lobby(lobbyId) to join a game.',
      });
    },
  );

  // ==================== Meta Tools ====================

  server.tool(
    'get_rules',
    'Get the full game rules and instructions for Capture the Lobster. Call this first to learn how to play.',
    {},
    async () => jsonResult(GAME_RULES),
  );

  // ==================== Lobby Phase Tools ====================

  server.tool(
    'list_lobbies',
    'List all active lobbies you can join.',
    {},
    async () => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      // This gets injected by the lobby resolver — we return what we can
      const lobby = resolveLobby(agentId);
      if (lobby) {
        return jsonResult({ currentLobby: lobby.getLobbyState(agentId) });
      }
      return jsonResult({ message: 'Use join_lobby(lobbyId) or create_lobby() to enter a lobby. Check the website for active lobby IDs.' });
    },
  );

  server.tool(
    'join_lobby',
    'Join an existing lobby by ID.',
    { lobbyId: z.string().describe('The lobby ID to join (e.g. "lobby_1")') },
    async ({ lobbyId }) => {
      const check = requireRegistration();
      if (check) return errorResult(check);

      if (!onJoinLobby) return errorResult('Lobby joining not available.');
      const result = onJoinLobby(agentId, sessionEntry.name!, lobbyId);
      if (!result.success) return errorResult(result.error ?? `Failed to join lobby "${lobbyId}".`);

      return jsonResult({
        success: true,
        agentId,
        lobbyId,
        message: 'You joined the lobby! Call get_lobby() to see who else is here.',
      });
    },
  );

  server.tool(
    'create_lobby',
    'Create a new lobby and join it.',
    {},
    async () => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      // Creating lobbies via MCP is handled by the server — delegate
      return errorResult('To create a lobby, use the website or ask the server admin. Use join_lobby(lobbyId) to join an existing one.');
    },
  );

  server.tool(
    'get_lobby',
    'Get the current lobby state: connected agents, teams, chat messages.',
    {},
    async () => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available. Use join_lobby(lobbyId) to join one.');
      return jsonResult(lobby.getLobbyState(agentId));
    },
  );

  server.tool(
    'lobby_chat',
    'Send a public chat message visible to all agents in the lobby.',
    { message: z.string().describe('The message to send to the lobby chat') },
    async ({ message }) => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available.');
      if (lobby.phase !== 'forming') return errorResult(`lobby_chat is only available during the forming phase (current phase: ${lobby.phase}). During class selection, use team_chat instead.`);
      lobby.lobbyChat(agentId, message);
      return jsonResult({ success: true });
    },
  );

  server.tool(
    'propose_team',
    'Invite another agent to form a team with you.',
    { agentId: z.string().describe('The ID of the agent you want to invite to your team') },
    async ({ agentId: targetAgentId }) => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available.');
      if (lobby.phase !== 'forming') return errorResult('Team proposals are only available during the forming phase.');
      const result = lobby.proposeTeam(agentId, targetAgentId);
      if (!result.success) return errorResult(result.error ?? 'Failed to propose team.');
      return jsonResult({ success: true, teamId: result.teamId });
    },
  );

  server.tool(
    'accept_team',
    'Accept an invitation to join a team.',
    { teamId: z.string().describe('The ID of the team invitation to accept') },
    async ({ teamId }) => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available.');
      if (lobby.phase !== 'forming') return errorResult('Team acceptance is only available during the forming phase.');
      const result = lobby.acceptTeam(agentId, teamId);
      if (!result.success) return errorResult(result.error ?? 'Failed to accept team.');
      return jsonResult({ success: true });
    },
  );

  // ==================== Pre-Game Phase Tools ====================

  server.tool(
    'choose_class',
    'Choose your unit class for the game: rogue (speed 3), knight (speed 2), or mage (speed 1, range 2).',
    { class: z.enum(['rogue', 'knight', 'mage']).describe('The unit class to play as') },
    async (args) => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available.');
      if (lobby.phase !== 'pre_game') return errorResult('Class selection is only available during the pre-game phase.');
      const unitClass = args['class'] as UnitClass;
      const result = lobby.chooseClass(agentId, unitClass);
      if (!result.success) return errorResult(result.error ?? 'Failed to choose class.');
      return jsonResult({ success: true, class: unitClass });
    },
  );

  server.tool(
    'get_team_state',
    'Get your team\'s current composition and readiness status.',
    {},
    async () => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available.');
      const teamState = lobby.getTeamState(agentId);
      if (!teamState) return errorResult('You are not on a team yet.');
      return jsonResult(teamState);
    },
  );

  // ==================== Game Phase Tools ====================

  server.tool(
    'get_game_state',
    'Get the current game state from your perspective (non-blocking). Returns your unit info, visible tiles, flag statuses, team messages, and score. Use this to check for new teammate messages mid-turn or re-read the board. Coordinates are absolute axial hex (q, r) — (0,0) is map center, shared by all players.',
    {},
    async () => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const game = resolveGame(agentId);
      if (!game) return errorResult('No game in progress.');
      const state = game.getStateForAgent(agentId);
      if (game.phase === 'finished') {
        return jsonResult({ ...state, gameOver: true, winner: game.winner });
      }
      return jsonResult(state);
    },
  );

  server.tool(
    'wait_for_turn',
    'Wait for the next turn to start, then return the game state from your perspective (fog of war applied). This call hangs until the turn resolves — no need to poll. Returns your unit info, visible tiles, flag statuses, team messages, and score. Also returns the final state when the game ends. Coordinates are absolute axial hex (q, r) — (0,0) is map center, shared by all players.',
    {},
    async () => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const game = resolveGame(agentId);
      if (!game) return errorResult('No game in progress. The game has not started yet.');

      // If game is finished, return final state immediately
      if (game.phase === 'finished') {
        const state = game.getStateForAgent(agentId);
        return jsonResult({ ...state, gameOver: true, winner: game.winner });
      }

      // If the agent hasn't submitted a move yet this turn, return current state immediately
      // (they need to see the board before submitting)
      if (!game.moveSubmissions.has(agentId)) {
        const state = game.getStateForAgent(agentId);
        return jsonResult(state);
      }

      // Agent already submitted — wait for the turn to resolve
      await waitForNextTurn(game.gameId, 60000);

      // Return the new state after turn resolution
      const updatedGame = resolveGame(agentId);
      if (!updatedGame) return errorResult('Game ended.');
      const state = updatedGame.getStateForAgent(agentId);
      if (updatedGame.phase === 'finished') {
        return jsonResult({ ...state, gameOver: true, winner: updatedGame.winner });
      }
      return jsonResult(state);
    },
  );

  server.tool(
    'submit_move',
    'Submit your movement path for this turn. Array of directions: N, NE, SE, S, SW, NW. Empty array to stay put.',
    { path: z.array(z.string()).describe('Array of direction strings, e.g. ["N", "NE", "N"]') },
    async ({ path }) => {
      const check = requireRegistration();
      if (check) return errorResult(check);
      const game = resolveGame(agentId);
      if (!game) return errorResult('No game in progress.');
      if (game.phase !== 'in_progress') return errorResult('Cannot submit moves — game phase is: ' + game.phase);

      for (const dir of path) {
        if (!isValidDirection(dir)) {
          return errorResult(`Invalid direction "${dir}". Valid: ${VALID_DIRECTIONS.join(', ')}`);
        }
      }

      const directions = path as Direction[];
      const result = game.submitMove(agentId, directions);
      if (!result.success) return errorResult(result.error ?? 'Failed to submit move.');

      // Notify turn loop that a move was submitted
      if (onMoveSubmitted) {
        onMoveSubmitted(game.gameId, agentId);
      }

      return jsonResult({ success: true, path: directions });
    },
  );

  server.tool(
    'team_chat',
    'Send a private message to your teammates. Works during class selection (pre-game) and during the game.',
    { message: z.string().describe('The message to send to your team') },
    async ({ message }) => {
      const check = requireRegistration();
      if (check) return errorResult(check);

      // During class selection (pre_game), send via lobby teamChat
      const lobby = resolveLobby(agentId);
      if (lobby && lobby.phase === 'pre_game') {
        lobby.teamChat(agentId, message);
        return jsonResult({ success: true });
      }

      // During game, send via game chat
      const game = resolveGame(agentId);
      if (!game) return errorResult('team_chat requires an active game or pre-game class selection phase. Use lobby_chat during lobby forming.');
      if (game.phase !== 'in_progress') return errorResult('Team chat is only available during the game.');
      game.submitChat(agentId, message);
      if (onChat) onChat(game.gameId);
      return jsonResult({ success: true });
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface MCPSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  agentId: string;
}

/** Active MCP sessions keyed by MCP session ID */
const sessions = new Map<string, MCPSession>();

// ---------------------------------------------------------------------------
// Express route handlers
// ---------------------------------------------------------------------------

/**
 * Mount the MCP Streamable HTTP endpoint on an existing Express app.
 *
 * @param app - Express app (typed as `any` per project convention)
 * @param resolveGame - function to find a GameManager for an agentId
 * @param resolveLobby - function to find a LobbyManager for an agentId
 * @param onMoveSubmitted - callback when an external agent submits a move
 * @param onChat - callback when an agent sends a chat message
 * @param onRegister - callback when an agent registers (for wiring into lobby system)
 */
export function mountMcpEndpoint(
  app: any,
  resolveGame: GameResolver,
  resolveLobby: LobbyResolver,
  onMoveSubmitted?: MoveCallback,
  onChat?: (gameId: string) => void,
  onRegister?: RegisterCallback,
  onJoinLobby?: JoinLobbyCallback,
): void {

  // POST /mcp — main MCP endpoint
  app.post('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      // Existing session?
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // New initialization request — also accept if session ID is stale (server restarted)
      if (isInitializeRequest(req.body)) {
        // No auth required — assign a new agent ID
        const agentId = `ext_${crypto.randomUUID().slice(0, 8)}`;

        const sessionEntry: SessionEntry = {
          agentId,
          name: null, // not registered yet
        };

        const mcpServer = createAgentMcpServer(
          agentId, sessionEntry, resolveGame, resolveLobby,
          onRegister, onJoinLobby, onMoveSubmitted, onChat,
        );

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server: mcpServer, agentId });
            sessionRegistry.set(sid, sessionEntry);
            console.log(`[MCP] Session ${sid} initialized for agent ${agentId} (unregistered)`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            console.log(`[MCP] Session ${sid} closed for agent ${sessions.get(sid)!.agentId}`);
            sessions.delete(sid);
            sessionRegistry.delete(sid);
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Stale session ID — tell client to reconnect
      if (sessionId && !sessions.has(sessionId)) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session expired. Please reconnect.' },
          id: null,
        });
        return;
      }

      // Bad request
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session ID provided' },
        id: null,
      });
    } catch (error) {
      console.error('[MCP] Error handling request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp — SSE stream for server-initiated messages
  app.get('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  });

  // DELETE /mcp — session termination
  app.delete('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  });

  console.log('[MCP] Streamable HTTP endpoint mounted at /mcp (no auth required, call register tool first)');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function closeAllMcpSessions(): Promise<void> {
  for (const [sid, session] of sessions) {
    try {
      await session.transport.close();
    } catch {
      // ignore
    }
    sessions.delete(sid);
    sessionRegistry.delete(sid);
  }
}
