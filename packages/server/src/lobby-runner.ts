/**
 * Lobby runner: orchestrates a lobby with Claude Agent SDK bots.
 * Creates a LobbyManager, waits for agents to join (bots or external),
 * handles team formation, pre-game class selection, and game creation.
 *
 * Bots connect via spawned `coga serve --bot-mode` subprocesses — they
 * authenticate via challenge-response using ephemeral keys and run the
 * full client-side plugin pipeline.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'node:crypto';
import {
  LobbyManager,
  LobbyAgent,
  UnitClass,
} from '@coordination-games/game-ctl';
import { createBotMcpConfig } from './claude-bot.js';

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
  teams: Record<string, { members: string[]; invites: string[] }>;
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
// Generic system prompts for lobby bots
// ---------------------------------------------------------------------------

const LOBBY_SYSTEM_PROMPT = `You are a competitive AI agent in a game lobby. You connect to the server via MCP tools.

## What to do:
1. Use get_guide() on your first round to learn about the game
2. Check lobby state and chat with others
3. Form teams by proposing/accepting team invitations
4. Be social and decisive — the lobby has a time limit!

Keep your messages short and fun. You're a competitive AI with personality.`;

const PREGAME_SYSTEM_PROMPT = `You are picking your class/role for a team game. You connect to the server via MCP tools.

## What to do:
1. Check your team state to see teammates and their picks
2. Chat with teammates to coordinate
3. Pick your class/role based on team composition

Be quick and coordinate with your team!`;

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
  /** Ephemeral private keys for bot auth */
  private botKeys: Map<string, string> = new Map();
  /** Counter for unique bot names */
  private botIndex: number = 0;
  /** Server URL for bot connections (base URL, no /mcp suffix) */
  private serverUrl: string;

  constructor(
    teamSize: number = 2,
    timeoutMs: number = 240000,
    callbacks: LobbyRunnerCallbacks,
    serverUrl?: string,
  ) {
    this.lobby = new LobbyManager(undefined, teamSize);
    this.callbacks = callbacks;
    this.timeoutMs = timeoutMs;
    this.teamSize = teamSize;
    this.abortController = new AbortController();
    this.serverUrl = serverUrl ?? `http://localhost:${process.env.PORT || 5173}`;
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

    // Generate an ephemeral private key for this bot's auth
    const key = '0x' + crypto.randomBytes(32).toString('hex');
    this.botKeys.set(id, key);

    this.emitState();

    // Start running this bot's lobby behavior in the background (3-4 rounds)
    if (this.phase === 'forming') {
      this.runBotLobbyBehavior(id).catch((err) => {
        console.error(`Bot ${id} lobby behavior error:`, err.message ?? err);
      });
    }

    return { agentId: id, handle };
  }

  /** Check if an agent ID is a bot */
  isBot(agentId: string): boolean {
    return this.botIds.has(agentId);
  }

  /**
   * Run lobby behavior for a single bot in the background.
   * More rounds for larger teams since there's more negotiation needed.
   */
  private async runBotLobbyBehavior(botId: string): Promise<void> {
    const maxRounds = 4 + this.teamSize * 3;
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

      const gameId = `game_${this.lobby.lobbyId}`;
      this.lobby.createGame(); // transitions lobby to 'starting' phase
      this.gameId = gameId;
      this.phase = 'game';
      this.emitState();

      this.callbacks.onGameCreated(gameId, teamPlayers, handles);
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
  // Single bot lobby round — spawns coga subprocess via stdio
  // ---------------------------------------------------------------------------

  private async runLobbyBot(
    botId: string,
    round: number,
  ): Promise<void> {
    const agent = this.lobby.agents.get(botId);
    const handle = agent?.handle ?? botId;
    const key = this.botKeys.get(botId);
    if (!key) {
      console.error(`[LobbyBot] No key for bot ${botId}`);
      return;
    }

    const mcpServerName = 'game-server';
    const mcpConfig = createBotMcpConfig(handle, key, this.serverUrl);

    const prompt = round === 1
      ? `You just joined a lobby. You are ${handle} (${botId}). Call get_guide() first to learn the rules, then check the lobby state, chat with others, and try to form a team of ${this.teamSize}. Be social and decisive!`
      : `Round ${round}. You are ${handle} (${botId}). Check the lobby state, chat with others, and try to form a team of ${this.teamSize}. Be social and decisive!`;

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
          mcpServers: { [mcpServerName]: mcpConfig },
          allowedTools: [`mcp__${mcpServerName}__*`],
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
  // Pre-game phase: bots pick classes — spawns coga subprocess via stdio
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
    const agent = this.lobby.agents.get(botId);
    const handle = agent?.handle ?? botId;
    const player = this.lobby.preGamePlayers.get(botId);
    const team = player?.team ?? 'A';
    const key = this.botKeys.get(botId);
    if (!key) {
      console.error(`[PreGameBot] No key for bot ${botId}`);
      return;
    }

    const mcpServerName = 'game-server';
    const mcpConfig = createBotMcpConfig(handle, key, this.serverUrl);

    const prompt = mode === 'discuss'
      ? `Pre-game discussion. You are ${handle} (${botId}) on Team ${team}. Check your team state, then chat about strategy and class composition. DON'T pick your class yet — just discuss who should play what role. A good team needs a mix of classes!`
      : `Time to pick! You are ${handle} (${botId}) on Team ${team}. Check what your teammates said and picked, then choose your class based on what the team agreed. If no agreement, pick what the team is missing.`;

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
          mcpServers: { [mcpServerName]: mcpConfig },
          allowedTools: [`mcp__${mcpServerName}__*`],
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
