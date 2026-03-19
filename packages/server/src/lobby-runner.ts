/**
 * Lobby runner: orchestrates a lobby with Claude Agent SDK bots.
 * Creates a LobbyManager, spawns bots, handles team formation,
 * pre-game class selection, and game creation.
 */

import {
  query,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  LobbyManager,
  LobbyAgent,
  UnitClass,
} from '@lobster/engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LobbyRunnerPhase =
  | 'forming'    // bots negotiating teams
  | 'pre_game'   // bots picking classes
  | 'starting'   // game being created
  | 'game'       // game is running
  | 'failed';    // lobby failed

export interface LobbyRunnerState {
  lobbyId: string;
  phase: LobbyRunnerPhase;
  agents: { id: string; handle: string; team: string | null }[];
  teams: Record<string, string[]>;
  chat: { from: string; message: string; timestamp: number }[];
  preGame: {
    players: { id: string; team: 'A' | 'B'; unitClass: string | null; ready: boolean }[];
    timeRemainingSeconds: number;
  } | null;
  gameId: string | null;
  error: string | null;
}

export interface LobbyRunnerCallbacks {
  onStateChange: (state: LobbyRunnerState) => void;
  onGameCreated: (gameId: string, teamPlayers: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[]) => void;
}

// ---------------------------------------------------------------------------
// Bot names for flavor
// ---------------------------------------------------------------------------

const BOT_NAMES = [
  'Pinchy', 'Clawdia', 'Sheldon', 'Snappy',
  'Bubbles', 'Coral', 'Neptune', 'Triton',
  'Marina', 'Squidward', 'Barnacle', 'Anchovy',
];

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const LOBBY_SYSTEM_PROMPT = `You are a competitive AI agent in the lobby for "Capture the Lobster", a team-based capture-the-flag game.

## Lobby Phase
You are in the team formation lobby. There are multiple agents here. You need to form a team of the required size.

## What to do:
1. Use get_lobby to see who's in the lobby and current team state
2. Use lobby_chat to talk to other agents — negotiate, introduce yourself, propose alliances
3. Use propose_team to invite another agent to your team (or create a new team with them)
4. Use accept_team to accept a team invitation

## Strategy
- Be social! Chat with others before proposing teams
- Look at other agents' handles and ELO ratings
- Try to form a strong team
- Once you have a team invite, accept it quickly
- Be decisive — the lobby has a time limit!

Keep your messages short and fun. You're a competitive AI with personality.`;

const PREGAME_SYSTEM_PROMPT = `You are picking your class for "Capture the Lobster", a team-based capture-the-flag game on a hex grid.

## Classes
- **Rogue**: Speed 3, Vision 4. Beats Mage. Best flag runner — fast and can see far.
- **Knight**: Speed 2, Vision 2. Beats Rogue. Best defender — tough and can chase down rogues.
- **Mage**: Speed 1, Vision 3, Range 2. Beats Knight. Best area control — ranged attacks on knights.

## Rock-Paper-Scissors Combat
Rogue > Mage > Knight > Rogue

## What to do:
1. Use get_team_state to see your teammates and what classes they've picked
2. Use team_chat to coordinate with your team
3. Use choose_class to pick your class

## Strategy
- Coordinate with your team! Don't all pick the same class.
- A good team has a mix: at least one rogue (flag runner) and varied combat classes
- Talk to your teammates about who should play what role

Be quick — pre-game has a 30 second timer!`;

// ---------------------------------------------------------------------------
// Lobby Runner
// ---------------------------------------------------------------------------

export class LobbyRunner {
  readonly lobby: LobbyManager;
  private phase: LobbyRunnerPhase = 'forming';
  private callbacks: LobbyRunnerCallbacks;
  private timeoutMs: number;
  private gameId: string | null = null;
  private error: string | null = null;
  private abortController: AbortController;
  private botCount: number;
  private teamSize: number;

  constructor(
    teamSize: number = 2,
    timeoutMs: number = 120000,
    callbacks: LobbyRunnerCallbacks,
  ) {
    this.lobby = new LobbyManager(undefined, teamSize);
    this.callbacks = callbacks;
    this.timeoutMs = timeoutMs;
    this.teamSize = teamSize;
    this.botCount = teamSize * 2; // 2 teams
    this.abortController = new AbortController();
  }

  getState(): LobbyRunnerState {
    const lobbyState = this.lobby.getLobbyState('__spectator__');
    const agents = lobbyState.agents.map((a) => ({
      id: a.id,
      handle: a.handle,
      team: a.team,
    }));

    let preGame: LobbyRunnerState['preGame'] = null;
    if (this.phase === 'pre_game') {
      const players: LobbyRunnerState['preGame'] extends infer T
        ? T extends { players: infer P } ? P : never : never = [];
      for (const [, p] of this.lobby.preGamePlayers) {
        (players as any[]).push({
          id: p.id,
          team: p.team,
          unitClass: p.unitClass,
          ready: p.ready,
        });
      }
      // Compute time remaining
      const elapsed = (Date.now() - (this.lobby as any).preGameStartTime) / 1000;
      const remaining = Math.max(0, 30 - elapsed);
      preGame = {
        players: players as any,
        timeRemainingSeconds: Math.round(remaining),
      };
    }

    return {
      lobbyId: this.lobby.lobbyId,
      phase: this.phase,
      agents,
      teams: lobbyState.teams,
      chat: lobbyState.chat,
      preGame,
      gameId: this.gameId,
      error: this.error,
    };
  }

  private emitState(): void {
    this.callbacks.onStateChange(this.getState());
  }

  /**
   * Run the full lobby lifecycle: forming -> pre_game -> game creation
   */
  async run(): Promise<void> {
    try {
      // 1. Add bots to lobby
      const botIds: string[] = [];
      for (let i = 0; i < this.botCount; i++) {
        const id = `agent_${i + 1}`;
        const handle = BOT_NAMES[i % BOT_NAMES.length];
        const agent: LobbyAgent = {
          id,
          handle,
          elo: 1000 + Math.floor(Math.random() * 200),
        };
        this.lobby.addAgent(agent);
        botIds.push(id);
      }
      this.emitState();

      // 2. Run lobby formation phase with bots
      await this.runFormingPhase(botIds);

      if (this.abortController.signal.aborted) return;

      // 3. Check if we have enough teams, auto-merge if needed
      const fullTeams = this.getFullTeams();
      if (fullTeams.length < 2) {
        console.log('Not enough teams formed naturally, auto-merging...');
        this.lobby.autoMergeTeams(this.teamSize);
        this.emitState();
      }

      // 4. Pick the first 2 full teams and start pre-game
      const finalTeams = this.getFullTeams();
      if (finalTeams.length < 2) {
        this.phase = 'failed';
        this.error = 'Could not form 2 full teams';
        this.emitState();
        return;
      }

      const teamA = finalTeams[0].members;
      const teamB = finalTeams[1].members;

      this.lobby.startPreGame(teamA, teamB);
      this.phase = 'pre_game';
      this.emitState();

      // 5. Run pre-game class selection with bots
      await this.runPreGamePhase([...teamA, ...teamB]);

      if (this.abortController.signal.aborted) return;

      // 6. Create the game
      this.phase = 'starting';
      this.emitState();

      // Collect player data before calling createGame (which changes phase)
      const teamPlayers: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[] = [];
      for (const [, p] of this.lobby.preGamePlayers) {
        teamPlayers.push({
          id: p.id,
          team: p.team,
          unitClass: p.unitClass ?? 'rogue',
        });
      }

      const game = this.lobby.createGame();
      this.gameId = game.gameId;
      this.phase = 'game';
      this.emitState();

      this.callbacks.onGameCreated(game.gameId, teamPlayers);
    } catch (err: any) {
      console.error('Lobby runner error:', err);
      this.phase = 'failed';
      this.error = err.message ?? String(err);
      this.emitState();
    }
  }

  abort(): void {
    this.abortController.abort();
  }

  private getFullTeams(): { id: string; members: string[] }[] {
    const result: { id: string; members: string[] }[] = [];
    for (const [id, team] of this.lobby.teams) {
      if (team.members.length >= this.teamSize) {
        result.push({ id, members: [...team.members] });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Forming phase: bots negotiate and form teams
  // ---------------------------------------------------------------------------

  private async runFormingPhase(botIds: string[]): Promise<void> {
    // Give bots up to 3 rounds to form teams, with timeout
    const roundTimeMs = Math.min(this.timeoutMs / 3, 45000);
    const maxRounds = 3;

    for (let round = 0; round < maxRounds; round++) {
      if (this.abortController.signal.aborted) return;

      // Check if we already have 2 full teams
      if (this.getFullTeams().length >= 2) {
        console.log(`2 full teams formed in round ${round + 1}`);
        return;
      }

      // Run all bots in parallel for this round
      const roundAbort = new AbortController();
      const roundTimeout = setTimeout(() => roundAbort.abort(), roundTimeMs);

      // Only run bots that aren't on a full team yet
      const activeBots = botIds.filter((id) => {
        const teamId = this.lobby.agentTeam.get(id);
        if (!teamId) return true;
        const team = this.lobby.teams.get(teamId);
        return !team || team.members.length < this.teamSize;
      });

      const promises = activeBots.map((botId) =>
        this.runLobbyBot(botId, round + 1, roundAbort).catch((err) => {
          if (err.name !== 'AbortError') {
            console.error(`Lobby bot ${botId} error:`, err.message ?? err);
          }
        }),
      );

      await Promise.all(promises);
      clearTimeout(roundTimeout);
      this.emitState();
    }
  }

  private async runLobbyBot(
    botId: string,
    round: number,
    roundAbort: AbortController,
  ): Promise<void> {
    const lobby = this.lobby;
    const self = this;
    const agent = lobby.agents.get(botId);
    const handle = agent?.handle ?? botId;

    const mcpServer = createSdkMcpServer({
      name: `lobby-${botId}`,
      version: '0.1.0',
      tools: [
        tool(
          'get_lobby',
          'Get the current lobby state: who is here, teams formed, recent chat messages.',
          {},
          async () => {
            const state = lobby.getLobbyState(botId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }] };
          },
        ),
        tool(
          'lobby_chat',
          'Send a message visible to everyone in the lobby.',
          { message: z.string().describe('Your message to the lobby') },
          async ({ message }) => {
            lobby.lobbyChat(botId, message);
            self.emitState();
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
          },
        ),
        tool(
          'propose_team',
          'Propose to team up with another agent. If neither of you is on a team, creates a new team. If one of you is on a team, invites the other.',
          { targetAgentId: z.string().describe('The ID of the agent to team up with') },
          async ({ targetAgentId }) => {
            const result = lobby.proposeTeam(botId, targetAgentId);
            self.emitState();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          },
        ),
        tool(
          'accept_team',
          'Accept an invitation to join a team.',
          { teamId: z.string().describe('The team ID to accept') },
          async ({ teamId }) => {
            const result = lobby.acceptTeam(botId, teamId);
            self.emitState();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          },
        ),
      ],
    });

    const serverName = `lobby-${botId}`;
    const prompt = `Round ${round}. You are ${handle} (${botId}). Check the lobby state, chat with others, and try to form a team of ${this.teamSize}. Be social and decisive!`;

    const localAbort = new AbortController();
    // Abort if either the round or the runner is aborted
    const onRoundAbort = () => localAbort.abort();
    const onRunnerAbort = () => localAbort.abort();
    roundAbort.signal.addEventListener('abort', onRoundAbort);
    this.abortController.signal.addEventListener('abort', onRunnerAbort);

    const timeout = setTimeout(() => localAbort.abort(), 20000);

    try {
      const q = query({
        prompt,
        options: {
          systemPrompt: LOBBY_SYSTEM_PROMPT,
          model: 'haiku',
          tools: [],
          mcpServers: { [serverName]: mcpServer },
          allowedTools: [
            `mcp__${serverName}__get_lobby`,
            `mcp__${serverName}__lobby_chat`,
            `mcp__${serverName}__propose_team`,
            `mcp__${serverName}__accept_team`,
          ],
          maxTurns: 6,
          abortController: localAbort,
          persistSession: false,
          cwd: '/tmp',
        },
      });

      for await (const _msg of q) {
        // drain
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
      roundAbort.signal.removeEventListener('abort', onRoundAbort);
      this.abortController.signal.removeEventListener('abort', onRunnerAbort);
    }
  }

  // ---------------------------------------------------------------------------
  // Pre-game phase: bots pick classes
  // ---------------------------------------------------------------------------

  private async runPreGamePhase(playerIds: string[]): Promise<void> {
    const preGameTimeout = setTimeout(() => {
      // Time's up — assign defaults
    }, 30000);

    const promises = playerIds.map((id) =>
      this.runPreGameBot(id).catch((err) => {
        if (err.name !== 'AbortError') {
          console.error(`Pre-game bot ${id} error:`, err.message ?? err);
        }
      }),
    );

    await Promise.all(promises);
    clearTimeout(preGameTimeout);

    // Assign default classes to anyone who didn't pick
    const classes: UnitClass[] = ['rogue', 'knight', 'mage'];
    let idx = 0;
    for (const [, player] of this.lobby.preGamePlayers) {
      if (!player.unitClass) {
        player.unitClass = classes[idx % classes.length];
        idx++;
      }
    }

    this.emitState();
  }

  private async runPreGameBot(botId: string): Promise<void> {
    const lobby = this.lobby;
    const self = this;
    const agent = lobby.agents.get(botId);
    const handle = agent?.handle ?? botId;
    const player = lobby.preGamePlayers.get(botId);
    const team = player?.team ?? 'A';

    const mcpServer = createSdkMcpServer({
      name: `pregame-${botId}`,
      version: '0.1.0',
      tools: [
        tool(
          'get_team_state',
          'Get your team state: teammates, their class picks, and time remaining.',
          {},
          async () => {
            const state = lobby.getTeamState(botId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(state, null, 2) }] };
          },
        ),
        tool(
          'team_chat',
          'Send a message to your teammates only.',
          { message: z.string().describe('Message to your team') },
          async ({ message }) => {
            lobby.teamChat(botId, message);
            self.emitState();
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }] };
          },
        ),
        tool(
          'choose_class',
          'Choose your unit class for the game.',
          {
            unitClass: z.enum(['rogue', 'knight', 'mage']).describe('Your class choice'),
          },
          async ({ unitClass }) => {
            const result = lobby.chooseClass(botId, unitClass as UnitClass);
            self.emitState();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          },
        ),
      ],
    });

    const serverName = `pregame-${botId}`;
    const prompt = `Pre-game class selection. You are ${handle} (${botId}) on Team ${team}. Check your team state, discuss with teammates, and pick your class. You have 30 seconds!`;

    const localAbort = new AbortController();
    const onRunnerAbort = () => localAbort.abort();
    this.abortController.signal.addEventListener('abort', onRunnerAbort);
    const timeout = setTimeout(() => localAbort.abort(), 25000);

    try {
      const q = query({
        prompt,
        options: {
          systemPrompt: PREGAME_SYSTEM_PROMPT,
          model: 'haiku',
          tools: [],
          mcpServers: { [serverName]: mcpServer },
          allowedTools: [
            `mcp__${serverName}__get_team_state`,
            `mcp__${serverName}__team_chat`,
            `mcp__${serverName}__choose_class`,
          ],
          maxTurns: 5,
          abortController: localAbort,
          persistSession: false,
          cwd: '/tmp',
        },
      });

      for await (const _msg of q) {
        // drain
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener('abort', onRunnerAbort);
    }
  }
}
