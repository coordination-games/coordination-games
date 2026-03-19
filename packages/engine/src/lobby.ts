// Lobby and matchmaking system for Capture the Lobster
// Manages team formation, pre-game class selection, and game creation

import { UnitClass } from './movement.js';
import { GameManager, GameConfig } from './game.js';
import { generateMap } from './map.js';

export interface LobbyAgent {
  id: string;
  handle: string;
  elo: number;
}

export interface LobbyTeam {
  id: string;
  members: string[]; // agent IDs
  invites: Set<string>; // pending invite agent IDs
}

export interface LobbyMessage {
  from: string;
  message: string;
  timestamp: number;
}

export type LobbyPhase = 'forming' | 'pre_game' | 'starting';

export interface PreGamePlayer {
  id: string;
  team: 'A' | 'B';
  unitClass: UnitClass | null;
  ready: boolean;
}

let lobbyCounter = 0;

export class LobbyManager {
  readonly lobbyId: string;
  agents: Map<string, LobbyAgent>;
  teams: Map<string, LobbyTeam>;
  agentTeam: Map<string, string>; // agentId -> teamId
  chat: LobbyMessage[];
  phase: LobbyPhase;
  teamSize: number;

  // Pre-game state
  preGamePlayers: Map<string, PreGamePlayer>;
  preGameChat: { A: LobbyMessage[]; B: LobbyMessage[] };
  private preGameStartTime: number;
  private preGameTimerSeconds: number;

  // Team assignments for pre-game
  private teamAIds: string[];
  private teamBIds: string[];

  constructor(lobbyId?: string, teamSize?: number) {
    this.lobbyId = lobbyId ?? `lobby_${++lobbyCounter}`;
    this.agents = new Map();
    this.teams = new Map();
    this.agentTeam = new Map();
    this.chat = [];
    this.phase = 'forming';
    this.teamSize = teamSize ?? 4;

    this.preGamePlayers = new Map();
    this.preGameChat = { A: [], B: [] };
    this.preGameStartTime = 0;
    this.preGameTimerSeconds = 30;
    this.teamAIds = [];
    this.teamBIds = [];
  }

  // --- Join / Leave ---

  addAgent(agent: LobbyAgent): void {
    this.agents.set(agent.id, agent);
  }

  removeAgent(agentId: string): void {
    this.agents.delete(agentId);

    // Remove from any team
    const teamId = this.agentTeam.get(agentId);
    if (teamId) {
      const team = this.teams.get(teamId);
      if (team) {
        team.members = team.members.filter((id) => id !== agentId);
        team.invites.delete(agentId);
        // If team is now empty, remove it
        if (team.members.length === 0) {
          this.teams.delete(teamId);
        }
      }
      this.agentTeam.delete(agentId);
    }

    // Remove from all invite lists
    for (const team of this.teams.values()) {
      team.invites.delete(agentId);
    }
  }

  leaveTeam(agentId: string): { success: boolean; error?: string } {
    const teamId = this.agentTeam.get(agentId);
    if (!teamId) {
      return { success: false, error: 'not on a team' };
    }
    const team = this.teams.get(teamId);
    if (team) {
      team.members = team.members.filter((id) => id !== agentId);
      team.invites.delete(agentId);
      if (team.members.length === 0) {
        this.teams.delete(teamId);
      }
    }
    this.agentTeam.delete(agentId);
    return { success: true };
  }

  // --- Team Formation ---

  private nextTeamId = 0;

  proposeTeam(
    fromAgentId: string,
    toAgentId: string,
  ): { success: boolean; teamId?: string; error?: string } {
    const fromTeamId = this.agentTeam.get(fromAgentId);
    const toTeamId = this.agentTeam.get(toAgentId);

    // Both on teams already
    if (fromTeamId && toTeamId) {
      return { success: false, error: 'both agents already on teams' };
    }

    // Target already on a team and fromAgent is solo: invite fromAgent to toAgent's team
    if (toTeamId && !fromTeamId) {
      const team = this.teams.get(toTeamId)!;
      if (team.members.length >= this.teamSize) {
        return { success: false, error: 'team is full' };
      }
      team.invites.add(fromAgentId);
      return { success: true, teamId: toTeamId };
    }

    // fromAgent is on a team and toAgent is solo: invite toAgent
    if (fromTeamId && !toTeamId) {
      const team = this.teams.get(fromTeamId)!;
      if (team.members.length >= this.teamSize) {
        return { success: false, error: 'team is full' };
      }
      team.invites.add(toAgentId);
      return { success: true, teamId: fromTeamId };
    }

    // Neither on a team: create new team with fromAgent, invite toAgent
    const teamId = `team_${++this.nextTeamId}`;
    const team: LobbyTeam = {
      id: teamId,
      members: [fromAgentId],
      invites: new Set([toAgentId]),
    };
    this.teams.set(teamId, team);
    this.agentTeam.set(fromAgentId, teamId);
    return { success: true, teamId };
  }

  acceptTeam(
    agentId: string,
    teamId: string,
  ): { success: boolean; error?: string } {
    const team = this.teams.get(teamId);
    if (!team) {
      return { success: false, error: 'team not found' };
    }

    if (!team.invites.has(agentId)) {
      return { success: false, error: 'not invited to this team' };
    }

    if (team.members.length >= this.teamSize) {
      return { success: false, error: 'team is full' };
    }

    team.invites.delete(agentId);
    team.members.push(agentId);
    this.agentTeam.set(agentId, teamId);
    return { success: true };
  }

  // --- Chat ---

  lobbyChat(agentId: string, message: string): void {
    this.chat.push({
      from: agentId,
      message,
      timestamp: Date.now(),
    });
  }

  // --- State Query ---

  getLobbyState(agentId: string): {
    lobbyId: string;
    agents: { id: string; elo: number; handle: string; team: string | null }[];
    teams: Record<string, string[]>;
    chat: LobbyMessage[];
  } {
    const agents = Array.from(this.agents.values()).map((a) => ({
      id: a.id,
      elo: a.elo,
      handle: a.handle,
      team: this.agentTeam.get(a.id) ?? null,
    }));

    const teams: Record<string, string[]> = {};
    for (const [id, team] of this.teams) {
      teams[id] = [...team.members];
    }

    return {
      lobbyId: this.lobbyId,
      agents,
      teams,
      chat: [...this.chat],
    };
  }

  // --- Auto-merge ---

  autoMergeTeams(teamSize: number): {
    teams: { id: string; members: string[] }[];
    orphans: string[];
  } {
    // Get all free agents (not on any team)
    const freeAgents: string[] = [];
    for (const agentId of this.agents.keys()) {
      if (!this.agentTeam.has(agentId)) {
        freeAgents.push(agentId);
      }
    }

    // Get incomplete teams
    const incompleteTeams: LobbyTeam[] = [];
    for (const team of this.teams.values()) {
      if (team.members.length < teamSize) {
        incompleteTeams.push(team);
      }
    }

    // Fill incomplete teams first
    let freeIdx = 0;
    for (const team of incompleteTeams) {
      while (team.members.length < teamSize && freeIdx < freeAgents.length) {
        const agentId = freeAgents[freeIdx++];
        team.members.push(agentId);
        this.agentTeam.set(agentId, team.id);
      }
    }

    // Form new teams from remaining free agents
    const newTeams: LobbyTeam[] = [];
    while (freeIdx + teamSize <= freeAgents.length) {
      const teamId = `team_${++this.nextTeamId}`;
      const members = freeAgents.slice(freeIdx, freeIdx + teamSize);
      freeIdx += teamSize;
      const team: LobbyTeam = {
        id: teamId,
        members,
        invites: new Set(),
      };
      this.teams.set(teamId, team);
      for (const m of members) {
        this.agentTeam.set(m, teamId);
      }
      newTeams.push(team);
    }

    // Remaining are orphans
    const orphans = freeAgents.slice(freeIdx);

    // Collect all teams that are now complete
    const resultTeams: { id: string; members: string[] }[] = [];
    for (const team of this.teams.values()) {
      if (team.members.length === teamSize) {
        resultTeams.push({ id: team.id, members: [...team.members] });
      }
    }

    // Also include incomplete teams that were filled
    // (they're already in the teams map, captured above)

    return { teams: resultTeams, orphans };
  }

  // --- Pre-game ---

  startPreGame(teamA: string[], teamB: string[]): void {
    this.phase = 'pre_game';
    this.teamAIds = teamA;
    this.teamBIds = teamB;
    this.preGameStartTime = Date.now();
    this.preGamePlayers.clear();
    this.preGameChat = { A: [], B: [] };

    for (const id of teamA) {
      this.preGamePlayers.set(id, {
        id,
        team: 'A',
        unitClass: null,
        ready: false,
      });
    }
    for (const id of teamB) {
      this.preGamePlayers.set(id, {
        id,
        team: 'B',
        unitClass: null,
        ready: false,
      });
    }
  }

  chooseClass(
    agentId: string,
    unitClass: UnitClass,
  ): { success: boolean; error?: string } {
    if (this.phase !== 'pre_game') {
      return { success: false, error: 'not in pre-game phase' };
    }

    const player = this.preGamePlayers.get(agentId);
    if (!player) {
      return { success: false, error: 'player not in pre-game' };
    }

    player.unitClass = unitClass;
    return { success: true };
  }

  teamChat(agentId: string, message: string): void {
    const player = this.preGamePlayers.get(agentId);
    if (!player) return;

    this.preGameChat[player.team].push({
      from: agentId,
      message,
      timestamp: Date.now(),
    });
  }

  getTeamState(
    agentId: string,
  ): {
    teamId: string;
    members: PreGamePlayer[];
    timeRemainingSeconds: number;
  } | null {
    const player = this.preGamePlayers.get(agentId);
    if (!player) return null;

    const team = player.team;
    const teamIds = team === 'A' ? this.teamAIds : this.teamBIds;
    const members = teamIds
      .map((id) => this.preGamePlayers.get(id)!)
      .filter(Boolean);

    const elapsed = (Date.now() - this.preGameStartTime) / 1000;
    const remaining = Math.max(0, this.preGameTimerSeconds - elapsed);

    return {
      teamId: team,
      members,
      timeRemainingSeconds: Math.round(remaining),
    };
  }

  // --- Game Creation ---

  createGame(mapSeed?: string): GameManager {
    if (this.phase !== 'pre_game') {
      throw new Error('Cannot create game outside pre-game phase');
    }

    if (this.teamAIds.length === 0 || this.teamBIds.length === 0) {
      throw new Error('Need exactly 2 teams to start a game');
    }

    this.phase = 'starting';

    const map = generateMap({ seed: mapSeed ?? `game_${this.lobbyId}` });

    const players: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[] =
      [];

    for (const id of this.teamAIds) {
      const player = this.preGamePlayers.get(id);
      players.push({
        id,
        team: 'A',
        unitClass: player?.unitClass ?? 'rogue',
      });
    }

    for (const id of this.teamBIds) {
      const player = this.preGamePlayers.get(id);
      players.push({
        id,
        team: 'B',
        unitClass: player?.unitClass ?? 'rogue',
      });
    }

    const config: GameConfig = {
      teamSize: Math.max(this.teamAIds.length, this.teamBIds.length),
    };

    return new GameManager(
      `game_${this.lobbyId}`,
      map,
      players,
      config,
    );
  }
}
