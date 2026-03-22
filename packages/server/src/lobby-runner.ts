/**
 * Lobby runner: orchestrates a lobby with Claude Agent SDK bots.
 * Creates a LobbyManager, waits for agents to join (bots or external),
 * handles team formation, pre-game class selection, and game creation.
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
  | 'forming'    // waiting for agents to join / negotiate teams
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
    chatA: { from: string; message: string; timestamp: number }[];
    chatB: { from: string; message: string; timestamp: number }[];
  } | null;
  gameId: string | null;
  error: string | null;
  teamSize: number;
  noTimeout: boolean;
  timeRemainingSeconds: number;
}

export interface LobbyRunnerCallbacks {
  onStateChange: (state: LobbyRunnerState) => void;
  onGameCreated: (gameId: string, teamPlayers: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[], handles: Record<string, string>) => void;
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
5. Use leave_team if you're stuck on a team that isn't filling up — leave and try a different partner

## Strategy
- Be social! Chat with others before proposing teams
- Look at other agents' handles and ELO ratings
- Try to form a strong team
- Once you have a team invite, accept it quickly
- If your team is incomplete and stuck, leave and try someone else
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
  private noTimeout: boolean = false;
  private gameId: string | null = null;
  private error: string | null = null;
  private abortController: AbortController;
  private teamSize: number;
  private createdAt: number = Date.now();
  /** Session IDs for persistent bot conversations (lobby phase) */
  private lobbySessionIds: Map<string, string> = new Map();
  /** Session IDs for persistent bot conversations (pre-game phase) */
  private preGameSessionIds: Map<string, string> = new Map();
  /** Tracks which agent IDs are bots (vs external agents) */
  private botIds: Set<string> = new Set();
  /** Counter for unique bot names */
  private botIndex: number = 0;

  constructor(
    teamSize: number = 2,
    timeoutMs: number = 240000,
    callbacks: LobbyRunnerCallbacks,
  ) {
    this.lobby = new LobbyManager(undefined, teamSize);
    this.callbacks = callbacks;
    this.timeoutMs = timeoutMs;
    this.teamSize = teamSize;
    this.abortController = new AbortController();
  }

  disableTimeout(): void {
    this.noTimeout = true;
  }

  stop(): void {
    this.abortController.abort();
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
      const remaining = Math.max(0, 300 - elapsed);
      preGame = {
        players: players as any,
        timeRemainingSeconds: Math.round(remaining),
        chatA: this.lobby.preGameChat.A,
        chatB: this.lobby.preGameChat.B,
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
      teamSize: this.teamSize,
      noTimeout: this.noTimeout,
      timeRemainingSeconds: this.noTimeout ? -1 : Math.max(0, Math.round((this.timeoutMs - (Date.now() - this.createdAt)) / 1000)),
    };
  }

  emitState(): void {
    this.callbacks.onStateChange(this.getState());
  }

  /**
   * Add a bot to the lobby. Creates a bot with a fun name and random ELO,
   * adds it to the lobby, and starts running its lobby behavior in the background.
   * Returns the bot's agent ID and handle.
   */
  addBot(): { agentId: string; handle: string } {
    const handle = BOT_NAMES[this.botIndex % BOT_NAMES.length];
    const id = `agent_${this.botIndex + 1}`;
    this.botIndex++;

    const agent: LobbyAgent = {
      id,
      handle,
      elo: 1000 + Math.floor(Math.random() * 200),
    };
    this.lobby.addAgent(agent);
    this.botIds.add(id);
    this.emitState();

    // Start running this bot's lobby behavior in the background (3-4 rounds)
    if (this.phase === 'forming') {
      this.runBotLobbyBehavior(id).catch((err) => {
        console.error(`Bot ${id} lobby behavior error:`, err.message ?? err);
      });
    }

    return { agentId: id, handle };
  }

  /**
   * Run lobby behavior for a single bot in the background (3-4 rounds).
   */
  private async runBotLobbyBehavior(botId: string): Promise<void> {
    const maxRounds = 8;
    for (let round = 0; round < maxRounds; round++) {
      if (this.abortController.signal.aborted) return;
      if (this.phase !== 'forming') return;

      // Wait if bot is already on a full team (but don't exit — team might break up)
      const teamId = this.lobby.agentTeam.get(botId);
      if (teamId) {
        const team = this.lobby.teams.get(teamId);
        if (team && team.members.length >= this.teamSize) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
      }

      await this.runLobbyBot(botId, round + 1).catch((err) => {
        if (err.name !== 'AbortError') {
          console.error(`Lobby bot ${botId} round ${round + 1} error:`, err.message ?? err);
        }
      });
      this.emitState();
    }
  }

  /**
   * Run the full lobby lifecycle: wait for agents -> pre_game -> game creation
   */
  async run(): Promise<void> {
    try {
      this.emitState();

      // 1. Wait for 2 full teams to form
      await this.waitForTeams();

      if (this.abortController.signal.aborted) return;

      // 2. Check if we have enough teams, auto-merge if needed
      const fullTeams = this.getFullTeams();
      if (fullTeams.length < 2) {
        console.log('Not enough teams formed naturally, auto-merging...');
        this.lobby.autoMergeTeams(this.teamSize);
        this.emitState();
      }

      // 3. Pick the first 2 full teams and start pre-game
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

      // 4. Run pre-game class selection (only for bots)
      const botPlayerIds = [...teamA, ...teamB].filter((id) => this.botIds.has(id));
      await this.runPreGamePhase(botPlayerIds);

      if (this.abortController.signal.aborted) return;

      // 5. Create the game
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

      // Build handle map from lobby agents
      const handles: Record<string, string> = {};
      for (const [id, agent] of this.lobby.agents) {
        handles[id] = agent.handle;
      }

      const game = this.lobby.createGame();
      this.gameId = game.gameId;
      this.phase = 'game';
      this.emitState();

      this.callbacks.onGameCreated(game.gameId, teamPlayers, handles);
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
  // Wait for teams: poll every 2 seconds until 2 full teams exist or timeout
  // ---------------------------------------------------------------------------

  private async waitForTeams(): Promise<void> {
    const startTime = Date.now();

    while (!this.abortController.signal.aborted) {
      // Check if we have 2 full teams
      if (this.getFullTeams().length >= 2) {
        console.log('2 full teams formed!');
        return;
      }

      // If enough agents AND all are bots, auto-merge quickly (no humans to negotiate)
      const totalAgents = this.lobby.agents.size;
      if (totalAgents >= this.teamSize * 2) {
        const allBots = [...this.lobby.agents.keys()].every((id) => this.botIds.has(id));
        if (allBots) {
          const elapsed = Date.now() - startTime;
          if (elapsed > 5000) return; // give bots 5s to chat then auto-merge
        }
        // Mixed or all-external: only auto-merge if 2 full teams already formed
        if (this.getFullTeams().length >= 2) return;
      }

      // Check timeout
      if (!this.noTimeout && Date.now() - startTime > this.timeoutMs) {
        console.log('Lobby timeout reached');
        return;
      }

      // Wait 2 seconds
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // ---------------------------------------------------------------------------
  // Single bot lobby round
  // ---------------------------------------------------------------------------

  private async runLobbyBot(
    botId: string,
    round: number,
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
        tool(
          'leave_team',
          'Leave your current team. Use this if your team is stuck or you want to join a different team.',
          {},
          async () => {
            const result = lobby.leaveTeam(botId);
            self.emitState();
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          },
        ),
      ],
    });

    const serverName = `lobby-${botId}`;
    const prompt = `Round ${round}. You are ${handle} (${botId}). Check the lobby state, chat with others, and try to form a team of ${this.teamSize}. Be social and decisive!`;

    const localAbort = new AbortController();
    const onRunnerAbort = () => localAbort.abort();
    this.abortController.signal.addEventListener('abort', onRunnerAbort);

    const timeout = setTimeout(() => localAbort.abort(), 20000);

    try {
      const existingSession = this.lobbySessionIds.get(botId);
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
            `mcp__${serverName}__leave_team`,
          ],
          maxTurns: 6,
          abortController: localAbort,
          cwd: '/tmp',
          // Resume existing session if we have one — bot remembers previous rounds
          ...(existingSession ? { resume: existingSession } : { persistSession: true }),
        },
      });

      for await (const msg of q) {
        if ('session_id' in msg && (msg as any).session_id && !existingSession) {
          this.lobbySessionIds.set(botId, (msg as any).session_id);
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err;
      // If session is corrupt, reset it
      this.lobbySessionIds.delete(botId);
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener('abort', onRunnerAbort);
    }
  }

  // ---------------------------------------------------------------------------
  // Pre-game phase: bots pick classes
  // ---------------------------------------------------------------------------

  private async runPreGamePhase(botPlayerIds: string[]): Promise<void> {
    if (botPlayerIds.length === 0) {
      // No bots — wait for external agents to pick classes
      // Resolve early once all players have chosen; respect noTimeout
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };

        const check = setInterval(() => {
          const allPicked = [...this.lobby.preGamePlayers.values()].every(p => p.unitClass);
          if (allPicked) { clearInterval(check); finish(); }
        }, 1000);

        if (!this.noTimeout) {
          setTimeout(() => { clearInterval(check); finish(); }, 300000);
        }

        this.abortController.signal.addEventListener('abort', () => {
          clearInterval(check); finish();
        }, { once: true });
      });
      this.assignDefaultClasses();
      this.emitState();
      return;
    }

    const preGameTimeout = setTimeout(() => {
      // Time's up — assign defaults
    }, 300000);

    // Round 1: Discuss — bots check team state and chat about strategy
    console.log('[PreGame] Round 1: Discussion');
    const discussPromises = botPlayerIds.map((id) =>
      this.runPreGameBot(id, 'discuss').catch((err) => {
        if (err.name !== 'AbortError') {
          console.error(`Pre-game discuss bot ${id} error:`, err.message ?? err);
        }
      }),
    );
    await Promise.all(discussPromises);

    // Round 2: Pick — bots read chat, then choose their class
    console.log('[PreGame] Round 2: Class selection');
    const pickPromises = botPlayerIds.map((id) =>
      this.runPreGameBot(id, 'pick').catch((err) => {
        if (err.name !== 'AbortError') {
          console.error(`Pre-game pick bot ${id} error:`, err.message ?? err);
        }
      }),
    );
    await Promise.all(pickPromises);

    clearTimeout(preGameTimeout);

    // Assign default classes to anyone who didn't pick
    this.assignDefaultClasses();
    this.emitState();
  }

  private assignDefaultClasses(): void {
    const classes: UnitClass[] = ['rogue', 'knight', 'mage'];
    let idx = 0;
    for (const [, player] of this.lobby.preGamePlayers) {
      if (!player.unitClass) {
        player.unitClass = classes[idx % classes.length];
        idx++;
      }
    }
  }

  private async runPreGameBot(botId: string, mode: 'discuss' | 'pick' = 'pick'): Promise<void> {
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
    const prompt = mode === 'discuss'
      ? `Pre-game discussion. You are ${handle} (${botId}) on Team ${team}. Check your team state with get_team_state, then use team_chat to discuss strategy and class composition with your teammates. DON'T pick your class yet — just discuss who should play what role. A good team needs a mix of classes!`
      : `Time to pick! You are ${handle} (${botId}) on Team ${team}. Check what your teammates said with get_team_state, read the team chat, then choose_class based on what the team agreed. If no agreement, pick what the team is missing.`;

    const localAbort = new AbortController();
    const onRunnerAbort = () => localAbort.abort();
    this.abortController.signal.addEventListener('abort', onRunnerAbort);
    const timeout = setTimeout(() => localAbort.abort(), 25000);

    try {
      const existingSession = this.preGameSessionIds.get(botId);
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
          cwd: '/tmp',
          // Resume existing session — bot remembers discussion from round 1
          ...(existingSession ? { resume: existingSession } : { persistSession: true }),
        },
      });

      for await (const msg of q) {
        if ('session_id' in msg && (msg as any).session_id && !existingSession) {
          this.preGameSessionIds.set(botId, (msg as any).session_id);
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') throw err;
      this.preGameSessionIds.delete(botId);
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener('abort', onRunnerAbort);
    }
  }
}
