import { mustFind } from '@coordination-games/engine';
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
      const a0 = mustFind(state.units, (u) => u.id === 'a0');
      const a1 = mustFind(state.units, (u) => u.id === 'a1');
      expect(hexEquals(a0.position, map.bases.A[0].spawns[0])).toBe(true);
      expect(hexEquals(a1.position, map.bases.A[0].spawns[1])).toBe(true);

      const b0 = mustFind(state.units, (u) => u.id === 'b0');
      const b1 = mustFind(state.units, (u) => u.id === 'b1');
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

      const a0 = mustFind(newState.units, (u) => u.id === 'a0');
      expect(hexEquals(a0.position, { q: 0, r: 1 })).toBe(true);
      expect(record.unitPositionsBefore.get('a0')).toEqual({ q: 0, r: 2 });
      expect(record.unitPositionsAfter.get('a0')).toEqual({ q: 0, r: 1 });
    });

    it('units without submissions stay in place', () => {
      const state = createInProgressState(map, makePlayers(1));
      const { state: newState } = resolveTurn(state);

      const a0 = mustFind(newState.units, (u) => u.id === 'a0');
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
      let mage = mustFind(state.units, (u) => u.id === 'mage_b');
      expect(mage.alive).toBe(false);
      expect(mage.respawnTurn).toBe(2);
      // Moved to spawn position immediately (for spectator visibility)
      expect(hexEquals(mage.position, map.bases.B[0].spawns[0])).toBe(true);

      // Turn 1: still dead
      state = resolveTurn(state).state;
      mage = mustFind(state.units, (u) => u.id === 'mage_b');
      expect(mage.alive).toBe(false);

      // Turn 2: respawns
      state = resolveTurn(state).state;
      mage = mustFind(state.units, (u) => u.id === 'mage_b');
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
      const unit = mustFind(newState.units, (u) => u.id === 'fast');
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
    it('emits mapStatic (radius + bases) with tuple coord shape', () => {
      const state = createInProgressState(map, makePlayers(1));
      const agentState = getStateForAgent(state, 'a0');

      expect(agentState.mapStatic.radius).toBe(map.radius);
      // Base flag + spawns are emitted as `[q, r]` tuples on the envelope.
      // Internal map.bases stays `{q, r}` — assert the conversion point here.
      expect(agentState.mapStatic.bases).toEqual({
        A: map.bases.A.map((b) => ({
          flag: [b.flag.q, b.flag.r],
          spawns: b.spawns.map((s) => [s.q, s.r]),
        })),
        B: map.bases.B.map((b) => ({
          flag: [b.flag.q, b.flag.r],
          spawns: b.spawns.map((s) => [s.q, s.r]),
        })),
      });
    });

    it('fog-filters visibleWalls to LoS — subset of total walls', () => {
      const state = createInProgressState(map, makePlayers(1));
      const agentState = getStateForAgent(state, 'a0');

      const totalWalls = [...map.tiles.values()].filter((t) => t === 'wall').length;
      expect(agentState.visibleWalls.length).toBeLessThanOrEqual(totalWalls);
      // visibleWalls emits `[q, r]` tuples on the envelope.
      // Every emitted wall must actually be a wall in the source map.
      for (const [q, r] of agentState.visibleWalls) {
        expect(map.tiles.get(`${q},${r}`)).toBe('wall');
      }
    });

    it('visibleWalls hides walls outside vision — knight has range 2', () => {
      // Knight vision=2. Place a wall 5 hexes away — must be hidden.
      const bigMap: GameMap = {
        radius: 6,
        tiles: new Map<string, TileType>(),
        bases: {
          A: [{ flag: { q: 0, r: 6 }, spawns: [{ q: 0, r: 5 }] }],
          B: [{ flag: { q: 0, r: -6 }, spawns: [{ q: 0, r: -5 }] }],
        },
      };
      // Fill with ground
      for (let q = -6; q <= 6; q++) {
        for (let r = Math.max(-6, -q - 6); r <= Math.min(6, -q + 6); r++) {
          bigMap.tiles.set(hexToString({ q, r }), 'ground');
        }
      }
      bigMap.tiles.set(hexToString({ q: 0, r: 6 }), 'base_a');
      bigMap.tiles.set(hexToString({ q: 0, r: 5 }), 'base_a');
      bigMap.tiles.set(hexToString({ q: 0, r: -6 }), 'base_b');
      bigMap.tiles.set(hexToString({ q: 0, r: -5 }), 'base_b');
      // Walls: one close to spawn, one far.
      bigMap.tiles.set(hexToString({ q: 1, r: 4 }), 'wall'); // dist 1 from spawn (0,5) — visible
      bigMap.tiles.set(hexToString({ q: 0, r: 0 }), 'wall'); // dist 5 from spawn — hidden

      const state = createInProgressState(bigMap, [
        { id: 'a0', team: 'A', unitClass: 'knight' },
        { id: 'b0', team: 'B', unitClass: 'knight' },
      ]);
      const walls = getStateForAgent(state, 'a0').visibleWalls;
      const wallKeys = new Set(walls.map(([q, r]) => `${q},${r}`));

      expect(wallKeys.has('1,4')).toBe(true); // close wall shown
      expect(wallKeys.has('0,0')).toBe(false); // far wall hidden
    });

    it('filters occupants by fog of war', () => {
      const state = createInProgressState(map, makePlayers(1));
      const agentState = getStateForAgent(state, 'a0');

      // At minimum the viewer themself should show up.
      expect(agentState.visibleOccupants.length).toBeGreaterThan(0);
      // Most hexes are empty, so occupants is much smaller than full map.
      expect(agentState.visibleOccupants.length).toBeLessThan(map.tiles.size);
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

      const allyTile = agentState.visibleOccupants.find(
        (t) => t.unit && t.unit.team === 'A' && t.unit.id === 'a1',
      );
      expect(allyTile).toBeDefined();
      expect(allyTile?.unit?.id).toBe('a1');

      const enemyTile = agentState.visibleOccupants.find((t) => t.unit && t.unit.team === 'B');
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

    it('keeps turn and phase canonical at top level, not duplicated in summary', () => {
      const state = createInProgressState(map, makePlayers(1));
      const agentState = getStateForAgent(state, 'a0');

      // Canonical copies live at the top level.
      expect(agentState.turn).toBe(state.turn);
      expect(agentState.phase).toBe(state.phase);

      // Summary must NOT carry turn/phase — they'd double bytes and
      // pollute the summary diff on every scalar change.
      expect((agentState.summary as Record<string, unknown>).turn).toBeUndefined();
      expect((agentState.summary as Record<string, unknown>).phase).toBeUndefined();
    });

    it('timeRemainingSeconds is 0 before the game is in progress (no deadline set)', () => {
      // createInProgressState only flips the phase; it does NOT set
      // turnDeadlineMs — that's the plugin's job in response to game_start.
      // The pure helper must emit 0 when there's no deadline yet.
      const state = createInProgressState(map, makePlayers(1));
      const agentState = getStateForAgent(state, 'a0');
      expect(agentState.timeRemainingSeconds).toBe(0);
    });

    it('timeRemainingSeconds ticks down from turnDeadlineMs (in [0, turnTimerSeconds])', () => {
      const state = createInProgressState(map, makePlayers(1));
      // Simulate what the plugin's scheduleNextTurn would do.
      const seconds = state.config.turnTimerSeconds;
      const withDeadline: CtlGameState = {
        ...state,
        turnDeadlineMs: Date.now() + seconds * 1000,
      };

      const agentState = getStateForAgent(withDeadline, 'a0');
      expect(agentState.timeRemainingSeconds).toBeGreaterThanOrEqual(0);
      expect(agentState.timeRemainingSeconds).toBeLessThanOrEqual(seconds);
    });

    it('envelope coord shapes: tuples for pure-coord arrays, pos-object for metadata entries', () => {
      // Populate visible occupants + enemies + flags so every shape gets covered.
      const players = [
        { id: 'a0', team: 'A' as const, unitClass: 'rogue' as UnitClass },
        { id: 'b0', team: 'B' as const, unitClass: 'mage' as UnitClass },
      ];
      let state = createInProgressState(map, players);
      state = {
        ...state,
        units: state.units.map((u) => {
          if (u.id === 'a0') return { ...u, position: { q: 0, r: 0 } };
          if (u.id === 'b0') return { ...u, position: { q: 0, r: 1 } };
          return u;
        }),
      };

      const agentState = getStateForAgent(state, 'a0');

      // summary.pos — direct tuple on the summary metadata container
      expect(Array.isArray(agentState.summary.pos)).toBe(true);
      expect(agentState.summary.pos).toHaveLength(2);
      expect(agentState.summary.pos).toEqual([0, 0]);

      // yourUnit.position — direct tuple (yourUnit is the metadata container)
      expect(Array.isArray(agentState.yourUnit.position)).toBe(true);
      expect(agentState.yourUnit.position).toEqual([0, 0]);

      // visibleWalls — pure-coord list, HexTuple entries
      for (const entry of agentState.visibleWalls) {
        expect(Array.isArray(entry)).toBe(true);
        expect(entry).toHaveLength(2);
      }

      // visibleOccupants — pos-object (carries optional unit/flag metadata)
      for (const occ of agentState.visibleOccupants) {
        expect(Array.isArray(occ.pos)).toBe(true);
        expect(occ.pos).toHaveLength(2);
        expect((occ as unknown as Record<string, unknown>).q).toBeUndefined();
        expect((occ as unknown as Record<string, unknown>).r).toBeUndefined();
      }

      // summary.enemies — pos-object (metadata: unitClass)
      expect(agentState.summary.enemies.length).toBeGreaterThan(0);
      for (const e of agentState.summary.enemies) {
        expect(Array.isArray(e.pos)).toBe(true);
        expect(e.pos).toHaveLength(2);
        expect(typeof e.unitClass).toBe('string');
      }

      // mapStatic.bases — flag is a tuple, spawns are a tuple list
      for (const b of agentState.mapStatic.bases.A) {
        expect(Array.isArray(b.flag)).toBe(true);
        expect(b.flag).toHaveLength(2);
        for (const s of b.spawns) {
          expect(Array.isArray(s)).toBe(true);
          expect(s).toHaveLength(2);
        }
      }
    });

    it('summary.flags emits as pos-object with team metadata when a loose flag is visible', () => {
      // Place viewer next to own flag so it shows up in visibleOccupants
      // (and, by extension, summary.flags).
      const players = [{ id: 'a0', team: 'A' as const, unitClass: 'rogue' as UnitClass }];
      let state = createInProgressState(map, players);
      state = {
        ...state,
        units: state.units.map((u) => (u.id === 'a0' ? { ...u, position: { q: 0, r: 2 } } : u)),
      };

      const agentState = getStateForAgent(state, 'a0');
      expect(agentState.summary.flags.length).toBeGreaterThan(0);
      for (const f of agentState.summary.flags) {
        expect(Array.isArray(f.pos)).toBe(true);
        expect(f.pos).toHaveLength(2);
        expect(['A', 'B']).toContain(f.team);
      }
    });

    it('timeRemainingSeconds clamps to 0 when the deadline has already passed', () => {
      const state = createInProgressState(map, makePlayers(1));
      const withPastDeadline: CtlGameState = {
        ...state,
        turnDeadlineMs: Date.now() - 5_000,
      };

      const agentState = getStateForAgent(withPastDeadline, 'a0');
      expect(agentState.timeRemainingSeconds).toBe(0);
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
