import { describe, it, expect } from 'vitest';
import { ClassSelectionPhase } from '../phases/class-selection.js';
import type { AgentInfo } from '@coordination-games/engine';

function makePlayers(...names: string[]): AgentInfo[] {
  return names.map((n) => ({ id: n.toLowerCase(), handle: n }));
}

const VALID_CLASSES = ['rogue', 'knight', 'mage'];

describe('ClassSelectionPhase', () => {
  it('has correct id and name', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    expect(phase.id).toBe('class-selection');
    expect(phase.name).toBe('Class Selection');
  });

  it('init creates state with all player IDs and no picks', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    const players = makePlayers('Alice', 'Bob', 'Carol');
    const state = phase.init(players, {});

    expect(state.playerIds).toEqual(['alice', 'bob', 'carol']);
    expect(state.classPicks).toEqual({});
  });

  it('choose_class action records pick', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    const players = makePlayers('Alice', 'Bob');
    const state = phase.init(players, {});

    const result = phase.handleAction(
      state,
      { type: 'choose_class', playerId: 'alice', payload: { unitClass: 'mage' } },
      players,
    );

    expect(result.error).toBeUndefined();
    expect(result.state.classPicks['alice']).toBe('mage');
  });

  it('invalid class returns error', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    const players = makePlayers('Alice');
    const state = phase.init(players, {});

    const result = phase.handleAction(
      state,
      { type: 'choose_class', playerId: 'alice', payload: { unitClass: 'wizard' } },
      players,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('Invalid class');
  });

  it('completes when all players have picked', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    const players = makePlayers('Alice', 'Bob');
    let state = phase.init(players, {});

    state = phase.handleAction(
      state,
      { type: 'choose_class', playerId: 'alice', payload: { unitClass: 'rogue' } },
      players,
    ).state;

    const result = phase.handleAction(
      state,
      { type: 'choose_class', playerId: 'bob', payload: { unitClass: 'knight' } },
      players,
    );

    expect(result.completed).toBeDefined();
    expect(result.completed!.groups).toHaveLength(1);
    expect(result.completed!.groups[0]).toHaveLength(2);
    expect(result.completed!.metadata.classPicks).toEqual({
      alice: 'rogue',
      bob: 'knight',
    });
  });

  it('handleTimeout auto-assigns via round-robin', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    const players = makePlayers('Alice', 'Bob', 'Carol');
    const state = phase.init(players, {});

    const result = phase.handleTimeout(state, players);

    expect(result).not.toBeNull();
    expect(result!.metadata.classPicks).toEqual({
      alice: 'rogue',
      bob: 'knight',
      carol: 'mage',
    });
    expect(result!.groups).toHaveLength(1);
    expect(result!.groups[0]).toHaveLength(3);
  });

  it('handleTimeout preserves existing picks and fills the rest', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    const players = makePlayers('Alice', 'Bob', 'Carol');
    let state = phase.init(players, {});

    // Alice picks mage
    state = phase.handleAction(
      state,
      { type: 'choose_class', playerId: 'alice', payload: { unitClass: 'mage' } },
      players,
    ).state;

    const result = phase.handleTimeout(state, players);

    expect(result).not.toBeNull();
    expect(result!.metadata.classPicks['alice']).toBe('mage');
    // Bob and Carol get auto-assigned
    expect(result!.metadata.classPicks['bob']).toBe('rogue');
    expect(result!.metadata.classPicks['carol']).toBe('knight');
  });

  it('getView shows picks and valid classes', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    const players = makePlayers('Alice', 'Bob');
    let state = phase.init(players, {});

    state = phase.handleAction(
      state,
      { type: 'choose_class', playerId: 'alice', payload: { unitClass: 'rogue' } },
      players,
    ).state;

    const view = phase.getView(state) as any;

    expect(view.validClasses).toEqual(VALID_CLASSES);
    expect(view.classPicks).toEqual({ alice: 'rogue' });
    expect(view.playerIds).toEqual(['alice', 'bob']);
  });

  it('unknown action type returns error', () => {
    const phase = new ClassSelectionPhase({ validClasses: VALID_CLASSES });
    const players = makePlayers('Alice');
    const state = phase.init(players, {});

    const result = phase.handleAction(
      state,
      { type: 'unknown_action', playerId: 'alice', payload: {} },
      players,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('Unknown action type');
  });
});
