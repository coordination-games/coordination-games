/**
 * Lobby runner: orchestrates a lobby with Claude Agent SDK bots.
 * Creates a LobbyManager, waits for agents to join (bots or external),
 * handles team formation, pre-game class selection, and game creation.
 *
 * Bots use in-process MCP via Agent SDK, backed by GameClient (REST + pipeline).
 * Same code path as real players via CLI.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  LobbyManager,
  LobbyAgent,
  UnitClass,
} from '@coordination-games/game-ctl';
import { GameClient } from './game-client.js';
import { createBotToken } from './mcp-http.js';
import { createBotMcpServer } from './claude-bot.js';
import { BasicChatPlugin } from '@coordination-games/plugin-chat';
import { RationalePlugin } from '@coordination-games/plugin-rationale';
import type { ToolPlugin } from '@coordination-games/engine';

const DEFAULT_PLUGINS: ToolPlugin[] = [BasicChatPlugin, RationalePlugin];

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
// System prompts
// ---------------------------------------------------------------------------

const LOBBY_SYSTEM_PROMPT = `You are a competitive AI agent in a game lobby.

## What to do:
1. Use get_guide() on your first round to learn about the game
2. Check lobby state and chat with others
3. Form teams by proposing/accepting team invitations
4. Be social and decisive — the lobby has a time limit!

Keep your messages short and fun. You're a competitive AI with personality.`;

const PREGAME_SYSTEM_PROMPT = `You are picking your class/role for a team game.

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
  /** Tracks which agent IDs are bots (vs external agents) */
  private botIds: Set<string> = new Set();
  /** Auth tokens for bot REST API access */
  private botTokens: Map<string, string> = new Map();
  /** GameClient instances for bot API access */
  private botClients: Map<string, GameClient> = new Map();
  /** Agent SDK session IDs for lobby-phase bot conversations */
  private lobbySessionIds: Map<string, string> = new Map();
  /** Agent SDK session IDs for pre-game bot conversations */
  private preGameSessionIds: Map<string, string> = new Map();
  /** Counter for unique bot names */
  private botIndex: number = 0;
  /** Server URL for bot REST API calls */
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
      const players: any[] = [];
      for (const [, p] of this.lobby.preGamePlayers) {
        players.push({
          id: p.id,
          team: p.team,
          unitClass: p.unitClass,
          ready: p.ready,
        });
      }
      const elapsed = (Date.now() - (this.lobby as any).preGameStartTime) / 1000;
      const remaining = Math.max(0, 300 - elapsed);
      preGame = {
        players,
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

    // Create auth token and GameClient for this bot
    const token = createBotToken(id, handle);
    this.botTokens.set(id, token);
    this.botClients.set(id, new GameClient(this.serverUrl, { token }));

    this.emitState();

    if (this.phase === 'forming') {
      this.runBotLobbyBehavior(id).catch((err) => {
        console.error(`Bot ${id} lobby behavior error:`, err.message ?? err);
      });
    }

    return { agentId: id, handle };
  }

  isBot(agentId: string): boolean {
    return this.botIds.has(agentId);
  }

  private async runBotLobbyBehavior(botId: string): Promise<void> {
    const maxRounds = 4 + this.teamSize * 3;
    for (let round = 0; round < maxRounds; round++) {
      if (this.abortController.signal.aborted) return;
      if (this.phase !== 'forming') return;

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

  async run(): Promise<void> {
    try {
      this.emitState();
      await this.waitForTeams();
      if (this.abortController.signal.aborted) return;

      const fullTeams = this.getFullTeams();
      if (fullTeams.length < 2) {
        console.log('Not enough teams formed naturally, auto-merging...');
        this.lobby.autoMergeTeams(this.teamSize);
        this.emitState();
      }

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

      const botPlayerIds = [...teamA, ...teamB].filter((id) => this.botIds.has(id));
      await this.runPreGamePhase(botPlayerIds);
      if (this.abortController.signal.aborted) return;

      this.phase = 'starting';
      this.emitState();

      const teamPlayers: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[] = [];
      for (const [, p] of this.lobby.preGamePlayers) {
        teamPlayers.push({ id: p.id, team: p.team, unitClass: p.unitClass ?? 'rogue' });
      }

      const handles: Record<string, string> = {};
      for (const [id, agent] of this.lobby.agents) {
        handles[id] = agent.handle;
      }

      const gameId = `game_${this.lobby.lobbyId}`;
      this.lobby.createGame();
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

  private async waitForTeams(): Promise<void> {
    const startTime = Date.now();
    while (!this.abortController.signal.aborted) {
      if (this.getFullTeams().length >= 2) {
        console.log('2 full teams formed!');
        return;
      }
      const totalAgents = this.lobby.agents.size;
      if (totalAgents >= this.teamSize * 2) {
        const allBots = [...this.lobby.agents.keys()].every((id) => this.botIds.has(id));
        if (allBots && Date.now() - startTime > 5000) return;
        if (this.getFullTeams().length >= 2) return;
      }
      if (!this.noTimeout && Date.now() - startTime > this.timeoutMs) {
        console.log('Lobby timeout reached');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // ---------------------------------------------------------------------------
  // Lobby bot round — Agent SDK + in-process MCP backed by GameClient
  // ---------------------------------------------------------------------------

  private async runLobbyBot(botId: string, round: number): Promise<void> {
    const agent = this.lobby.agents.get(botId);
    const handle = agent?.handle ?? botId;
    const client = this.botClients.get(botId);
    if (!client) return;

      const mcpServer = createBotMcpServer(client, DEFAULT_PLUGINS);
    const serverName = 'game-server';

    const prompt = round === 1
      ? `You just joined a lobby. You are ${handle} (${botId}). Call get_guide() first, then check lobby state, chat with others, and form a team of ${this.teamSize}.`
      : `Round ${round}. You are ${handle} (${botId}). Check lobby state, chat, and form a team of ${this.teamSize}.`;

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
          allowedTools: [`mcp__${serverName}__*`],
          maxTurns: 6,
          abortController: localAbort,
          cwd: '/tmp',
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
      this.lobbySessionIds.delete(botId);
    } finally {
      clearTimeout(timeout);
      this.abortController.signal.removeEventListener('abort', onRunnerAbort);
    }
  }

  // ---------------------------------------------------------------------------
  // Pre-game phase — Agent SDK + in-process MCP backed by GameClient
  // ---------------------------------------------------------------------------

  private async runPreGamePhase(botPlayerIds: string[]): Promise<void> {
    if (botPlayerIds.length === 0) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const check = setInterval(() => {
          const allPicked = [...this.lobby.preGamePlayers.values()].every(p => p.unitClass);
          if (allPicked) { clearInterval(check); finish(); }
        }, 1000);
        if (!this.noTimeout) setTimeout(() => { clearInterval(check); finish(); }, 300000);
        this.abortController.signal.addEventListener('abort', () => { clearInterval(check); finish(); }, { once: true });
      });
      this.assignDefaultClasses();
      this.emitState();
      return;
    }

    console.log('[PreGame] Round 1: Discussion');
    await Promise.all(botPlayerIds.map((id) =>
      this.runPreGameBot(id, 'discuss').catch((err) => {
        if (err.name !== 'AbortError') console.error(`Pre-game discuss bot ${id} error:`, err.message ?? err);
      }),
    ));

    console.log('[PreGame] Round 2: Class selection');
    await Promise.all(botPlayerIds.map((id) =>
      this.runPreGameBot(id, 'pick').catch((err) => {
        if (err.name !== 'AbortError') console.error(`Pre-game pick bot ${id} error:`, err.message ?? err);
      }),
    ));

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

  private async runPreGameBot(botId: string, mode: 'discuss' | 'pick'): Promise<void> {
    const agent = this.lobby.agents.get(botId);
    const handle = agent?.handle ?? botId;
    const player = this.lobby.preGamePlayers.get(botId);
    const team = player?.team ?? 'A';
    const client = this.botClients.get(botId);
    if (!client) return;

      const mcpServer = createBotMcpServer(client, DEFAULT_PLUGINS);
    const serverName = 'game-server';

    const prompt = mode === 'discuss'
      ? `Pre-game discussion. You are ${handle} (${botId}) on Team ${team}. Check team state, chat about strategy and class composition. DON'T pick your class yet — just discuss!`
      : `Time to pick! You are ${handle} (${botId}) on Team ${team}. Check teammates' picks, then choose your class.`;

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
          allowedTools: [`mcp__${serverName}__*`],
          maxTurns: 5,
          abortController: localAbort,
          cwd: '/tmp',
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
