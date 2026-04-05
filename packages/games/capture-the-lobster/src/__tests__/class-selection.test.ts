import { describe, it, expect } from 'vitest';
import { ClassSelectionPhase } from '../phases/class-selection.js';
import type { AgentInfo, PhaseContext } from '@coordination-games/engine';

function makeCtx(players: AgentInfo[], config: Record<string, any> = {}): PhaseContext {
  return {
    players,
    gameConfig: config,
    relay: { send: () => {}, broadcast: () => {}, receive: () => [] },
    onTimeout: () => ({ groups: [players], metadata: { timedOut: true } }),
  };
}

describe('ClassSelectionPhase', () => {
  it('has correct id and name', () => {
    expect(ClassSelectionPhase.id).toBe('class-selection');
    expect(ClassSelectionPhase.name).toBe('Class Selection');
  });

  it('assigns default classes cycling through rogue/knight/mage', async () => {
    const players: AgentInfo[] = [
      { id: 'a', handle: 'Alice' },
      { id: 'b', handle: 'Bob' },
      { id: 'c', handle: 'Carol' },
    ];

    const result = await ClassSelectionPhase.run(makeCtx(players));

    expect(result.metadata.classPicks).toEqual({
      a: 'rogue',
      b: 'knight',
      c: 'mage',
    });
  });

  it('uses pre-assigned classes from gameConfig', async () => {
    const players: AgentInfo[] = [
      { id: 'a', handle: 'Alice' },
      { id: 'b', handle: 'Bob' },
    ];

    const result = await ClassSelectionPhase.run(
      makeCtx(players, { classPicks: { a: 'mage', b: 'rogue' } }),
    );

    expect(result.metadata.classPicks).toEqual({
      a: 'mage',
      b: 'rogue',
    });
  });

  it('keeps all players in one group', async () => {
    const players: AgentInfo[] = [
      { id: 'a', handle: 'Alice' },
      { id: 'b', handle: 'Bob' },
    ];

    const result = await ClassSelectionPhase.run(makeCtx(players));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toHaveLength(2);
    expect(result.removed).toBeUndefined();
  });
});
