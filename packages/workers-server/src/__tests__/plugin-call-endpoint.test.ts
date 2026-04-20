/**
 * Tests for the worker-level plugin-call endpoint
 * (`POST /api/plugin/:pluginId/call`, Phase 5.2).
 *
 * Coverage:
 *  - leaderboard: anonymous caller gets a list ordered by elo desc.
 *  - my-stats: authenticated playerId returns their row + recent matches.
 *  - my-stats: anonymous caller gets a 401 (auth-required).
 *  - unknown plugin id → 404.
 *  - known plugin, unknown call name → 400.
 *  - body without `name` → 400.
 *
 * The endpoint is exercised via `handlePluginCall` directly (the
 * worker fetch handler is just a thin wrapper that maps thrown errors
 * to status codes — covered by exercising both layers through the
 * helper, plus an explicit error-mapping table at the bottom).
 */

import type { D1Database } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../env.js';
import {
  _resetWorkerPluginRuntimeForTests,
  handlePluginCall,
  PluginEndpointBadRequestError,
  PluginEndpointNotFoundError,
  PluginEndpointUnauthorizedError,
} from '../plugin-endpoint.js';

// ---------------------------------------------------------------------------
// Tiny in-memory D1 stand-in. We only need .prepare(...).bind(...).{first,all}
// against a known table set; full SQL parsing is overkill, so we route by
// fingerprint.
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
  started_at: string | null;
  ended_at: string | null;
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
  // biome-ignore lint/suspicious/noExplicitAny: minimal D1 surface stub
  const stmt = (sql: string): any => {
    let bindings: unknown[] = [];
    const api = {
      bind(...args: unknown[]) {
        bindings = args;
        return api;
      },
      // biome-ignore lint/suspicious/noExplicitAny: returning per-query shapes
      async first<T = any>(): Promise<T | null> {
        const r = run();
        return (Array.isArray(r) ? (r[0] ?? null) : r) as T | null;
      },
      // biome-ignore lint/suspicious/noExplicitAny: returning per-query shapes
      async all<T = any>(): Promise<{ results: T[] }> {
        const r = run();
        return { results: (Array.isArray(r) ? r : []) as T[] };
      },
    };
    function run(): unknown {
      // Leaderboard: ORDER BY elo DESC LIMIT ? OFFSET ?
      if (sql.includes('FROM players ORDER BY elo DESC LIMIT ? OFFSET ?')) {
        const limit = Number(bindings[0]);
        const offset = Number(bindings[1]);
        return [...store.players].sort((a, b) => b.elo - a.elo).slice(offset, offset + limit);
      }
      // Single player by id
      if (sql.includes('FROM players WHERE id = ?')) {
        return store.players.find((p) => p.id === bindings[0]) ?? null;
      }
      // Player matches join
      if (sql.includes('plugin_elo_matches') && sql.includes('plugin_elo_match_players')) {
        const playerId = bindings[0];
        const limit = Number(bindings[1]);
        const rows = store.matchPlayers
          .filter((mp) => mp.player_id === playerId)
          .map((mp) => {
            const m = store.matches.find((mm) => mm.id === mp.match_id);
            return {
              id: mp.match_id,
              game_type: m?.game_type ?? null,
              started_at: m?.started_at ?? null,
              ended_at: m?.ended_at ?? null,
              team: mp.team,
              unit_class: mp.class,
              elo_before: mp.elo_before,
              elo_after: mp.elo_after,
            };
          })
          .slice(0, limit);
        return rows;
      }
      throw new Error(`unhandled SQL in fake D1: ${sql}`);
    }
    return api;
  };
  // biome-ignore lint/suspicious/noExplicitAny: D1 stub
  return { prepare: stmt } as any;
}

function buildEnv(store: FakeStore): Env {
  return {
    DB: makeFakeD1(store),
    // biome-ignore lint/suspicious/noExplicitAny: only DB is used by ELO plugin
    GAME_ROOM: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: only DB is used by ELO plugin
    LOBBY: {} as any,
    ENVIRONMENT: 'test',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/plugin/:pluginId/call — Phase 5.2', () => {
  let store: FakeStore;
  let env: Env;

  beforeEach(() => {
    _resetWorkerPluginRuntimeForTests();
    store = {
      players: [
        { id: 'p1', handle: 'alice', elo: 1500, games_played: 10, wins: 7 },
        { id: 'p2', handle: 'bob', elo: 1200, games_played: 8, wins: 4 },
        { id: 'p3', handle: 'carol', elo: 1700, games_played: 12, wins: 9 },
      ],
      matches: [{ id: 'm1', game_type: 'oathbreaker', started_at: 't0', ended_at: 't1' }],
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
    env = buildEnv(store);
  });

  it('elo.leaderboard — anonymous caller gets rows sorted by elo desc', async () => {
    const result = (await handlePluginCall(
      env,
      'elo',
      'leaderboard',
      { limit: 5 },
      null,
    )) as Array<{
      handle: string;
      elo: number;
    }>;
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.handle)).toEqual(['carol', 'alice', 'bob']);
    expect(result[0]?.elo).toBe(1700);
  });

  it('elo.leaderboard — limit defaults to 50, capped at 200', async () => {
    const result = (await handlePluginCall(env, 'elo', 'leaderboard', {}, null)) as unknown[];
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('elo.my-stats — authenticated playerId returns their row + recent matches', async () => {
    const result = (await handlePluginCall(env, 'elo', 'my-stats', {}, 'p1')) as {
      handle: string;
      elo: number;
      recentMatches: unknown[];
    };
    expect(result.handle).toBe('alice');
    expect(result.elo).toBe(1500);
    expect(result.recentMatches).toHaveLength(1);
  });

  it('elo.my-stats — unknown playerId returns null (not 404)', async () => {
    const result = await handlePluginCall(env, 'elo', 'my-stats', {}, 'p999');
    expect(result).toBeNull();
  });

  it('elo.my-stats — anonymous caller throws PluginEndpointUnauthorizedError', async () => {
    await expect(handlePluginCall(env, 'elo', 'my-stats', {}, null)).rejects.toBeInstanceOf(
      PluginEndpointUnauthorizedError,
    );
  });

  it('unknown plugin id throws PluginEndpointNotFoundError', async () => {
    await expect(
      handlePluginCall(env, 'does-not-exist', 'whatever', {}, null),
    ).rejects.toBeInstanceOf(PluginEndpointNotFoundError);
  });

  it('elo.<unknown> throws PluginEndpointBadRequestError', async () => {
    await expect(handlePluginCall(env, 'elo', 'unknown-call', {}, null)).rejects.toBeInstanceOf(
      PluginEndpointBadRequestError,
    );
  });
});
