import type { AgentInfo } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import { TeamFormationPhase } from '../phases/team-formation.js';

function makePlayers(...names: string[]): AgentInfo[] {
  return names.map((n, _i) => ({ id: n.toLowerCase(), handle: n }));
}

describe('TeamFormationPhase', () => {
  it('has correct id and name', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 2 });
    expect(phase.id).toBe('team-formation');
    expect(phase.name).toBe('Team Formation');
  });

  it('init creates empty state with all players unassigned', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 2 });
    const players = makePlayers('Alice', 'Bob', 'Carol', 'Dave');
    const state = phase.init(players, {});

    expect(state.teams).toEqual([]);
    expect(state.unassigned).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(state.teamCounter).toBe(0);
  });

  it('propose_team creates a team and invites target', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 2 });
    const players = makePlayers('Alice', 'Bob', 'Carol', 'Dave');
    const state = phase.init(players, {});

    const result = phase.handleAction(
      state,
      { type: 'propose_team', playerId: 'alice', payload: { targetHandle: 'Bob' } },
      players,
    );

    expect(result.error).toBeUndefined();
    expect(result.state.teams).toHaveLength(1);
    expect(result.state.teams[0].members).toEqual(['alice']);
    expect(result.state.teams[0].invites).toEqual(['bob']);
    // Alice removed from unassigned
    expect(result.state.unassigned).not.toContain('alice');
  });

  it('accept_team adds player to team', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 2 });
    const players = makePlayers('Alice', 'Bob', 'Carol', 'Dave');
    let state = phase.init(players, {});

    // Alice proposes to Bob
    const r1 = phase.handleAction(
      state,
      { type: 'propose_team', playerId: 'alice', payload: { targetHandle: 'Bob' } },
      players,
    );
    state = r1.state;
    const teamId = state.teams[0].id;

    // Bob accepts
    const r2 = phase.handleAction(
      state,
      { type: 'accept_team', playerId: 'bob', payload: { teamId } },
      players,
    );

    expect(r2.error).toBeUndefined();
    const team = r2.state.teams.find((t) => t.id === teamId);
    if (!team) throw new Error(`expected team ${teamId}`);
    expect(team.members).toContain('alice');
    expect(team.members).toContain('bob');
    expect(team.invites).not.toContain('bob');
    expect(r2.state.unassigned).not.toContain('bob');
  });

  it('leave_team removes player from team', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 1 });
    const players = makePlayers('Alice', 'Bob');
    let state = phase.init(players, {});

    // Alice proposes to Bob, Bob accepts
    state = phase.handleAction(
      state,
      { type: 'propose_team', playerId: 'alice', payload: { targetHandle: 'Bob' } },
      players,
    ).state;
    const teamId = state.teams[0].id;
    state = phase.handleAction(
      state,
      { type: 'accept_team', playerId: 'bob', payload: { teamId } },
      players,
    ).state;

    // Bob leaves
    const result = phase.handleAction(state, { type: 'leave_team', playerId: 'bob' }, players);

    expect(result.error).toBeUndefined();
    const team = result.state.teams.find((t) => t.id === teamId);
    // Team still has Alice
    expect(team?.members).toEqual(['alice']);
    // Bob is back in unassigned
    expect(result.state.unassigned).toContain('bob');
  });

  it('completes when numTeams full teams are formed', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 2 });
    const players = makePlayers('Alice', 'Bob', 'Carol', 'Dave');
    let state = phase.init(players, {});

    // Team 1: Alice + Bob
    state = phase.handleAction(
      state,
      { type: 'propose_team', playerId: 'alice', payload: { targetHandle: 'Bob' } },
      players,
    ).state;
    const team1Id = state.teams[0].id;
    state = phase.handleAction(
      state,
      { type: 'accept_team', playerId: 'bob', payload: { teamId: team1Id } },
      players,
    ).state;

    // Team 2: Carol + Dave
    state = phase.handleAction(
      state,
      { type: 'propose_team', playerId: 'carol', payload: { targetHandle: 'Dave' } },
      players,
    ).state;
    const team2Id = state.teams[1].id;
    const result = phase.handleAction(
      state,
      { type: 'accept_team', playerId: 'dave', payload: { teamId: team2Id } },
      players,
    );

    expect(result.completed).toBeDefined();
    expect(result.completed?.groups).toHaveLength(2);
    expect(result.completed?.groups[0]).toHaveLength(2);
    expect(result.completed?.groups[1]).toHaveLength(2);

    const allIds = result.completed?.groups.flat().map((p) => p.id);
    expect(allIds).toContain('alice');
    expect(allIds).toContain('bob');
    expect(allIds).toContain('carol');
    expect(allIds).toContain('dave');
  });

  it('handleTimeout auto-merges into teams', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 2 });
    const players = makePlayers('Alice', 'Bob', 'Carol', 'Dave');
    const state = phase.init(players, {});

    const result = phase.handleTimeout(state, players);

    expect(result).not.toBeNull();
    expect(result?.groups).toHaveLength(2);
    expect(result?.groups[0]).toHaveLength(2);
    expect(result?.groups[1]).toHaveLength(2);

    const allIds = result?.groups.flat().map((p) => p.id);
    expect(allIds).toContain('alice');
    expect(allIds).toContain('bob');
    expect(allIds).toContain('carol');
    expect(allIds).toContain('dave');
  });

  it('handleTimeout returns null when not enough players for numTeams', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 2 });
    const players = makePlayers('Alice', 'Bob');
    const state = phase.init(players, {});

    const result = phase.handleTimeout(state, players);

    // Only 1 team of 2 can be formed, but we need 2 teams
    expect(result).toBeNull();
  });

  it('handleTimeout removes orphans', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 1 });
    const players = makePlayers('Alice', 'Bob', 'Carol');
    const state = phase.init(players, {});

    const result = phase.handleTimeout(state, players);

    expect(result).not.toBeNull();
    expect(result?.groups).toHaveLength(1);
    expect(result?.groups[0]).toHaveLength(2);
    expect(result?.removed).toHaveLength(1);
  });

  it('getTeamForPlayer returns correct team ID', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 1 });
    const players = makePlayers('Alice', 'Bob');
    let state = phase.init(players, {});

    // Before joining a team
    expect(phase.getTeamForPlayer(state, 'alice')).toBeNull();

    // Alice proposes to Bob
    state = phase.handleAction(
      state,
      { type: 'propose_team', playerId: 'alice', payload: { targetHandle: 'Bob' } },
      players,
    ).state;
    const teamId = state.teams[0].id;

    expect(phase.getTeamForPlayer(state, 'alice')).toBe(teamId);
    expect(phase.getTeamForPlayer(state, 'bob')).toBeNull(); // invited but not member
  });

  it('propose_team to self returns error', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 1 });
    const players = makePlayers('Alice', 'Bob');
    const state = phase.init(players, {});

    const result = phase.handleAction(
      state,
      { type: 'propose_team', playerId: 'alice', payload: { targetHandle: 'Alice' } },
      players,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('yourself');
  });

  it('accept_team for non-existent team returns error', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 1 });
    const players = makePlayers('Alice', 'Bob');
    const state = phase.init(players, {});

    const result = phase.handleAction(
      state,
      { type: 'accept_team', playerId: 'alice', payload: { teamId: 'nonexistent' } },
      players,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('not found');
  });

  it('handleJoin adds new player to unassigned', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 1 });
    const players = makePlayers('Alice', 'Bob');
    const state = phase.init(players, {});

    const newPlayer: AgentInfo = { id: 'carol', handle: 'Carol' };
    const result = phase.handleJoin(state, newPlayer, [...players, newPlayer]);

    expect(result.state.unassigned).toContain('carol');
  });

  it('records team metadata on completion', () => {
    const phase = new TeamFormationPhase({ teamSize: 2, numTeams: 1 });
    const players = makePlayers('Alice', 'Bob');
    let state = phase.init(players, {});

    state = phase.handleAction(
      state,
      { type: 'propose_team', playerId: 'alice', payload: { targetHandle: 'Bob' } },
      players,
    ).state;
    const teamId = state.teams[0].id;
    const result = phase.handleAction(
      state,
      { type: 'accept_team', playerId: 'bob', payload: { teamId } },
      players,
    );

    expect(result.completed).toBeDefined();
    expect(result.completed?.metadata.teams).toBeDefined();
    expect(result.completed?.metadata.teams).toHaveLength(1);
    expect(result.completed?.metadata.teams[0].members).toHaveLength(2);
  });
});
