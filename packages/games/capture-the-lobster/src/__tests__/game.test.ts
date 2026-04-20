import { beforeEach, describe, expect, it } from 'vitest';
import {
  allMovesSubmitted,
  type CtlGameState,
  createGameState,
  getStateForAgent,
  isGameOver,
  resolveTurn,
  submitMove,
} from '../game.js';
import { type Hex, hexEquals, hexToString } from '../hex.js';
import type { GameMap, TileType } from '../map.js';
import type { UnitClass } from '../movement.js';

/**
 * Build a small deterministic hex map (radius 3) for testing.
 */
function makeTestMap(): GameMap {
  const radius = 3;
  const tiles = new Map<string, TileType>();

  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      tiles.set(hexToString({ q, r }), 'ground');
    }
  }

  const flagA: Hex = { q: 0, r: 3 };
  const flagB: Hex = { q: 0, r: -3 };

  tiles.set(hexToString(flagA), 'base_a');
  tiles.set(hexToString(flagB), 'base_b');

  const spawnsA: Hex[] = [
    { q: 0, r: 2 },
    { q: -1, r: 3 },
    { q: 1, r: 2 },
    { q: -1, r: 2 },
  ];
  const spawnsB: Hex[] = [
    { q: 0, r: -2 },
    { q: 1, r: -3 },
    { q: -1, r: -2 },
    { q: 1, r: -2 },
  ];

  for (const s of spawnsA) tiles.set(hexToString(s), 'base_a');
  for (const s of spawnsB) tiles.set(hexToString(s), 'base_b');

  tiles.set(hexToString({ q: 2, r: 0 }), 'wall');
  tiles.set(hexToString({ q: -2, r: 0 }), 'wall');

  return {
    tiles,
    radius,
    bases: {
      A: [{ flag: flagA, spawns: spawnsA }],
      B: [{ flag: flagB, spawns: spawnsB }],
    },
  };
}

function makePlayers(teamSize = 1) {
  const classes: UnitClass[] = ['rogue', 'knight', 'mage', 'rogue'];
  const players: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[] = [];
  for (let i = 0; i < teamSize; i++) {
    players.push({ id: `a${i}`, team: 'A', unitClass: classes[i % classes.length] });
    players.push({ id: `b${i}`, team: 'B', unitClass: classes[i % classes.length] });
  }
  return players;
}

/**
 * Create a game state and transition it to 'in_progress' for gameplay tests.
 * createGameState() returns 'pre_game' (the framework handles the transition),
 * but pure game-logic tests need 'in_progress' to submit moves and resolve turns.
 */
function createInProgressState(
  map: GameMap,
  players: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[],
  config?: import('../game.js').GameConfig,
): CtlGameState {
  return { ...createGameState(map, players, config), phase: 'in_progress' };
}

describe('Game (pure functions)', () => {
  let map: GameMap;

  beforeEach(() => {
    map = makeTestMap();
  });

  describe('createGameState', () => {
    it('creates units at spawn positions', () => {
      const players = makePlayers(2);
      const state = createGameState(map, players);

      expect(state.units).toHaveLength(4);
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const a0 = state.units.find((u) => u.id === 'a0')!;
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const a1 = state.units.find((u) => u.id === 'a1')!;
      expect(hexEquals(a0.position, map.bases.A[0].spawns[0])).toBe(true);
      expect(hexEquals(a1.position, map.bases.A[0].spawns[1])).toBe(true);

      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const b0 = state.units.find((u) => u.id === 'b0')!;
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const b1 = state.units.find((u) => u.id === 'b1')!;
      expect(hexEquals(b0.position, map.bases.B[0].spawns[0])).toBe(true);
      expect(hexEquals(b1.position, map.bases.B[0].spawns[1])).toBe(true);
    });

    it('initializes flags at base positions', () => {
      const state = createGameState(map, makePlayers(1));
      expect(hexEquals(state.flags.A[0].position, map.bases.A[0].flag)).toBe(true);
      expect(hexEquals(state.flags.B[0].position, map.bases.B[0].flag)).toBe(true);
      expect(state.flags.A[0].carried).toBe(false);
      expect(state.flags.B[0].carried).toBe(false);
    });

    it('applies default config values', () => {
      const state = createGameState(map, makePlayers(1));
      expect(state.config.turnLimit).toBe(30);
      expect(state.config.turnTimerSeconds).toBe(30);
      expect(state.config.teamSize).toBe(4);
    });

    it('starts in pre_game phase at turn 0', () => {
      const state = createGameState(map, makePlayers(1));
      expect(state.phase).toBe('pre_game');
      expect(state.turn).toBe(0);
      expect(state.winner).toBeNull();
    });
  });

  describe('submitMove', () => {
    it('accepts a valid move', () => {
      const state = createInProgressState(map, makePlayers(1));
      const result = submitMove(state, 'a0', ['N']);
      expect(result.success).toBe(true);
    });

    it('rejects a move that exceeds speed', () => {
      const state = createInProgressState(map, makePlayers(1));
      const result = submitMove(state, 'a0', ['N', 'N', 'N', 'N']);
      expect(result.success).toBe(false);
      expect(result.error).toContain('speed limit');
    });

    it('rejects move from dead unit', () => {
      let state = createInProgressState(map, makePlayers(1));
      const units = state.units.map((u) => (u.id === 'a0' ? { ...u, alive: false } : u));
      state = { ...state, units };
      const result = submitMove(state, 'a0', ['N']);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Dead');
    });

    it('rejects move when game is finished', () => {
      let state = createInProgressState(map, makePlayers(1));
      state = { ...state, phase: 'finished' };
      const result = submitMove(state, 'a0', ['N']);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not in progress');
    });
  });

  describe('resolveTurn', () => {
    it('moves units to new positions', () => {
      let state = createInProgressState(map, makePlayers(1));
      state = submitMove(state, 'a0', ['N']).state;
      const { state: newState, record } = resolveTurn(state);

      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const a0 = newState.units.find((u) => u.id === 'a0')!;
      expect(hexEquals(a0.position, { q: 0, r: 1 })).toBe(true);
      expect(record.unitPositionsBefore.get('a0')).toEqual({ q: 0, r: 2 });
      expect(record.unitPositionsAfter.get('a0')).toEqual({ q: 0, r: 1 });
    });

    it('units without submissions stay in place', () => {
      const state = createInProgressState(map, makePlayers(1));
      const { state: newState } = resolveTurn(state);

      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const a0 = newState.units.find((u) => u.id === 'a0')!;
      expect(hexEquals(a0.position, map.bases.A[0].spawns[0])).toBe(true);
    });

    it('resolves combat kills (rogue kills adjacent mage)', () => {
      const players = [
        { id: 'rogue_a', team: 'A' as const, unitClass: 'rogue' as UnitClass },
        { id: 'mage_b', team: 'B' as const, unitClass: 'mage' as UnitClass },
      ];
      let state = createInProgressState(map, players);

      // Place them adjacent: rogue at (0,0), mage at (0,1)
      state = {
        ...state,
        units: state.units.map((u) => {
          if (u.id === 'rogue_a') return { ...u, position: { q: 0, r: 0 } };
          if (u.id === 'mage_b') return { ...u, position: { q: 0, r: 1 } };
          return u;
        }),
      };

      const { record } = resolveTurn(state);

      expect(record.kills.length).toBeGreaterThanOrEqual(1);
      expect(record.kills.some((k) => k.killerId === 'rogue_a' && k.victimId === 'mage_b')).toBe(
        true,
      );
    });

    it('dead unit respawns at base after death penalty (2 turns)', () => {
      const players = [
        { id: 'rogue_a', team: 'A' as const, unitClass: 'rogue' as UnitClass },
        { id: 'mage_b', team: 'B' as const, unitClass: 'mage' as UnitClass },
      ];
      let state = createInProgressState(map, players);

      state = {
        ...state,
        units: state.units.map((u) => {
          if (u.id === 'rogue_a') return { ...u, position: { q: 0, r: 0 } };
          if (u.id === 'mage_b') return { ...u, position: { q: 0, r: 1 } };
          return u;
        }),
      };

      // Turn 0: mage dies, respawnTurn = 2
      state = resolveTurn(state).state;
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      let mage = state.units.find((u) => u.id === 'mage_b')!;
      expect(mage.alive).toBe(false);
      expect(mage.respawnTurn).toBe(2);
      // Moved to spawn position immediately (for spectator visibility)
      expect(hexEquals(mage.position, map.bases.B[0].spawns[0])).toBe(true);

      // Turn 1: still dead
      state = resolveTurn(state).state;
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      mage = state.units.find((u) => u.id === 'mage_b')!;
      expect(mage.alive).toBe(false);

      // Turn 2: respawns
      state = resolveTurn(state).state;
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      mage = state.units.find((u) => u.id === 'mage_b')!;
      expect(mage.alive).toBe(true);
      expect(hexEquals(mage.position, map.bases.B[0].spawns[0])).toBe(true);
    });

    it('flag pickup — unit moves onto enemy flag hex', () => {
      const players = [
        { id: 'fast', team: 'A' as const, unitClass: 'rogue' as UnitClass },
        { id: 'far', team: 'B' as const, unitClass: 'rogue' as UnitClass },
      ];
      let state = createInProgressState(map, players);

      // Place team A rogue next to team B flag, team B far away
      state = {
        ...state,
        units: state.units.map((u) => {
          if (u.id === 'fast') return { ...u, position: { q: 0, r: -2 } };
          if (u.id === 'far') return { ...u, position: { q: -1, r: 3 } };
          return u;
        }),
      };

      // Move N onto the flag at (0,-3)
      state = submitMove(state, 'fast', ['N']).state;
      const { state: newState, record } = resolveTurn(state);

      expect(record.flagEvents.some((e) => e.includes('picked up'))).toBe(true);
      expect(newState.flags.B[0].carried).toBe(true);
      expect(newState.flags.B[0].carrierId).toBe('fast');
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const unit = newState.units.find((u) => u.id === 'fast')!;
      expect(unit.carryingFlag).toBe(true);
    });

    it('flag capture — carrier reaches home base, game ends', () => {
      const players = [
        { id: 'cap', team: 'A' as const, unitClass: 'rogue' as UnitClass },
        { id: 'def', team: 'B' as const, unitClass: 'rogue' as UnitClass },
      ];
      let state = createInProgressState(map, players);

      // Give unit the flag and put it one step from home base
      state = {
        ...state,
        units: state.units.map((u) => {
          if (u.id === 'cap') return { ...u, position: { q: 0, r: 2 }, carryingFlag: true };
          if (u.id === 'def') return { ...u, position: { q: -3, r: 0 } };
          return u;
        }),
        flags: {
          ...state.flags,
          B: state.flags.B.map((f) => ({
            ...f,
            carried: true,
            carrierId: 'cap',
            position: { q: 0, r: 2 },
          })),
        },
      };

      state = submitMove(state, 'cap', ['S']).state;
      const { state: newState, record } = resolveTurn(state);

      expect(newState.phase).toBe('finished');
      expect(newState.winner).toBe('A');
      expect(newState.score.A).toBe(1);
      expect(record.flagEvents.some((e) => e.includes('captured'))).toBe(true);
    });

    it('flag drop — carrier dies, flag returns to enemy base', () => {
      const players = [
        { id: 'carrier', team: 'A' as const, unitClass: 'mage' as UnitClass },
        { id: 'killer', team: 'B' as const, unitClass: 'rogue' as UnitClass },
      ];
      let state = createInProgressState(map, players);

      state = {
        ...state,
        units: state.units.map((u) => {
          if (u.id === 'carrier') return { ...u, position: { q: 0, r: 0 }, carryingFlag: true };
          if (u.id === 'killer') return { ...u, position: { q: 0, r: 1 } };
          return u;
        }),
        flags: {
          ...state.flags,
          B: state.flags.B.map((f) => ({
            ...f,
            carried: true,
            carrierId: 'carrier',
            position: { q: 0, r: 0 },
          })),
        },
      };

      const { state: newState, record } = resolveTurn(state);

      expect(newState.flags.B[0].carried).toBe(false);
      expect(newState.flags.B[0].carrierId).toBeUndefined();
      expect(hexEquals(newState.flags.B[0].position, map.bases.B[0].flag)).toBe(true);
      expect(record.flagEvents.some((e) => e.includes('returned to base'))).toBe(true);
    });

    it('draw on turn limit', () => {
      let state = createInProgressState(map, makePlayers(1), { turnLimit: 2 });

      state = resolveTurn(state).state; // turn 0 -> 1
      state = resolveTurn(state).state; // turn 1 -> 2
      state = resolveTurn(state).state; // turn 2 -> 3, exceeds limit

      expect(state.phase).toBe('finished');
      expect(state.winner).toBeNull();
      expect(isGameOver(state)).toBe(true);
    });

    it('increments turn counter', () => {
      let state = createInProgressState(map, makePlayers(1));
      expect(state.turn).toBe(0);
      state = resolveTurn(state).state;
      expect(state.turn).toBe(1);
      state = resolveTurn(state).state;
      expect(state.turn).toBe(2);
    });

    it('clears move submissions after resolving', () => {
      let state = createInProgressState(map, makePlayers(1));
      state = submitMove(state, 'a0', ['N']).state;
      expect(allMovesSubmitted(state)).toBe(false); // b0 hasn't submitted
      state = submitMove(state, 'b0', ['S']).state;
      expect(allMovesSubmitted(state)).toBe(true);
      state = resolveTurn(state).state;
      expect(allMovesSubmitted(state)).toBe(false); // cleared
    });
  });

  describe('getStateForAgent', () => {
    it('returns fog of war — only visible tiles', () => {
      const state = createInProgressState(map, makePlayers(1));
      const agentState = getStateForAgent(state, 'a0');

      expect(agentState.visibleTiles.length).toBeGreaterThan(0);
      expect(agentState.visibleTiles.length).toBeLessThan(map.tiles.size);
    });

    it('includes ally unit IDs but not enemy IDs', () => {
      const players = [
        { id: 'a0', team: 'A' as const, unitClass: 'rogue' as UnitClass },
        { id: 'a1', team: 'A' as const, unitClass: 'knight' as UnitClass },
        { id: 'b0', team: 'B' as const, unitClass: 'mage' as UnitClass },
      ];
      let state = createInProgressState(map, players);

      state = {
        ...state,
        units: state.units.map((u) => {
          if (u.id === 'a0') return { ...u, position: { q: 0, r: 0 } };
          if (u.id === 'a1') return { ...u, position: { q: 0, r: 1 } };
          if (u.id === 'b0') return { ...u, position: { q: 1, r: 0 } };
          return u;
        }),
      };

      const agentState = getStateForAgent(state, 'a0');

      const allyTile = agentState.visibleTiles.find(
        (t) => t.unit && t.unit.team === 'A' && t.unit.id === 'a1',
      );
      expect(allyTile).toBeDefined();
      expect(allyTile?.unit?.id).toBe('a1');

      const enemyTile = agentState.visibleTiles.find((t) => t.unit && t.unit.team === 'B');
      expect(enemyTile).toBeDefined();
      expect(enemyTile?.unit?.id).toBeUndefined();
    });

    it('reports correct unit status', () => {
      const state = createInProgressState(map, makePlayers(1));
      const agentState = getStateForAgent(state, 'a0');

      expect(agentState.yourUnit.id).toBe('a0');
      expect(agentState.yourUnit.unitClass).toBe('rogue');
      expect(agentState.yourUnit.alive).toBe(true);
      expect(agentState.yourUnit.carryingFlag).toBe(false);
    });

    it('reports enemy flag as carried_by_you when agent carries it', () => {
      let state = createInProgressState(map, makePlayers(1));
      state = {
        ...state,
        units: state.units.map((u) => (u.id === 'a0' ? { ...u, carryingFlag: true } : u)),
        flags: {
          ...state.flags,
          B: state.flags.B.map((f) => ({ ...f, carried: true, carrierId: 'a0' })),
        },
      };

      const agentState = getStateForAgent(state, 'a0');
      expect(agentState.enemyFlag.status).toBe('carried_by_you');
    });

    it('reports move submission status', () => {
      let state = createInProgressState(map, makePlayers(1));
      let agentState = getStateForAgent(state, 'a0');
      expect(agentState.moveSubmitted).toBe(false);

      state = submitMove(state, 'a0', ['N']).state;
      agentState = getStateForAgent(state, 'a0');
      expect(agentState.moveSubmitted).toBe(true);
    });
  });

  describe('allMovesSubmitted', () => {
    it('returns true when all alive units have submitted', () => {
      let state = createInProgressState(map, makePlayers(1));
      expect(allMovesSubmitted(state)).toBe(false);

      state = submitMove(state, 'a0', ['N']).state;
      expect(allMovesSubmitted(state)).toBe(false);

      state = submitMove(state, 'b0', ['S']).state;
      expect(allMovesSubmitted(state)).toBe(true);
    });

    it('ignores dead units', () => {
      let state = createInProgressState(map, makePlayers(1));
      state = {
        ...state,
        units: state.units.map((u) => (u.id === 'b0' ? { ...u, alive: false } : u)),
      };

      state = submitMove(state, 'a0', ['N']).state;
      expect(allMovesSubmitted(state)).toBe(true);
    });
  });

  describe('isGameOver', () => {
    it('returns false during play', () => {
      const state = createInProgressState(map, makePlayers(1));
      expect(isGameOver(state)).toBe(false);
    });

    it('returns true after game ends', () => {
      let state = createInProgressState(map, makePlayers(1), { turnLimit: 0 });
      state = resolveTurn(state).state;
      expect(isGameOver(state)).toBe(true);
    });
  });
});
