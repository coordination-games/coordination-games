/**
 * Unit tests for the ELO ServerPlugin (Phase 5.2).
 *
 * Exercises `handleCall` against an in-memory D1 fake. The capability
 * subset is the canonical path — register the plugin in a real
 * ServerPluginRuntime so we cover the same wiring the worker uses.
 *
 * Coverage:
 *  - leaderboard: returns rows, ordered by elo desc, respects limit/offset.
 *  - leaderboard: invalid limit values clamp to defaults / max.
 *  - my-stats: authenticated player gets stats + recent matches.
 *  - my-stats: unknown player → null (the row simply doesn't exist).
 *  - my-stats: unauthenticated viewer → EloAuthRequiredError.
 *  - unknown call name → EloUnknownCallError.
 *  - clampLimit / clampOffset: numeric edge cases.
 */

import type { D1Database, DurableObjectStorage } from '@cloudflare/workers-types';
import type { RelayEnvelope } from '@coordination-games/engine';
import { OATH_GAME_ID } from '@coordination-games/game-oathbreaker';
import { describe, expect, it, vi } from 'vitest';
import {
  type Capabilities,
  NamespacedStorage,
  type RelayClient,
  type SpectatorViewer,
} from '../../capabilities.js';
import { ServerPluginRuntime } from '../../runtime.js';
import {
  clampLimit,
  clampOffset,
  createEloServerPlugin,
  EloAuthRequiredError,
  EloUnknownCallError,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface PlayerRow {
  id: string;
  handle: string;
  elo: number;
  games_played: number;
  wins: number;
}
interface MatchRow {
  id: string;
  game_type: string;
}
interface MatchPlayerRow {
  match_id: string;
  player_id: string;
  team: string | null;
  class: string | null;
  elo_before: number | null;
  elo_after: number | null;
}
interface FakeStore {
  players: PlayerRow[];
  matches: MatchRow[];
  matchPlayers: MatchPlayerRow[];
}

function makeFakeD1(store: FakeStore): D1Database {
  interface FakeStmt {
    bind: (...args: unknown[]) => FakeStmt;
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
  }
  const stmt = (sql: string): FakeStmt => {
    let bindings: unknown[] = [];
    const api: FakeStmt = {
      bind(...args: unknown[]) {
        bindings = args;
        return api;
      },
      async first<T = unknown>(): Promise<T | null> {
        const r = run();
        return (Array.isArray(r) ? (r[0] ?? null) : r) as T | null;
      },
      async all<T = unknown>(): Promise<{ results: T[] }> {
        const r = run();
        return { results: (Array.isArray(r) ? r : []) as T[] };
      },
    };
    function run(): unknown {
      if (sql.includes('FROM players ORDER BY elo DESC LIMIT ? OFFSET ?')) {
        const limit = Number(bindings[0]);
        const offset = Number(bindings[1]);
        return [...store.players].sort((a, b) => b.elo - a.elo).slice(offset, offset + limit);
      }
      if (sql.includes('FROM players WHERE id = ?')) {
        return store.players.find((p) => p.id === bindings[0]) ?? null;
      }
      if (sql.includes('plugin_elo_matches') && sql.includes('plugin_elo_match_players')) {
        const playerId = bindings[0];
        const limit = Number(bindings[1]);
        return store.matchPlayers
          .filter((mp) => mp.player_id === playerId)
          .map((mp) => {
            const m = store.matches.find((mm) => mm.id === mp.match_id);
            return {
              id: mp.match_id,
              game_type: m?.game_type ?? null,
              started_at: null,
              ended_at: null,
              team: mp.team,
              unit_class: mp.class,
              elo_before: mp.elo_before,
              elo_after: mp.elo_after,
            };
          })
          .slice(0, limit);
      }
      throw new Error(`unhandled SQL in fake D1: ${sql}`);
    }
    return api;
  };
  return { prepare: stmt } as unknown as D1Database;
}

function makeMemoryStorage(): DurableObjectStorage {
  // The ELO plugin doesn't touch storage; a bare cast is enough. The real
  // in-memory storage helper lives in `../__tests__/test-helpers.ts` for
  // tests that DO touch storage.
  return {} as DurableObjectStorage;
}

function buildCaps(d1: D1Database): Capabilities {
  const fakeRelay: RelayClient = {
    publish: vi.fn(async () => {}),
    visibleTo: vi.fn(async (_v: SpectatorViewer) => [] as RelayEnvelope[]),
    since: vi.fn(async (_i: number, _v: SpectatorViewer) => [] as RelayEnvelope[]),
    getTip: vi.fn(async () => 0),
  };
  return {
    storage: new NamespacedStorage(makeMemoryStorage(), '__test__'),
    relay: fakeRelay,
    alarms: { scheduleAt: vi.fn(async () => {}), cancel: vi.fn(async () => {}) },
    d1,
    // chain isn't exercised by the elo plugin; empty stub typed via the
    // canonical interface.
    chain: {} as Capabilities['chain'],
  };
}

async function buildRuntime(store: FakeStore): Promise<ServerPluginRuntime> {
  const caps = buildCaps(makeFakeD1(store));
  const runtime = new ServerPluginRuntime(caps, { gameId: '__worker__' });
  await runtime.register(createEloServerPlugin());
  return runtime;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SPECTATOR: SpectatorViewer = { kind: 'spectator' };
const ADMIN: SpectatorViewer = { kind: 'admin' };
const PLAYER = (id: string): SpectatorViewer => ({ kind: 'player', playerId: id });

describe('ELO ServerPlugin — handleCall', () => {
  it('leaderboard returns rows ordered by elo desc', async () => {
    const store: FakeStore = {
      players: [
        { id: 'p1', handle: 'alice', elo: 1500, games_played: 10, wins: 7 },
        { id: 'p2', handle: 'bob', elo: 1200, games_played: 8, wins: 4 },
        { id: 'p3', handle: 'carol', elo: 1700, games_played: 12, wins: 9 },
      ],
      matches: [],
      matchPlayers: [],
    };
    const runtime = await buildRuntime(store);
    const out = (await runtime.handleCall('elo', 'leaderboard', { limit: 5 }, SPECTATOR)) as Array<{
      handle: string;
    }>;
    expect(out.map((r) => r.handle)).toEqual(['carol', 'alice', 'bob']);
  });

  it('leaderboard respects offset for pagination', async () => {
    const store: FakeStore = {
      players: [
        { id: 'p1', handle: 'alice', elo: 1500, games_played: 0, wins: 0 },
        { id: 'p2', handle: 'bob', elo: 1700, games_played: 0, wins: 0 },
        { id: 'p3', handle: 'carol', elo: 1200, games_played: 0, wins: 0 },
      ],
      matches: [],
      matchPlayers: [],
    };
    const runtime = await buildRuntime(store);
    const out = (await runtime.handleCall(
      'elo',
      'leaderboard',
      { limit: 1, offset: 1 },
      SPECTATOR,
    )) as Array<{ handle: string }>;
    expect(out).toHaveLength(1);
    expect(out[0]?.handle).toBe('alice');
  });

  it('my-stats returns the caller row + recent matches when authenticated', async () => {
    const store: FakeStore = {
      players: [{ id: 'p1', handle: 'alice', elo: 1500, games_played: 10, wins: 7 }],
      matches: [{ id: 'm1', game_type: OATH_GAME_ID }],
      matchPlayers: [
        {
          match_id: 'm1',
          player_id: 'p1',
          team: 'A',
          class: 'rogue',
          elo_before: 1480,
          elo_after: 1500,
        },
      ],
    };
    const runtime = await buildRuntime(store);
    const out = (await runtime.handleCall('elo', 'my-stats', {}, PLAYER('p1'))) as {
      handle: string;
      elo: number;
      recentMatches: unknown[];
    };
    expect(out.handle).toBe('alice');
    expect(out.elo).toBe(1500);
    expect(out.recentMatches).toHaveLength(1);
  });

  it('my-stats returns null when player row does not exist', async () => {
    const store: FakeStore = { players: [], matches: [], matchPlayers: [] };
    const runtime = await buildRuntime(store);
    const out = await runtime.handleCall('elo', 'my-stats', {}, PLAYER('ghost'));
    expect(out).toBeNull();
  });

  it('my-stats throws EloAuthRequiredError for spectator viewer', async () => {
    const runtime = await buildRuntime({ players: [], matches: [], matchPlayers: [] });
    await expect(runtime.handleCall('elo', 'my-stats', {}, SPECTATOR)).rejects.toBeInstanceOf(
      EloAuthRequiredError,
    );
  });

  it('my-stats throws EloAuthRequiredError for admin viewer (no playerId)', async () => {
    const runtime = await buildRuntime({ players: [], matches: [], matchPlayers: [] });
    await expect(runtime.handleCall('elo', 'my-stats', {}, ADMIN)).rejects.toBeInstanceOf(
      EloAuthRequiredError,
    );
  });

  it('unknown call name throws EloUnknownCallError', async () => {
    const runtime = await buildRuntime({ players: [], matches: [], matchPlayers: [] });
    await expect(
      runtime.handleCall('elo', 'definitely-not-real', {}, SPECTATOR),
    ).rejects.toBeInstanceOf(EloUnknownCallError);
  });
});

describe('clampLimit / clampOffset', () => {
  it('clampLimit returns default when input is missing or non-numeric', () => {
    expect(clampLimit(undefined, 50, 200)).toBe(50);
    expect(clampLimit('twenty', 50, 200)).toBe(50);
    expect(clampLimit(NaN, 50, 200)).toBe(50);
  });

  it('clampLimit caps to max', () => {
    expect(clampLimit(9999, 50, 200)).toBe(200);
  });

  it('clampLimit returns default for non-positive values', () => {
    expect(clampLimit(0, 50, 200)).toBe(50);
    expect(clampLimit(-3, 50, 200)).toBe(50);
  });

  it('clampLimit floors fractional values', () => {
    expect(clampLimit(7.9, 50, 200)).toBe(7);
  });

  it('clampOffset clamps negatives to zero', () => {
    expect(clampOffset(-5)).toBe(0);
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset(10)).toBe(10);
  });
});
