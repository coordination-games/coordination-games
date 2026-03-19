/**
 * Streamable HTTP MCP Transport for Capture the Lobster.
 *
 * Exposes the same MCP tools as mcp.ts over HTTP/SSE so any external
 * MCP client (Claude Code, OpenClaw, custom agents) can connect and play.
 *
 * Each external agent gets their own McpServer instance scoped to their agentId.
 * Auth is via Bearer token in the Authorization header, mapped to an agentId/gameId.
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

export interface TokenEntry {
  agentId: string;
  lobbyId?: string;
  gameId?: string;
}

/** Global in-memory token store: token -> { agentId, lobbyId?, gameId? } */
export const tokenRegistry = new Map<string, TokenEntry>();

// ---------------------------------------------------------------------------
// Helpers (duplicated from mcp.ts to avoid import cycles)
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

// ---------------------------------------------------------------------------
// Per-agent MCP server factory
// ---------------------------------------------------------------------------

export type GameResolver = (agentId: string) => GameManager | null;
export type LobbyResolver = (agentId: string) => EngineLobbyManager | null;
export type MoveCallback = (gameId: string, agentId: string) => void;

/** Callbacks for lobby/game management from unauthenticated MCP connections */
export interface LobbyActions {
  joinLobby: (agentId: string, lobbyId: string) => { success: boolean; error?: string };
  createLobby: (agentId: string, teamSize: number) => { success: boolean; lobbyId?: string; error?: string };
  addBot: (lobbyId: string) => { success: boolean; agentId?: string; handle?: string; error?: string };
  listLobbies: () => { lobbyId: string; phase: string; agentCount: number; teamSize: number }[];
}

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

/**
 * Create a new McpServer with all game/lobby tools scoped to agentId.
 * We use resolver functions so the server can dynamically find the
 * correct game/lobby even if it changes after registration.
 */
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
Flat-top hexagons. Six directions: N, NE, SE, S, SW, NW (no E/W).
Movement is a path of directions up to your speed: ["N", "NE", "SE"]

## Game Flow

### Phase 1: Lobby
Call join_lobby(lobbyId) or create_lobby() to enter a lobby. Then:
- get_lobby() — See all agents, teams, and chat
- lobby_chat(message) — Talk to everyone
- propose_team(agentId) — Invite someone to your team
- accept_team(teamId) — Accept a team invitation
When 2 full teams form, the game auto-advances to pre-game.

### Phase 2: Pre-Game
- get_team_state() — See teammates and class picks
- team_chat(message) — Private team message
- choose_class(class) — Pick "rogue", "knight", or "mage"
Coordinate with your team! A good duo: rogue (flag runner) + knight (defender).

### Phase 3: Game (30 turns)
- wait_for_turn() — Blocks until the next turn starts, returns your view of the board
- submit_move(path) — Move your unit (array of directions up to your speed, [] to stay)
- team_chat(message) — Share intel with your team (they can't see what you see!)

Each turn: wait_for_turn → analyze → team_chat → submit_move → repeat.

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
- Team vision is NOT shared — communicate via team_chat!

## Strategy
- Rogues: fast flag runners, avoid knights
- Knights: defend your flag, chase enemy rogues
- Mages: ranged area control, stay away from rogues
- COMMUNICATE every turn: position, what you see, your plan
`;

function createAgentMcpServer(
  agentId: string,
  resolveGame: GameResolver,
  resolveLobby: LobbyResolver,
  onMoveSubmitted?: MoveCallback,
  lobbyActions?: LobbyActions,
): McpServer {
  const server = new McpServer({
    name: `capture-the-lobster-${agentId}`,
    version: '0.1.0',
  });

  // ==================== Meta Tools ====================

  server.tool(
    'get_rules',
    'Get the full game rules and instructions for Capture the Lobster. Call this first to learn how to play.',
    {},
    async () => jsonResult(GAME_RULES),
  );

  if (lobbyActions) {
    server.tool(
      'join_lobby',
      'Join an existing lobby by ID. This registers you as a player in that lobby.',
      { lobbyId: z.string().describe('The lobby ID to join (e.g. "lobby_1")') },
      async ({ lobbyId }) => {
        const result = lobbyActions.joinLobby(agentId, lobbyId);
        if (!result.success) return errorResult(result.error ?? 'Failed to join lobby');
        return jsonResult({ success: true, agentId, lobbyId, message: 'You joined the lobby! Call get_lobby() to see who else is here.' });
      },
    );

    server.tool(
      'create_lobby',
      'Create a new lobby and join it. Share the lobbyId with friends so they can join too.',
      { teamSize: z.number().optional().describe('Players per team (default 2)') },
      async ({ teamSize }) => {
        const result = lobbyActions.createLobby(agentId, teamSize ?? 2);
        if (!result.success) return errorResult(result.error ?? 'Failed to create lobby');
        return jsonResult({ success: true, agentId, lobbyId: result.lobbyId, message: `Lobby ${result.lobbyId} created! Share this ID with other players. Call get_lobby() to see the lobby state.` });
      },
    );

    server.tool(
      'add_bot',
      'Add an AI bot to your current lobby. Use this to fill empty slots.',
      {},
      async () => {
        const lobby = resolveLobby(agentId);
        if (!lobby) return errorResult('You are not in a lobby. Call join_lobby or create_lobby first.');
        const result = lobbyActions.addBot(lobby.lobbyId);
        if (!result.success) return errorResult(result.error ?? 'Failed to add bot');
        return jsonResult({ success: true, botId: result.agentId, handle: result.handle });
      },
    );

    server.tool(
      'list_lobbies',
      'List all active lobbies that can be joined.',
      {},
      async () => {
        const lobbies = lobbyActions.listLobbies();
        if (lobbies.length === 0) return jsonResult({ lobbies: [], message: 'No active lobbies. Create one with create_lobby()!' });
        return jsonResult({ lobbies });
      },
    );
  }

  // ==================== Lobby Phase Tools ====================

  server.tool(
    'get_lobby',
    'Get the current lobby state: connected agents, teams, chat messages.',
    {},
    async () => {
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available.');
      return jsonResult(lobby.getLobbyState(agentId));
    },
  );

  server.tool(
    'lobby_chat',
    'Send a public chat message visible to all agents in the lobby.',
    { message: z.string().describe('The message to send to the lobby chat') },
    async ({ message }) => {
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available.');
      if (lobby.phase !== 'forming') return errorResult('Lobby chat is only available during the forming phase.');
      lobby.lobbyChat(agentId, message);
      return jsonResult({ success: true });
    },
  );

  server.tool(
    'propose_team',
    'Invite another agent to form a team with you.',
    { agentId: z.string().describe('The ID of the agent you want to invite to your team') },
    async ({ agentId: targetAgentId }) => {
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
      const lobby = resolveLobby(agentId);
      if (!lobby) return errorResult('No lobby available.');
      const teamState = lobby.getTeamState(agentId);
      if (!teamState) return errorResult('You are not on a team yet.');
      return jsonResult(teamState);
    },
  );

  // ==================== Game Phase Tools ====================

  server.tool(
    'wait_for_turn',
    'Wait for the next turn to start, then return the game state from your perspective (fog of war applied). This call hangs until the turn resolves — no need to poll. Returns your unit info, visible tiles, flag statuses, team messages, and score. Also returns the final state when the game ends.',
    {},
    async () => {
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
    'Send a private message to your teammates. They cannot see what you see — share intel!',
    { message: z.string().describe('The message to send to your team') },
    async ({ message }) => {
      const game = resolveGame(agentId);
      if (!game) return errorResult('No game in progress.');
      if (game.phase !== 'in_progress') return errorResult('Team chat is only available during the game.');
      game.submitChat(agentId, message);
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
 */
export function mountMcpEndpoint(
  app: any,
  resolveGame: GameResolver,
  resolveLobby: LobbyResolver,
  onMoveSubmitted?: MoveCallback,
  lobbyActions?: LobbyActions,
): void {

  // Helper: extract token from Authorization header
  function extractToken(req: any): string | null {
    const authHeader = req.headers?.['authorization'] as string | undefined;
    if (!authHeader?.startsWith('Bearer ')) return null;
    return authHeader.slice(7);
  }

  // Helper: resolve agentId from token
  function resolveAgent(req: any): TokenEntry | null {
    const token = extractToken(req);
    if (!token) return null;
    return tokenRegistry.get(token) ?? null;
  }

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

      // New initialization request
      if (!sessionId && isInitializeRequest(req.body)) {
        // Try Bearer token first, fall back to anonymous agent
        const entry = resolveAgent(req);
        const agentId = entry
          ? entry.agentId
          : `ext_${crypto.randomUUID().slice(0, 8)}`;

        if (!entry) {
          // Create a token entry for the anonymous agent so resolvers work later
          generateToken({ agentId });
          console.log(`[MCP] Anonymous agent ${agentId} connected`);
        }

        const mcpServer = createAgentMcpServer(
          agentId, resolveGame, resolveLobby, onMoveSubmitted,
          entry ? undefined : lobbyActions, // Only give lobby management tools to unauthenticated agents
        );

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server: mcpServer, agentId });
            console.log(`[MCP] Session ${sid} initialized for agent ${agentId}`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            console.log(`[MCP] Session ${sid} closed for agent ${sessions.get(sid)!.agentId}`);
            sessions.delete(sid);
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
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

  console.log('[MCP] Streamable HTTP endpoint mounted at /mcp');
}

// ---------------------------------------------------------------------------
// Token generation helper
// ---------------------------------------------------------------------------

export function generateToken(entry: TokenEntry): string {
  const token = `ctlob_${crypto.randomUUID().replace(/-/g, '')}`;
  tokenRegistry.set(token, entry);
  return token;
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
  }
}
