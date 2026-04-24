/**
 * Single-game exclusivity guard — `handlePlayerLobbyJoin`.
 *
 * The pre-game credit balance check (in `LobbyDO.handleJoin`) rejects a join
 * when the player can't afford `entryCost`, but can't see a concurrent
 * lobby/game the player is already in — both holds read the same unmoved
 * on-chain balance and both pass. `handlePlayerLobbyJoin` now short-circuits
 * before the `INSERT OR REPLACE` on `player_sessions`: if the player's current
 * session points at a DIFFERENT unfinished lobby/game, return 409.
 *
 * "Unfinished" = session's lobby has `phase != 'finished'` AND (no `game_id`
 * OR `games.finished != 1`). The second clause is load-bearing for the
 * bot-pool happy path: a finished game leaves `lobbies.phase = 'in_progress'`
 * behind (LobbyDO only writes 'finished' on disband/fail), so checking
 * `games.finished` is the only way to let a bot cycle into its next lobby.
 *
 * These tests drive `handlePlayerLobbyJoin` directly with a hand-rolled D1
 * mock. The LobbyDO itself is stubbed out — we only assert the routing-layer
 * decision (409 vs. forward to LobbyDO).
 */

import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env.js';
import { readJson } from './test-helpers.js';

// Stub `cloudflare:workers` so importing `index.ts` under Node/vitest doesn't
// trip on the DurableObject base class (same approach as
// `lobby-balance-check.test.ts`). Must register before we dynamically import.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

type HandlePlayerLobbyJoinFn = (playerId: string, req: Request, env: Env) => Promise<Response>;
let handlePlayerLobbyJoin: HandlePlayerLobbyJoinFn;

beforeAll(async () => {
  ({ handlePlayerLobbyJoin } = (await import('../index.js')) as unknown as {
    handlePlayerLobbyJoin: HandlePlayerLobbyJoinFn;
  });
});

// ---------------------------------------------------------------------------
// D1 mock — one tiny in-memory row store, enough rows for the SELECT + the
// downstream `players` lookup + the `INSERT OR REPLACE` session upsert.
// ---------------------------------------------------------------------------

interface Row {
  [key: string]: unknown;
}

interface Tables {
  player_sessions: Map<string, Row>; // player_id → row
  lobbies: Map<string, Row>; // id → row
  games: Map<string, Row>; // game_id → row
  players: Map<string, Row>; // id → row
}

function emptyTables(): Tables {
  return {
    player_sessions: new Map(),
    lobbies: new Map(),
    games: new Map(),
    players: new Map(),
  };
}

/**
 * Hand-rolled D1 stub. Only supports the exact SQL shapes that
 * `handlePlayerLobbyJoin` issues:
 *
 *   1. SELECT ... FROM player_sessions ps JOIN lobbies l ... LEFT JOIN games g
 *      — the exclusivity SELECT.
 *   2. SELECT handle, elo FROM players WHERE id = ?
 *   3. INSERT OR REPLACE INTO player_sessions ...
 *
 * Any other SQL throws, so a future refactor that adds queries will surface
 * loudly in these tests rather than silently no-op.
 */
function makeDB(tables: Tables): D1Database {
  function prepare(sql: string) {
    const norm = sql.replace(/\s+/g, ' ').trim();
    return {
      _bindings: [] as unknown[],
      bind(...args: unknown[]) {
        this._bindings = args;
        return this;
      },
      async first<T>(): Promise<T | null> {
        if (norm.startsWith('SELECT ps.lobby_id')) {
          const [playerId] = this._bindings;
          const session = tables.player_sessions.get(playerId as string);
          if (!session) return null;
          const lobby = tables.lobbies.get(session.lobby_id as string);
          if (!lobby) return null;
          const gameId = (lobby.game_id as string | null) ?? null;
          const game = gameId ? tables.games.get(gameId) : null;
          return {
            lobbyId: session.lobby_id,
            lobbyPhase: lobby.phase,
            gameId,
            gameFinished: game ? (game.finished as number) : null,
          } as T;
        }
        if (norm.startsWith('SELECT handle, elo FROM players')) {
          const [id] = this._bindings;
          const row = tables.players.get(id as string);
          return (row ?? null) as T | null;
        }
        throw new Error(`unexpected SELECT: ${norm}`);
      },
      async run(): Promise<{ success: true }> {
        if (norm.startsWith('INSERT OR REPLACE INTO player_sessions')) {
          const [playerId, lobbyId, joinedAt] = this._bindings;
          tables.player_sessions.set(playerId as string, {
            player_id: playerId,
            lobby_id: lobbyId,
            joined_at: joinedAt,
          });
          return { success: true };
        }
        throw new Error(`unexpected run: ${norm}`);
      },
    };
  }
  return { prepare } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// LobbyDO mock — records the forwarded request so tests can verify the
// guard passes through (or does not) correctly. Returns a canned success so
// the downstream INSERT OR REPLACE on player_sessions is exercised.
// ---------------------------------------------------------------------------

function makeLobbyNamespace(
  forwarded: Array<{ lobbyId: string; playerId: string | null }>,
): DurableObjectNamespace {
  const stub = {
    idFromName(name: string) {
      return { _name: name, toString: () => name };
    },
    get(id: { _name: string }) {
      return {
        async fetch(req: Request): Promise<Response> {
          forwarded.push({
            lobbyId: id._name,
            playerId: req.headers.get('X-Player-Id'),
          });
          return Response.json({ ok: true, forwarded: id._name }, { status: 200 });
        },
      };
    },
  };
  return stub as unknown as DurableObjectNamespace;
}

function makeEnv(
  tables: Tables,
  forwarded: Array<{ lobbyId: string; playerId: string | null }>,
): Env {
  return {
    DB: makeDB(tables),
    LOBBY: makeLobbyNamespace(forwarded),
    GAME_ROOM: {} as DurableObjectNamespace,
    ENVIRONMENT: 'test',
  };
}

function joinRequest(lobbyId: string): Request {
  return new Request('https://worker/api/player/lobby/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handlePlayerLobbyJoin — single-game exclusivity guard', () => {
  it('player with no existing session → join succeeds and forwards to LobbyDO', async () => {
    const tables = emptyTables();
    tables.players.set('alice', { handle: 'alice', elo: 1000 });
    const forwarded: Array<{ lobbyId: string; playerId: string | null }> = [];
    const env = makeEnv(tables, forwarded);

    const resp = await handlePlayerLobbyJoin('alice', joinRequest('lobby-A'), env);
    expect(resp.status).toBe(200);
    expect(forwarded).toEqual([{ lobbyId: 'lobby-A', playerId: 'alice' }]);
    // session row written on success
    expect(tables.player_sessions.get('alice')?.lobby_id).toBe('lobby-A');
  });

  it('unfinished session in a DIFFERENT lobby (in lobby phase) → 409 Conflict', async () => {
    const tables = emptyTables();
    tables.players.set('alice', { handle: 'alice', elo: 1000 });
    tables.lobbies.set('lobby-A', {
      id: 'lobby-A',
      phase: 'lobby',
      game_id: null,
    });
    tables.player_sessions.set('alice', {
      player_id: 'alice',
      lobby_id: 'lobby-A',
      joined_at: '2026-01-01T00:00:00Z',
    });
    const forwarded: Array<{ lobbyId: string; playerId: string | null }> = [];
    const env = makeEnv(tables, forwarded);

    const resp = await handlePlayerLobbyJoin('alice', joinRequest('lobby-B'), env);
    expect(resp.status).toBe(409);
    const body = await readJson(resp);
    expect(body).toEqual({
      error: 'Already in an active game or lobby',
      playerId: 'alice',
      existing: { lobbyId: 'lobby-A', status: 'in_lobby' },
    });
    // guard short-circuits — LobbyDO must NOT be called and session unchanged
    expect(forwarded).toEqual([]);
    expect(tables.player_sessions.get('alice')?.lobby_id).toBe('lobby-A');
  });

  it('unfinished session MID-GAME in a different lobby → 409 with gameId + status: in_game', async () => {
    const tables = emptyTables();
    tables.players.set('alice', { handle: 'alice', elo: 1000 });
    tables.lobbies.set('lobby-A', {
      id: 'lobby-A',
      phase: 'in_progress',
      game_id: 'game-1',
    });
    tables.games.set('game-1', { game_id: 'game-1', finished: 0 });
    tables.player_sessions.set('alice', {
      player_id: 'alice',
      lobby_id: 'lobby-A',
      joined_at: '2026-01-01T00:00:00Z',
    });
    const forwarded: Array<{ lobbyId: string; playerId: string | null }> = [];
    const env = makeEnv(tables, forwarded);

    const resp = await handlePlayerLobbyJoin('alice', joinRequest('lobby-B'), env);
    expect(resp.status).toBe(409);
    const body = await readJson(resp);
    expect(body).toEqual({
      error: 'Already in an active game or lobby',
      playerId: 'alice',
      existing: { lobbyId: 'lobby-A', gameId: 'game-1', status: 'in_game' },
    });
    expect(forwarded).toEqual([]);
  });

  it('FINISHED session in a different lobby → join succeeds (bot-pool happy path)', async () => {
    // This is the critical case for pool bots. A post-game `lobbies` row
    // sits on `phase = 'in_progress'` forever (LobbyDO only writes
    // 'finished' on disband/fail), so the guard MUST consult
    // `games.finished` to let bots cycle through games.
    const tables = emptyTables();
    tables.players.set('bot-1', { handle: 'bot-1', elo: 1000 });
    tables.lobbies.set('lobby-A', {
      id: 'lobby-A',
      phase: 'in_progress',
      game_id: 'game-1',
    });
    tables.games.set('game-1', { game_id: 'game-1', finished: 1 });
    tables.player_sessions.set('bot-1', {
      player_id: 'bot-1',
      lobby_id: 'lobby-A',
      joined_at: '2026-01-01T00:00:00Z',
    });
    const forwarded: Array<{ lobbyId: string; playerId: string | null }> = [];
    const env = makeEnv(tables, forwarded);

    const resp = await handlePlayerLobbyJoin('bot-1', joinRequest('lobby-B'), env);
    expect(resp.status).toBe(200);
    expect(forwarded).toEqual([{ lobbyId: 'lobby-B', playerId: 'bot-1' }]);
    // session moves to the new lobby
    expect(tables.player_sessions.get('bot-1')?.lobby_id).toBe('lobby-B');
  });

  it('DISBANDED lobby session (phase = finished) → join to new lobby succeeds', async () => {
    // Second termination path: `lobbies.phase = 'finished'` (disband/fail).
    const tables = emptyTables();
    tables.players.set('alice', { handle: 'alice', elo: 1000 });
    tables.lobbies.set('lobby-A', {
      id: 'lobby-A',
      phase: 'finished',
      game_id: null,
    });
    tables.player_sessions.set('alice', {
      player_id: 'alice',
      lobby_id: 'lobby-A',
      joined_at: '2026-01-01T00:00:00Z',
    });
    const forwarded: Array<{ lobbyId: string; playerId: string | null }> = [];
    const env = makeEnv(tables, forwarded);

    const resp = await handlePlayerLobbyJoin('alice', joinRequest('lobby-B'), env);
    expect(resp.status).toBe(200);
    expect(forwarded).toEqual([{ lobbyId: 'lobby-B', playerId: 'alice' }]);
  });

  it('unfinished session in the SAME lobby → idempotent re-join allowed', async () => {
    const tables = emptyTables();
    tables.players.set('alice', { handle: 'alice', elo: 1000 });
    tables.lobbies.set('lobby-A', {
      id: 'lobby-A',
      phase: 'lobby',
      game_id: null,
    });
    tables.player_sessions.set('alice', {
      player_id: 'alice',
      lobby_id: 'lobby-A',
      joined_at: '2026-01-01T00:00:00Z',
    });
    const forwarded: Array<{ lobbyId: string; playerId: string | null }> = [];
    const env = makeEnv(tables, forwarded);

    const resp = await handlePlayerLobbyJoin('alice', joinRequest('lobby-A'), env);
    expect(resp.status).toBe(200);
    expect(forwarded).toEqual([{ lobbyId: 'lobby-A', playerId: 'alice' }]);
  });
});
