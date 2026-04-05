import { describe, it, expect } from 'vitest';
import { TeamFormationPhase } from '../phases/team-formation.js';
import type { AgentInfo, PhaseContext } from '@coordination-games/engine';

function makeCtx(players: AgentInfo[], config: Record<string, any> = {}): PhaseContext {
  return {
    players,
    gameConfig: config,
    relay: { send: () => {}, broadcast: () => {}, receive: () => [] },
    onTimeout: () => ({ groups: [players], metadata: { timedOut: true } }),
  };
}

describe('TeamFormationPhase', () => {
  it('has correct id and name', () => {
    expect(TeamFormationPhase.id).toBe('team-formation');
    expect(TeamFormationPhase.name).toBe('Team Formation');
  });

  it('forms teams of 2 from 4 players', async () => {
    const players: AgentInfo[] = [
      { id: 'a', handle: 'Alice' },
      { id: 'b', handle: 'Bob' },
      { id: 'c', handle: 'Carol' },
      { id: 'd', handle: 'Dave' },
    ];

    const result = await TeamFormationPhase.run(makeCtx(players, { teamSize: 2 }));

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toHaveLength(2);
    expect(result.groups[1]).toHaveLength(2);

    // All players should be assigned
    const allIds = result.groups.flat().map((p) => p.id);
    expect(allIds).toContain('a');
    expect(allIds).toContain('b');
    expect(allIds).toContain('c');
    expect(allIds).toContain('d');
  });

  it('handles orphans when players dont divide evenly', async () => {
    const players: AgentInfo[] = [
      { id: 'a', handle: 'Alice' },
      { id: 'b', handle: 'Bob' },
      { id: 'c', handle: 'Carol' },
    ];

    const result = await TeamFormationPhase.run(makeCtx(players, { teamSize: 2 }));

    // Should form 1 complete team of 2
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toHaveLength(2);

    // One orphan should be removed
    expect(result.removed).toHaveLength(1);
  });

  it('defaults to teamSize 2', async () => {
    const players: AgentInfo[] = [
      { id: 'a', handle: 'Alice' },
      { id: 'b', handle: 'Bob' },
      { id: 'c', handle: 'Carol' },
      { id: 'd', handle: 'Dave' },
    ];

    const result = await TeamFormationPhase.run(makeCtx(players));
    expect(result.groups).toHaveLength(2);
  });

  it('records team assignments in metadata', async () => {
    const players: AgentInfo[] = [
      { id: 'a', handle: 'Alice' },
      { id: 'b', handle: 'Bob' },
    ];

    const result = await TeamFormationPhase.run(makeCtx(players, { teamSize: 2 }));

    expect(result.metadata.teamAssignments).toBeDefined();
    expect(result.metadata.teamAssignments).toHaveLength(1);
    expect(result.metadata.teamAssignments[0].members).toHaveLength(2);
  });
});
