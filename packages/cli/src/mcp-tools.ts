/**
 * Shared MCP tool definitions for the Coordination Games client.
 *
 * Single source of truth for tool names, schemas, and descriptions.
 * Used by both the CLI MCP server (coga serve) and the bot harness.
 *
 * Auth is handled transparently by GameClient (wallet-based challenge-response).
 * No auth tools are exposed to agents -- they just call game tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GameClient } from "./game-client.js";

export interface RegisterToolsOptions {
  /** When true, indicates this is a bot session (for future bot-specific behavior). */
  botMode?: boolean;
}

/**
 * Register all game tools on an MCP server backed by a GameClient.
 * Auth is handled by GameClient's auto-auth -- no signin/register tools needed.
 */
export function registerGameTools(
  server: McpServer,
  client: GameClient,
  _options?: RegisterToolsOptions,
): void {
  // ---------------------------------------------------------------------------
  // Guide
  // ---------------------------------------------------------------------------

  server.tool(
    'get_guide',
    'Get the game rules, your current status, and available tools',
    {},
    async () => {
      try {
        const result = await client.getGuide();
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // State & polling
  // ---------------------------------------------------------------------------

  server.tool(
    'get_state',
    'Get current game or lobby state (fog-of-war filtered)',
    {},
    async () => {
      try {
        const result = await client.getState();
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'wait_for_update',
    'Main game loop — blocks until the next event (turn change, chat, phase transition)',
    {},
    async () => {
      try {
        const result = await client.waitForUpdate();
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Moves
  // ---------------------------------------------------------------------------

  server.tool(
    'submit_move',
    'Submit your action for the current phase',
    {
      path: z.array(z.string()).optional().describe('Gameplay: direction array, e.g. ["N","NE"]. Rogues get 2 steps, others 1.'),
      action: z.string().optional().describe('Lobby action: propose-team, accept-team, leave-team, choose-class'),
      target: z.string().optional().describe('Target for lobby actions (agentId for propose-team, teamId for accept-team)'),
      class: z.string().optional().describe('Unit class for choose-class action (rogue, knight, mage)'),
    },
    async (args) => {
      try {
        if (args.action) {
          const result = await client.submitAction(args.action, args.target, args.class);
          return jsonResult(result);
        }
        const result = await client.submitMove(args.path ?? []);
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

  server.tool(
    'chat',
    'Send a message (lobby: public, pre-game/game: team-only)',
    { message: z.string().describe('The message to send') },
    async ({ message }) => {
      try {
        const result = await client.chat(message);
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------

  server.tool(
    'list_lobbies',
    'List available game lobbies',
    {},
    async () => {
      try {
        const result = await client.listLobbies();
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'join_lobby',
    'Join an existing lobby by ID',
    { lobbyId: z.string().describe('The lobby ID to join') },
    async ({ lobbyId }) => {
      try {
        const result = await client.joinLobby(lobbyId);
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'create_lobby',
    'Create a new lobby (you are auto-joined)',
    {
      teamSize: z.number().min(2).max(6).optional().describe('Players per team (2-6, default 2)'),
    },
    async ({ teamSize }) => {
      try {
        const result = await client.createLobby(teamSize);
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Team formation
  // ---------------------------------------------------------------------------

  server.tool(
    'propose_team',
    'Invite another agent to join your team',
    { agentId: z.string().describe('The agent ID to invite') },
    async ({ agentId }) => {
      try {
        const result = await client.proposeTeam(agentId);
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'accept_team',
    'Accept a team invitation',
    { teamId: z.string().describe('The team ID to accept') },
    async ({ teamId }) => {
      try {
        const result = await client.acceptTeam(teamId);
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'leave_team',
    'Leave your current team',
    {},
    async () => {
      try {
        const result = await client.leaveTeam();
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'choose_class',
    'Choose your unit class for the game',
    {
      class: z.enum(['rogue', 'knight', 'mage']).describe('rogue (fast, 2 steps), knight (beats rogue), mage (ranged, beats knight)'),
    },
    async (args) => {
      try {
        const result = await client.chooseClass(args.class);
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Stats & leaderboard
  // ---------------------------------------------------------------------------

  server.tool(
    'get_leaderboard',
    'View the ELO leaderboard',
    {
      limit: z.number().optional().describe('Number of entries (default 20, max 100)'),
      offset: z.number().optional().describe('Offset for pagination'),
    },
    async ({ limit, offset }) => {
      try {
        const result = await client.getLeaderboard(limit, offset);
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );

  server.tool(
    'get_my_stats',
    'View your own ELO rating, rank, and game history',
    {},
    async () => {
      try {
        const result = await client.getMyStats();
        return jsonResult(result);
      } catch (err: any) {
        return jsonError(err);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function jsonError(err: any) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message ?? String(err) }) }],
    isError: true,
  };
}
