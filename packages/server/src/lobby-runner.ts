/**
 * Lobby runner: orchestrates a lobby through team formation and pre-game phases.
 * Creates a LobbyManager, waits for external agents to join, handles team formation,
 * pre-game class selection, and game creation.
 */

import {
  LobbyManager,
  LobbyAgent,
  UnitClass,
} from '@coordination-games/game-ctl';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LobbyRunnerPhase =
  | 'forming'    // waiting for agents to join / negotiate teams
  | 'pre_game'   // agents picking classes
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

      await this.waitForPreGame();
      if (this.abortController.signal.aborted) return;

      this.assignDefaultClasses();
      this.emitState();

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
      if (!this.noTimeout && Date.now() - startTime > this.timeoutMs) {
        console.log('Lobby timeout reached');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  private async waitForPreGame(): Promise<void> {
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
}
