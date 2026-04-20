/**
 * Team Formation Phase — request-driven LobbyPhase implementation.
 *
 * Players propose teams, accept invites, and leave teams.
 * On timeout, unassigned players are auto-merged into teams greedily.
 * Phase completes when `numTeams` teams of `teamSize` members exist.
 */

import type {
  AgentInfo,
  LobbyPhase,
  PhaseActionResult,
  PhaseResult,
  ToolDefinition,
} from '@coordination-games/engine';

// ---------------------------------------------------------------------------
// State types (JSON-serializable — no Map/Set)
// ---------------------------------------------------------------------------

export interface TeamFormationTeam {
  id: string;
  members: string[]; // player IDs
  invites: string[]; // pending invite player IDs
}

export interface TeamFormationState {
  teams: TeamFormationTeam[];
  unassigned: string[]; // player IDs not on any team
  teamCounter: number; // monotonic counter for team IDs
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TeamFormationConfig {
  teamSize: number;
  numTeams: number;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS: ToolDefinition[] = [
  {
    name: 'propose_team',
    description:
      'Propose teaming up with another player. Creates a new team or adds them to your existing team. The target receives an invite they must accept.',
    inputSchema: {
      type: 'object',
      properties: {
        targetHandle: {
          type: 'string',
          description: 'Handle (display name) of the player to invite',
        },
      },
      required: ['targetHandle'],
    },
    mcpExpose: true,
  },
  {
    name: 'accept_team',
    description: 'Accept a team invitation. Joins you to the team that invited you.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: {
          type: 'string',
          description: 'ID of the team to accept the invite for',
        },
      },
      required: ['teamId'],
    },
    mcpExpose: true,
  },
  {
    name: 'leave_team',
    description: 'Leave your current team. If the team becomes empty, it is deleted.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    mcpExpose: true,
  },
];

// ---------------------------------------------------------------------------
// Phase implementation
// ---------------------------------------------------------------------------

export class TeamFormationPhase implements LobbyPhase<TeamFormationState> {
  readonly id = 'team-formation';
  readonly name = 'Team Formation';
  readonly tools = TOOLS;
  readonly acceptsJoins = true;
  readonly timeout = 600; // 10 minutes

  private teamSize: number;
  private numTeams: number;

  constructor(config: TeamFormationConfig) {
    this.teamSize = config.teamSize;
    this.numTeams = config.numTeams;
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  init(players: AgentInfo[], _config: Record<string, any>): TeamFormationState {
    return {
      teams: [],
      unassigned: players.map((p) => p.id),
      teamCounter: 0,
    };
  }

  // -------------------------------------------------------------------------
  // handleAction
  // -------------------------------------------------------------------------

  handleAction(
    state: TeamFormationState,
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    action: { type: string; playerId: string; payload?: any },
    players: AgentInfo[],
  ): PhaseActionResult<TeamFormationState> {
    switch (action.type) {
      case 'propose_team':
        return this.handlePropose(state, action.playerId, action.payload, players);
      case 'accept_team':
        return this.handleAccept(state, action.playerId, action.payload, players);
      case 'leave_team':
        return this.handleLeave(state, action.playerId, players);
      default:
        return { state, error: { message: `Unknown action type: ${action.type}`, status: 400 } };
    }
  }

  // -------------------------------------------------------------------------
  // handleJoin
  // -------------------------------------------------------------------------

  handleJoin(
    state: TeamFormationState,
    player: AgentInfo,
    _allPlayers: AgentInfo[],
  ): PhaseActionResult<TeamFormationState> {
    // Don't add if already tracked
    if (
      state.unassigned.includes(player.id) ||
      state.teams.some((t) => t.members.includes(player.id))
    ) {
      return { state };
    }

    const newState: TeamFormationState = {
      ...state,
      unassigned: [...state.unassigned, player.id],
    };
    return { state: newState };
  }

  // -------------------------------------------------------------------------
  // handleTimeout — auto-merge
  // -------------------------------------------------------------------------

  handleTimeout(state: TeamFormationState, players: AgentInfo[]): PhaseResult | null {
    // Work on a mutable copy
    const teams: TeamFormationTeam[] = state.teams.map((t) => ({
      id: t.id,
      members: [...t.members],
      invites: [], // clear invites on timeout
    }));
    const assigned = new Set<string>();
    for (const t of teams) {
      for (const m of t.members) assigned.add(m);
    }
    const freeAgents = players.map((p) => p.id).filter((id) => !assigned.has(id));
    let freeIdx = 0;
    let teamCounter = state.teamCounter;

    // Fill incomplete teams with free agents
    for (const team of teams) {
      while (team.members.length < this.teamSize && freeIdx < freeAgents.length) {
        // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
        team.members.push(freeAgents[freeIdx++]);
      }
    }

    // Merge incomplete teams together (largest first)
    const incomplete = teams
      .filter((t) => t.members.length < this.teamSize)
      .sort((a, b) => b.members.length - a.members.length);

    for (let i = 0; i < incomplete.length; i++) {
      const target = incomplete[i];
      // @ts-expect-error TS18048: 'target' is possibly 'undefined'. — TODO(2.3-followup)
      if (target.members.length >= this.teamSize) continue;
      for (let j = i + 1; j < incomplete.length; j++) {
        const source = incomplete[j];
        // @ts-expect-error TS18048: 'source' is possibly 'undefined'. — TODO(2.3-followup)
        if (source.members.length === 0) continue;
        // @ts-expect-error TS18048: 'target' is possibly 'undefined'. — TODO(2.3-followup)
        if (target.members.length + source.members.length <= this.teamSize) {
          // @ts-expect-error TS18048: 'target' is possibly 'undefined'. — TODO(2.3-followup)
          target.members.push(...source.members);
          // @ts-expect-error TS18048: 'source' is possibly 'undefined'. — TODO(2.3-followup)
          source.members = [];
        }
      }
    }

    // Form new teams from remaining free agents
    while (freeIdx + this.teamSize <= freeAgents.length) {
      const teamId = `team_${++teamCounter}`;
      const members = freeAgents.slice(freeIdx, freeIdx + this.teamSize);
      freeIdx += this.teamSize;
      teams.push({ id: teamId, members, invites: [] });
    }

    // Collect full teams (filter out empty shells from merging)
    const fullTeams = teams.filter((t) => t.members.length === this.teamSize);

    if (fullTeams.length < this.numTeams) {
      return null; // Can't form enough teams — lobby fails
    }

    // Take exactly numTeams teams
    const selectedTeams = fullTeams.slice(0, this.numTeams);
    const selectedPlayerIds = new Set<string>();
    for (const t of selectedTeams) {
      for (const m of t.members) selectedPlayerIds.add(m);
    }

    const groups: AgentInfo[][] = selectedTeams.map((t) =>
      t.members.map((id) => {
        const p = players.find((pp) => pp.id === id);
        return p ?? { id, handle: id };
      }),
    );

    const removed = players
      .filter((p) => !selectedPlayerIds.has(p.id))
      .map((p) => ({ id: p.id, handle: p.handle }));

    // @ts-expect-error TS2375: Type '{ groups: AgentInfo[][]; metadata: { teams: { id: string; members: string[ — TODO(2.3-followup)
    return {
      groups,
      metadata: {
        teams: selectedTeams.map((t) => ({ id: t.id, members: [...t.members] })),
      },
      removed: removed.length > 0 ? removed : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // getView
  // -------------------------------------------------------------------------

  getView(state: TeamFormationState, _playerId?: string): unknown {
    return {
      teams: state.teams.map((t) => ({
        id: t.id,
        members: [...t.members],
        invites: [...t.invites],
      })),
      unassigned: [...state.unassigned],
      teamSize: this.teamSize,
      numTeams: this.numTeams,
    };
  }

  // -------------------------------------------------------------------------
  // getTeamForPlayer — for team-scoped chat routing
  // -------------------------------------------------------------------------

  getTeamForPlayer(state: TeamFormationState, playerId: string): string | null {
    const team = state.teams.find((t) => t.members.includes(playerId));
    return team?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Private action handlers
  // -------------------------------------------------------------------------

  private handlePropose(
    state: TeamFormationState,
    playerId: string,
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    payload: any,
    players: AgentInfo[],
  ): PhaseActionResult<TeamFormationState> {
    const targetHandle = payload?.targetHandle;
    if (!targetHandle) {
      return { state, error: { message: 'targetHandle is required', status: 400 } };
    }

    // Resolve target by handle
    const target = players.find((p) => p.handle === targetHandle);
    if (!target) {
      return {
        state,
        error: { message: `Player "${targetHandle}" not found in lobby`, status: 404 },
      };
    }
    const targetId = target.id;

    // Can't propose to yourself
    if (targetId === playerId) {
      return { state, error: { message: 'Cannot propose a team with yourself', status: 400 } };
    }

    const fromTeam = state.teams.find((t) => t.members.includes(playerId));
    const toTeam = state.teams.find((t) => t.members.includes(targetId));

    // Both on teams already
    if (fromTeam && toTeam) {
      if (fromTeam.id === toTeam.id) {
        return { state, error: { message: 'Already on the same team', status: 409 } };
      }
      return {
        state,
        error: { message: 'Both players are already on teams. Use leave_team first.', status: 409 },
      };
    }

    const newState = {
      ...state,
      teams: state.teams.map((t) => ({ ...t, members: [...t.members], invites: [...t.invites] })),
    };

    if (toTeam && !fromTeam) {
      // Target is on a team, proposer is solo — invite proposer to target's team
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const team = newState.teams.find((t) => t.id === toTeam.id)!;
      if (team.members.length >= this.teamSize) {
        return { state, error: { message: 'Team is full', status: 409 } };
      }
      if (!team.invites.includes(playerId)) team.invites.push(playerId);
      return this.maybeComplete(newState, players);
    }

    if (fromTeam && !toTeam) {
      // Proposer is on a team, target is solo — invite target
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const team = newState.teams.find((t) => t.id === fromTeam.id)!;
      if (team.members.length >= this.teamSize) {
        return { state, error: { message: 'Team is full', status: 409 } };
      }
      if (!team.invites.includes(targetId)) team.invites.push(targetId);
      return this.maybeComplete(newState, players);
    }

    // Neither on a team — create new team with proposer as member, target as invite
    const teamId = `team_${++newState.teamCounter}`;
    newState.teams.push({ id: teamId, members: [playerId], invites: [targetId] });
    newState.unassigned = newState.unassigned.filter((id) => id !== playerId);

    return this.maybeComplete(newState, players);
  }

  private handleAccept(
    state: TeamFormationState,
    playerId: string,
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    payload: any,
    players: AgentInfo[],
  ): PhaseActionResult<TeamFormationState> {
    const teamId = payload?.teamId;
    if (!teamId) {
      return { state, error: { message: 'teamId is required', status: 400 } };
    }

    const newState = {
      ...state,
      teams: state.teams.map((t) => ({ ...t, members: [...t.members], invites: [...t.invites] })),
    };

    const team = newState.teams.find((t) => t.id === teamId);
    if (!team) {
      return { state, error: { message: 'Team not found', status: 404 } };
    }

    if (!team.invites.includes(playerId)) {
      return { state, error: { message: 'Not invited to this team', status: 403 } };
    }

    if (team.members.length >= this.teamSize) {
      return { state, error: { message: 'Team is full', status: 409 } };
    }

    // Leave any existing team first
    const currentTeam = newState.teams.find((t) => t.members.includes(playerId));
    if (currentTeam) {
      currentTeam.members = currentTeam.members.filter((id) => id !== playerId);
      if (currentTeam.members.length === 0) {
        newState.teams = newState.teams.filter((t) => t.id !== currentTeam.id);
      }
    }

    // Accept the invite
    team.invites = team.invites.filter((id) => id !== playerId);
    team.members.push(playerId);
    newState.unassigned = newState.unassigned.filter((id) => id !== playerId);

    return this.maybeComplete(newState, players);
  }

  private handleLeave(
    state: TeamFormationState,
    playerId: string,
    _players: AgentInfo[],
  ): PhaseActionResult<TeamFormationState> {
    const team = state.teams.find((t) => t.members.includes(playerId));
    if (!team) {
      return { state, error: { message: 'Not on a team', status: 400 } };
    }

    const newState = {
      ...state,
      teams: state.teams.map((t) => ({ ...t, members: [...t.members], invites: [...t.invites] })),
    };

    // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
    const targetTeam = newState.teams.find((t) => t.id === team.id)!;
    targetTeam.members = targetTeam.members.filter((id) => id !== playerId);

    if (targetTeam.members.length === 0) {
      newState.teams = newState.teams.filter((t) => t.id !== targetTeam.id);
    }

    // Add back to unassigned
    if (!newState.unassigned.includes(playerId)) {
      newState.unassigned = [...newState.unassigned, playerId];
    }

    return { state: newState };
  }

  // -------------------------------------------------------------------------
  // Completion check
  // -------------------------------------------------------------------------

  private maybeComplete(
    state: TeamFormationState,
    players: AgentInfo[],
  ): PhaseActionResult<TeamFormationState> {
    const fullTeams = state.teams.filter((t) => t.members.length >= this.teamSize);

    if (fullTeams.length >= this.numTeams) {
      const selectedTeams = fullTeams.slice(0, this.numTeams);
      const selectedPlayerIds = new Set<string>();
      for (const t of selectedTeams) {
        for (const m of t.members) selectedPlayerIds.add(m);
      }

      const groups: AgentInfo[][] = selectedTeams.map((t) =>
        t.members.map((id) => {
          const p = players.find((pp) => pp.id === id);
          return p ?? { id, handle: id };
        }),
      );

      const removed = players
        .filter((p) => !selectedPlayerIds.has(p.id))
        .map((p) => ({ id: p.id, handle: p.handle }));

      return {
        state,
        // @ts-expect-error TS2375: Type '{ groups: AgentInfo[][]; metadata: { teams: { id: string; members: string[ — TODO(2.3-followup)
        completed: {
          groups,
          metadata: {
            teams: selectedTeams.map((t) => ({ id: t.id, members: [...t.members] })),
          },
          removed: removed.length > 0 ? removed : undefined,
        },
      };
    }

    return { state };
  }
}
