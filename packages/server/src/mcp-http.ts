/**
 * Streamable HTTP MCP Transport for Capture the Lobster.
 *
 * Auth flow: call signin({ agentId }) to get a token, then pass
 * token as a parameter on every subsequent tool call. Token expires
 * after 24 hours. If missing or expired, tools return an auth_required
 * error with instructions to call signin() again.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GameManager, Direction, UnitClass } from '@lobster/engine';
import { LobbyManager as EngineLobbyManager } from '@lobster/engine';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Token registry
// ---------------------------------------------------------------------------

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface TokenEntry {
  agentId: string;
  name: string;
  expiresAt: number;
}

/** Global token registry: token -> entry. Survives session reconnects. */
const tokenRegistry = new Map<string, TokenEntry>();

/** Look up agentId by token (returns null if missing or expired) */
export function getAgentIdFromToken(token: string): string | null {
  const entry = tokenRegistry.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenRegistry.delete(token);
    return null;
  }
  return entry.agentId;
}

// ---------------------------------------------------------------------------
// Session registry (MCP session ID -> agentId binding)
// ---------------------------------------------------------------------------

export interface SessionEntry {
  agentId: string;
  name: string | null;
}

const sessionRegistry = new Map<string, SessionEntry>();

/** Get display name for an agent */
export function getAgentName(agentId: string): string {
  // Check token registry for a name
  for (const entry of tokenRegistry.values()) {
    if (entry.agentId === agentId) return entry.name;
  }
  // Fallback to session registry
  for (const entry of sessionRegistry.values()) {
    if (entry.agentId === agentId && entry.name) return entry.name;
  }
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

function authRequiredError() {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: 'auth_required',
        message: 'No valid session. Call signin({ agentId: "your-agent-id" }) to get a token, then pass it as \'token\' on every subsequent call.',
      }, null, 2),
    }],
    isError: true as const,
  };
}

/** Optional token parameter added to every authenticated tool */
const T = { token: z.string().optional().describe("Auth token from signin(). Pass this on every call.") };

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
const turnWaiters = new Map<string, Set<TurnWaiter>>();

export function notifyTurnResolved(gameId: string): void {
  const waiters = turnWaiters.get(gameId);
  if (waiters) {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }
}

function waitForNextTurn(gameId: string, maxWaitMs: number = 60000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!turnWaiters.has(gameId)) turnWaiters.set(gameId, new Set());
    const waiters = turnWaiters.get(gameId)!;

    const timer = setTimeout(() => {
      waiters.delete(resolve);
      resolve();
    }, maxWaitMs);

    const wrappedResolve = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.add(wrappedResolve);
  });
}

/** Game rules text */
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

### Step 0: Sign In
Call **signin({ agentId: "your-name" })** to get an auth token. Pass this token to every subsequent tool call.

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

  /** Validate token or fall back to session registration. Returns null if ok, error result if not. */
  function requireAuth(token?: string): ReturnType<typeof authRequiredError> | null {
    if (token) {
      const entry = tokenRegistry.get(token);
      if (!entry) return authRequiredError();
      if (Date.now() > entry.expiresAt) {
        tokenRegistry.delete(token);
        return authRequiredError();
      }
      return null;
    }
    // Legacy: session-based registration (for backward compat)
    if (!sessionEntry.name) return authRequiredError();
    return null;
  }

  // ==================== Sign In ====================

  server.tool(
    'signin',
    'Sign in with your agent ID to get an auth token (valid 24 hours). Pass this token to every other tool call. If your token expires mid-game, call signin() again to get a new one.',
    { agentId: z.string().describe('The name you want to play as (e.g. "ClaudeBot", "my-cool-agent"). This is just a display name — pick whatever you like.') },
    async ({ agentId: requestedId }) => {
      const name = requestedId.trim();
      if (!name) return errorResult('agentId cannot be empty.');
      if (name.length > 32) return errorResult('agentId must be 32 characters or fewer.');

      const token = crypto.randomBytes(5).toString('hex'); // 10 chars, reusable for 24h
      const expiresAt = Date.now() + TOKEN_TTL_MS;
      tokenRegistry.set(token, { agentId, name, expiresAt });

      // Also set session name for backward compat
      sessionEntry.name = name;

      console.log(`[MCP] Agent ${agentId} signed in as "${name}"`);
      if (onRegister) onRegister(agentId, name);

      return jsonResult({
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        agentId,
        name,
        message: 'Signed in! Pass token to every other tool call. Call get_rules() to learn how to play, or join_lobby(lobbyId) to join a game.',
      });
    },
  );

  // ==================== Meta Tools ====================

  server.tool(
    'get_rules',
    'Get the full game rules and instructions for Capture the Lobster. Call this to learn how to play.',
    {},
    async () => jsonResult(GAME_RULES),
  );

  // ==================== Lobby Phase Tools ====================

  server.tool(
    'list_lobbies',
    'List all active lobbies you can join.',
    T,
    async ({ token }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
      const lobby = resolveLobby(agentId);
      if (lobby) return jsonResult({ currentLobby: lobby.getLobbyState(agentId) });
      return jsonResult({ message: 'Use join_lobby(lobbyId) to enter a lobby. Check the website for active lobby IDs.' });
    },
  );

  server.tool(
    'join_lobby',
    'Join an existing lobby by ID.',
    { ...T, lobbyId: z.string().describe('The lobby ID to join (e.g. "lobby_1")') },
    async ({ token, lobbyId }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
      if (!onJoinLobby) return errorResult('Lobby joining not available.');
      const result = onJoinLobby(agentId, sessionEntry.name!, lobbyId);
      if (!result.success) return errorResult(result.error ?? `Failed to join lobby "${lobbyId}".`);
      return jsonResult({ success: true, agentId, lobbyId, message: 'You joined the lobby! Call get_lobby() to see who else is here.' });
    },
  );

  server.tool(
    'create_lobby',
    'Create a new lobby and join it.',
    T,
    async ({ token }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
      return errorResult('To create a lobby, use the website or ask the server admin. Use join_lobby(lobbyId) to join an existing one.');
    },
  );

  server.tool(
    'get_lobby',
    'Get the current lobby state: connected agents, teams, chat messages.',
    T,
    async ({ token }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available. Use join_lobby(lobbyId) to join one.');
      return jsonResult(lobby.getLobbyState(agentId));
    },
  );

  server.tool(
    'lobby_chat',
    'Send a public chat message visible to all agents in the lobby. Only works during the forming phase.',
    { ...T, message: z.string().describe('The message to send to the lobby chat') },
    async ({ token, message }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
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
    { ...T, agentId: z.string().describe('The ID of the agent you want to invite to your team') },
    async ({ token, agentId: targetAgentId }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
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
    { ...T, teamId: z.string().describe('The ID of the team invitation to accept') },
    async ({ token, teamId }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
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
    { ...T, class: z.enum(['rogue', 'knight', 'mage']).describe('The unit class to play as') },
    async (args) => {
      const auth = requireAuth(args.token);
      if (auth) return auth;
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
    T,
    async ({ token }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
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
    'Get the current game state from your perspective (non-blocking). Returns your unit info, visible tiles, flag statuses, team messages, and score. Coordinates are absolute axial hex (q, r) — (0,0) is map center.',
    T,
    async ({ token }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
      const game = resolveGame(agentId);
      if (!game) return errorResult('No game in progress.');
      const state = game.getStateForAgent(agentId);
      if (game.phase === 'finished') return jsonResult({ ...state, gameOver: true, winner: game.winner });
      return jsonResult(state);
    },
  );

  server.tool(
    'wait_for_turn',
    'Wait for the next turn to start, then return the game state from your perspective (fog of war applied). Hangs until the turn resolves — no need to poll. Also returns the final state when the game ends.',
    T,
    async ({ token }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
      const game = resolveGame(agentId);
      if (!game) return errorResult('No game in progress. The game has not started yet.');

      if (game.phase === 'finished') {
        const state = game.getStateForAgent(agentId);
        return jsonResult({ ...state, gameOver: true, winner: game.winner });
      }

      if (!game.moveSubmissions.has(agentId)) {
        const state = game.getStateForAgent(agentId);
        return jsonResult(state);
      }

      await waitForNextTurn(game.gameId, 60000);

      const updatedGame = resolveGame(agentId);
      if (!updatedGame) return errorResult('Game ended.');
      const state = updatedGame.getStateForAgent(agentId);
      if (updatedGame.phase === 'finished') return jsonResult({ ...state, gameOver: true, winner: updatedGame.winner });
      return jsonResult(state);
    },
  );

  server.tool(
    'submit_move',
    'Submit your movement path for this turn. Array of directions: N, NE, SE, S, SW, NW. Empty array to stay put.',
    { ...T, path: z.array(z.string()).describe('Array of direction strings, e.g. ["N", "NE", "N"]') },
    async ({ token, path }) => {
      const auth = requireAuth(token);
      if (auth) return auth;
      const game = resolveGame(agentId);
      if (!game) return errorResult('No game in progress.');
      if (game.phase !== 'in_progress') return errorResult('Cannot submit moves — game phase is: ' + game.phase);

      for (const dir of path) {
        if (!isValidDirection(dir)) return errorResult(`Invalid direction "${dir}". Valid: ${VALID_DIRECTIONS.join(', ')}`);
      }

      const directions = path as Direction[];
      const result = game.submitMove(agentId, directions);
      if (!result.success) return errorResult(result.error ?? 'Failed to submit move.');
      if (onMoveSubmitted) onMoveSubmitted(game.gameId, agentId);
      return jsonResult({ success: true, path: directions });
    },
  );

  server.tool(
    'team_chat',
    'Send a private message to your teammates. Works during class selection (pre-game) and during the game.',
    { ...T, message: z.string().describe('The message to send to your team') },
    async ({ token, message }) => {
      const auth = requireAuth(token);
      if (auth) return auth;

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

const sessions = new Map<string, MCPSession>();

// ---------------------------------------------------------------------------
// Express route handlers
// ---------------------------------------------------------------------------

export function mountMcpEndpoint(
  app: any,
  resolveGame: GameResolver,
  resolveLobby: LobbyResolver,
  onMoveSubmitted?: MoveCallback,
  onChat?: (gameId: string) => void,
  onRegister?: RegisterCallback,
  onJoinLobby?: JoinLobbyCallback,
): void {

  app.post('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (isInitializeRequest(req.body)) {
        const agentId = `ext_${crypto.randomUUID().slice(0, 8)}`;
        const sessionEntry: SessionEntry = { agentId, name: null };

        const mcpServer = createAgentMcpServer(
          agentId, sessionEntry, resolveGame, resolveLobby,
          onRegister, onJoinLobby, onMoveSubmitted, onChat,
        );

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server: mcpServer, agentId });
            sessionRegistry.set(sid, sessionEntry);
            console.log(`[MCP] Session ${sid} initialized for agent ${agentId}`);
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

      if (sessionId && !sessions.has(sessionId)) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session expired. Please reconnect.' },
          id: null,
        });
        return;
      }

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

  app.get('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: any, res: any) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  });

  console.log('[MCP] Streamable HTTP endpoint mounted at /mcp (call signin tool to authenticate)');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function closeAllMcpSessions(): Promise<void> {
  for (const [sid, session] of sessions) {
    try {
      await session.transport.close();
    } catch { /* ignore */ }
    sessions.delete(sid);
    sessionRegistry.delete(sid);
  }
}
