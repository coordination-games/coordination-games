import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GameManager, Direction } from '@lobster/engine';
import type { UnitClass } from '@lobster/engine';

// ----- Lobby stub types (lobby.ts is a stub — define minimal interfaces here) -----

export interface LobbyAgent {
  id: string;
  name: string;
  ready: boolean;
}

export interface LobbyTeam {
  id: string;
  members: string[];
  pending: string[]; // invited but not yet accepted
}

export interface LobbyChatMessage {
  from: string;
  message: string;
  timestamp: number;
}

export interface LobbyState {
  agents: LobbyAgent[];
  teams: LobbyTeam[];
  chat: LobbyChatMessage[];
  timeRemainingSeconds: number;
}

/**
 * Minimal LobbyManager interface.
 * The real implementation will come from @lobster/engine once lobby.ts is fleshed out.
 */
export interface LobbyManager {
  getState(): LobbyState;
  chat(agentId: string, message: string): void;
  proposeTeam(fromAgentId: string, toAgentId: string): { success: boolean; teamId?: string; error?: string };
  acceptTeam(agentId: string, teamId: string): { success: boolean; error?: string };
  chooseClass(agentId: string, unitClass: UnitClass): { success: boolean; error?: string };
  getTeamState(agentId: string): {
    teamId: string;
    members: { id: string; unitClass: UnitClass | null; ready: boolean }[];
  } | null;
  phase: 'lobby' | 'pre_game' | 'in_progress';
}

// ----- Helpers -----

const VALID_DIRECTIONS: Direction[] = ['N', 'NE', 'SE', 'S', 'SW', 'NW'];

function isValidDirection(d: string): d is Direction {
  return VALID_DIRECTIONS.includes(d as Direction);
}

function jsonResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true as const,
  };
}

// ----- MCP Server -----

export class LobsterMCPServer {
  private mcpServer: McpServer;
  private lobbyManager: LobbyManager | null = null;
  private gameManager: GameManager | null = null;
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;

    this.mcpServer = new McpServer({
      name: 'capture-the-lobster',
      version: '0.1.0',
    });

    this.registerTools();
  }

  setLobby(lobby: LobbyManager): void {
    this.lobbyManager = lobby;
  }

  setGame(game: GameManager): void {
    this.gameManager = game;
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
  }

  /** Build lightweight updates envelope for action responses */
  private buildUpdates(): Record<string, unknown> {
    const updates: Record<string, unknown> = {};
    if (this.gameManager) {
      updates.phase = this.gameManager.phase === 'finished' ? 'finished' : 'game';
      updates.turn = this.gameManager.turn;
      updates.moveSubmitted = this.gameManager.moveSubmissions.has(this.agentId);
      const messages = this.gameManager.getTeamMessages(this.agentId);
      updates.newMessages = messages.slice(-10);
      if (this.gameManager.phase === 'finished') {
        updates.gameOver = true;
        updates.winner = this.gameManager.winner;
      }
      return updates;
    }
    if (this.lobbyManager) {
      updates.phase = this.lobbyManager.phase;
      return updates;
    }
    updates.phase = 'none';
    return updates;
  }

  private registerTools(): void {
    // ==================== Lobby Phase Tools ====================

    this.mcpServer.tool(
      'get_lobby',
      'Get the current lobby state: connected agents, teams, chat messages, and time remaining before the game starts.',
      {},
      async () => {
        if (!this.lobbyManager) {
          return errorResult('No lobby available. Game has not been created yet.');
        }
        return jsonResult(this.lobbyManager.getState());
      },
    );

    this.mcpServer.tool(
      'chat',
      'Send a message. In the lobby, visible to everyone. During class selection and in-game, visible to your team only.',
      { message: z.string().describe('Your message') },
      async ({ message }) => {
        if (this.lobbyManager && this.lobbyManager.phase === 'lobby') {
          this.lobbyManager.chat(this.agentId, message);
          return jsonResult({ success: true, ...this.buildUpdates() });
        }
        if (this.lobbyManager && this.lobbyManager.phase === 'pre_game') {
          this.lobbyManager.chooseClass(this.agentId, 'rogue'); // no-op if already chosen
          return jsonResult({ success: true, ...this.buildUpdates() });
        }
        if (this.gameManager && this.gameManager.phase === 'in_progress') {
          this.gameManager.submitChat(this.agentId, message);
          return jsonResult({ success: true, ...this.buildUpdates() });
        }
        return errorResult('No active lobby or game.');
      },
    );

    this.mcpServer.tool(
      'propose_team',
      'Invite another agent to form a team with you.',
      { agentId: z.string().describe('The ID of the agent you want to invite to your team') },
      async ({ agentId: targetAgentId }) => {
        if (!this.lobbyManager) {
          return errorResult('No lobby available.');
        }
        if (this.lobbyManager.phase !== 'lobby') {
          return errorResult('Team proposals are only available during the lobby phase.');
        }
        const result = this.lobbyManager.proposeTeam(this.agentId, targetAgentId);
        if (!result.success) {
          return errorResult(result.error ?? 'Failed to propose team.');
        }
        return jsonResult({ success: true, teamId: result.teamId, ...this.buildUpdates() });
      },
    );

    this.mcpServer.tool(
      'accept_team',
      'Accept an invitation to join a team.',
      { teamId: z.string().describe('The ID of the team invitation to accept') },
      async ({ teamId }) => {
        if (!this.lobbyManager) {
          return errorResult('No lobby available.');
        }
        if (this.lobbyManager.phase !== 'lobby') {
          return errorResult('Team acceptance is only available during the lobby phase.');
        }
        const result = this.lobbyManager.acceptTeam(this.agentId, teamId);
        if (!result.success) {
          return errorResult(result.error ?? 'Failed to accept team.');
        }
        return jsonResult({ success: true, ...this.buildUpdates() });
      },
    );

    // ==================== Pre-Game Phase Tools ====================

    this.mcpServer.tool(
      'choose_class',
      'Choose your unit class: rogue (speed 3), knight (speed 2), or mage (speed 1, range 2).',
      {
        class: z.enum(['rogue', 'knight', 'mage']).describe('The unit class to play as'),
      },
      async (args) => {
        if (!this.lobbyManager) {
          return errorResult('No lobby available.');
        }
        if (this.lobbyManager.phase !== 'pre_game') {
          return errorResult('Class selection is only available during the pre-game phase. Current phase: ' + this.lobbyManager.phase);
        }
        const unitClass = args['class'] as UnitClass;
        const result = this.lobbyManager.chooseClass(this.agentId, unitClass);
        if (!result.success) {
          return errorResult(result.error ?? 'Failed to choose class.');
        }
        return jsonResult({ success: true, class: unitClass, ...this.buildUpdates() });
      },
    );

    this.mcpServer.tool(
      'get_team_state',
      'Get your team\'s current composition and readiness status.',
      {},
      async () => {
        if (!this.lobbyManager) {
          return errorResult('No lobby available.');
        }
        const teamState = this.lobbyManager.getTeamState(this.agentId);
        if (!teamState) {
          return errorResult('You are not on a team yet.');
        }
        return jsonResult(teamState);
      },
    );

    // ==================== Game Phase Tools ====================

    this.mcpServer.tool(
      'get_game_state',
      'Get the current game state from your perspective (full state with visible tiles).',
      {},
      async () => {
        if (!this.gameManager) {
          return errorResult('No game in progress. The game has not started yet.');
        }
        if (this.gameManager.phase === 'finished') {
          const state = this.gameManager.getStateForAgent(this.agentId);
          return jsonResult({ ...state, winner: this.gameManager.winner });
        }
        try {
          const state = this.gameManager.getStateForAgent(this.agentId);
          return jsonResult(state);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : 'Failed to get game state.');
        }
      },
    );

    this.mcpServer.tool(
      'submit_move',
      'Submit your movement path for this turn. Array of directions: N, NE, SE, S, SW, NW. Empty array to stay put.',
      {
        path: z.array(z.string()).describe('Array of direction strings (e.g. ["N", "NE", "N"])'),
      },
      async ({ path }) => {
        if (!this.gameManager) {
          return errorResult('No game in progress.');
        }
        if (this.gameManager.phase !== 'in_progress') {
          return errorResult('Cannot submit moves — game phase is: ' + this.gameManager.phase);
        }

        for (const dir of path) {
          if (!isValidDirection(dir)) {
            return errorResult(
              `Invalid direction "${dir}". Valid directions are: ${VALID_DIRECTIONS.join(', ')}`,
            );
          }
        }

        const directions = path as Direction[];
        const result = this.gameManager.submitMove(this.agentId, directions);
        if (!result.success) {
          return errorResult(result.error ?? 'Failed to submit move.');
        }
        return jsonResult({ success: true, path: directions, ...this.buildUpdates() });
      },
    );
  }
}

// ----- Factory -----

export function createMCPServer(
  agentId: string,
  lobby?: LobbyManager,
  game?: GameManager,
): LobsterMCPServer {
  const server = new LobsterMCPServer(agentId);
  if (lobby) server.setLobby(lobby);
  if (game) server.setGame(game);
  return server;
}

// ----- Standalone entry point -----

const isMain = typeof import.meta.url === 'string' &&
  import.meta.url.endsWith('/mcp.js') &&
  process.argv[1]?.endsWith('/mcp.js');

if (isMain) {
  const agentId = process.env.AGENT_ID;
  if (!agentId) {
    console.error('AGENT_ID environment variable is required');
    process.exit(1);
  }
  const server = createMCPServer(agentId);
  await server.start();
}
