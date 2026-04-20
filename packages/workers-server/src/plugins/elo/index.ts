/**
 * ELO ServerPlugin — D1-backed leaderboard + per-player stats.
 *
 * Phase 5.2 turned ELO from a "pretend plugin" (hardcoded but never run by
 * anyone) into a real `ServerPlugin` registered at the worker level.
 * Routed via `POST /api/plugin/elo/call` (see `index.ts`).
 *
 * Why worker-level (not per-DO): ELO is global / cross-game (a single
 * leaderboard across every game type). The per-DO `ServerPluginRuntime`
 * (Phase 5.3 settlement, future per-game plugins) is a different runtime
 * instance from the global one used here.
 *
 * Tables: `plugin_elo_matches`, `plugin_elo_match_players` (owned by this
 * plugin, see migration 0010_elo_plugin_namespace.sql). Reads / writes the
 * `elo`, `games_played`, `wins` columns on the shared `players` table —
 * those columns are part of the player identity row, not plugin-namespaced.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { SpectatorViewer } from '../capabilities.js';
import type { ServerPlugin } from '../runtime.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EloLeaderboardRow {
  id: string;
  handle: string;
  elo: number;
  gamesPlayed: number;
  wins: number;
}

export interface EloMatchRow {
  matchId: string;
  gameType: string;
  team: string | null;
  unitClass: string | null;
  eloBefore: number | null;
  eloAfter: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface EloPlayerStats extends EloLeaderboardRow {
  recentMatches: EloMatchRow[];
}

// ---------------------------------------------------------------------------
// Bounds + defaults
// ---------------------------------------------------------------------------

const DEFAULT_LEADERBOARD_LIMIT = 50;
const MAX_LEADERBOARD_LIMIT = 200;
const DEFAULT_RECENT_MATCH_LIMIT = 20;
const MAX_RECENT_MATCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// Errors — surfaced as 400 / 401 by the /api/plugin/:id/call endpoint
// ---------------------------------------------------------------------------

/** Raised when `handleCall` is invoked with an unknown `name`. */
export class EloUnknownCallError extends Error {
  constructor(name: string) {
    super(`Unknown elo call: ${name}`);
    this.name = 'EloUnknownCallError';
  }
}

/** Raised when a call requires an authenticated player viewer. */
export class EloAuthRequiredError extends Error {
  constructor(name: string) {
    super(`elo.${name} requires an authenticated player`);
    this.name = 'EloAuthRequiredError';
  }
}

// ---------------------------------------------------------------------------
// Helpers — exported for unit testability
// ---------------------------------------------------------------------------

export function clampLimit(raw: unknown, def: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : def;
  if (n <= 0) return def;
  return Math.min(n, max);
}

export function clampOffset(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.max(n, 0);
}

// biome-ignore lint/suspicious/noExplicitAny: rows come back as plain objects from D1
function rowToLeaderboard(r: any): EloLeaderboardRow {
  return {
    id: r.id,
    handle: r.handle,
    elo: r.elo,
    gamesPlayed: r.games_played,
    wins: r.wins,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: rows come back as plain objects from D1
function rowToMatch(r: any): EloMatchRow {
  return {
    matchId: r.id,
    gameType: r.game_type,
    team: r.team,
    unitClass: r.unit_class,
    eloBefore: r.elo_before,
    eloAfter: r.elo_after,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/**
 * Pull a playerId out of a viewer if it's authenticated. Spectators / replay
 * viewers / admins (no playerId) get `null`.
 */
export function playerIdFromViewer(viewer: SpectatorViewer): string | null {
  if (viewer.kind === 'player' || viewer.kind === 'bot') return viewer.playerId;
  return null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Build the ELO ServerPlugin. The returned plugin is `register()`able with
 * a `ServerPluginRuntime` whose `caps.d1` is the worker's D1 binding.
 *
 * `init()` captures the D1 handle. `handleCall()` is the only surface
 * clients touch — `name === 'leaderboard'` for the global top-N, and
 * `name === 'my-stats'` for `viewer.playerId`'s row + recent matches.
 */
export function createEloServerPlugin(): ServerPlugin<'d1'> {
  let db: D1Database | null = null;

  return {
    id: 'elo',
    requires: ['d1'] as const,
    async init(caps) {
      db = caps.d1;
    },

    async handleCall(name, args, viewer) {
      if (!db) throw new Error('elo plugin not initialised');

      if (name === 'leaderboard') {
        // biome-ignore lint/suspicious/noExplicitAny: tagged-call args validated below
        const a = (args ?? {}) as any;
        const limit = clampLimit(a.limit, DEFAULT_LEADERBOARD_LIMIT, MAX_LEADERBOARD_LIMIT);
        const offset = clampOffset(a.offset);
        const result = await db
          .prepare(
            'SELECT id, handle, elo, games_played, wins FROM players ORDER BY elo DESC LIMIT ? OFFSET ?',
          )
          .bind(limit, offset)
          // biome-ignore lint/suspicious/noExplicitAny: D1 .all<any>() shape
          .all<any>();
        return result.results.map(rowToLeaderboard);
      }

      if (name === 'my-stats') {
        const playerId = playerIdFromViewer(viewer);
        if (!playerId) throw new EloAuthRequiredError(name);
        // biome-ignore lint/suspicious/noExplicitAny: tagged-call args validated below
        const a = (args ?? {}) as any;
        const matchLimit = clampLimit(
          a.matchLimit,
          DEFAULT_RECENT_MATCH_LIMIT,
          MAX_RECENT_MATCH_LIMIT,
        );

        const player = await db
          .prepare('SELECT id, handle, elo, games_played, wins FROM players WHERE id = ?')
          .bind(playerId)
          // biome-ignore lint/suspicious/noExplicitAny: D1 .first<any>() shape
          .first<any>();
        if (!player) return null;

        const matches = await db
          .prepare(
            `SELECT m.id, m.game_type, m.started_at, m.ended_at,
                    mp.team, mp.class AS unit_class, mp.elo_before, mp.elo_after
               FROM plugin_elo_matches m
               JOIN plugin_elo_match_players mp ON m.id = mp.match_id
              WHERE mp.player_id = ?
              ORDER BY m.rowid DESC
              LIMIT ?`,
          )
          .bind(playerId, matchLimit)
          // biome-ignore lint/suspicious/noExplicitAny: D1 .all<any>() shape
          .all<any>();

        const stats: EloPlayerStats = {
          ...rowToLeaderboard(player),
          recentMatches: matches.results.map(rowToMatch),
        };
        return stats;
      }

      throw new EloUnknownCallError(name);
    },
  };
}
