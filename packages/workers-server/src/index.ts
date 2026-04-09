import { GameRoomDO } from './do/GameRoomDO.js';
import { LobbyDO } from './do/LobbyDO.js';
import { handleAuthChallenge, handleAuthVerify, validateBearerToken } from './auth.js';
import { D1EloTracker } from './db/elo.js';
import type { Env } from './env.js';

// Re-export DO classes — required for Durable Object bindings to work
export { GameRoomDO, LobbyDO };

const GIT_SHA = 'e5e2ebd';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const { pathname } = url;

    // ------------------------------------------------------------------
    // Health / root
    // ------------------------------------------------------------------
    if (pathname === '/health') {
      return Response.json({ ok: true, build: GIT_SHA });
    }

    if (pathname === '/') {
      return Response.redirect(new URL('/health', request.url).toString(), 302);
    }

    // ------------------------------------------------------------------
    // Auth (public — no Bearer required)
    // ------------------------------------------------------------------
    if (pathname === '/api/player/auth/challenge' && method === 'POST') {
      return handleAuthChallenge(request, env);
    }

    if (pathname === '/api/player/auth/verify' && method === 'POST') {
      return handleAuthVerify(request, env);
    }

    // ------------------------------------------------------------------
    // Framework info
    // ------------------------------------------------------------------
    if (pathname === '/api/framework' && method === 'GET') {
      return Response.json({ version: '0.1.0', games: ['capture-the-lobster', 'oathbreaker'], status: 'active' });
    }

    // ------------------------------------------------------------------
    // Public leaderboard / profile
    // ------------------------------------------------------------------
    if (pathname === '/api/leaderboard' && method === 'GET') {
      return handleLeaderboard(request, env);
    }

    const profileMatch = pathname.match(/^\/api\/profile\/([^/]+)$/);
    if (profileMatch && method === 'GET') {
      return handleProfile(profileMatch[1], env);
    }

    // ------------------------------------------------------------------
    // Game endpoints — /api/games
    // ------------------------------------------------------------------

    // GET /api/games — list active games from D1 game_sessions
    if (pathname === '/api/games' && method === 'GET') {
      return handleListGames(env);
    }

    // POST /api/games/create — create a game directly (Phase 3, no lobby required)
    // Body: { gameType, config, playerIds, handleMap?, teamMap? }
    if (pathname === '/api/games/create' && method === 'POST') {
      return handleCreateGame(request, env);
    }

    // /api/games/:id[/subpath] — forward to GameRoomDO
    // GET → spectator/state/result, POST → action (used directly for Phase 3 testing)
    const gameMatch = pathname.match(/^\/api\/games\/([^/]+)(\/.*)?$/);
    if (gameMatch) {
      const gameId = gameMatch[1];
      const sub = gameMatch[2] ?? '/spectator';
      return forwardToGameDO(env, gameId, sub, request);
    }

    // WS /ws/game/:id — unauthenticated spectator WebSocket (delayed view)
    const wsSpectatorMatch = pathname.match(/^\/ws\/game\/([^/]+)$/);
    if (wsSpectatorMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return forwardToGameDO(env, wsSpectatorMatch[1], '/', request);
    }

    // WS /ws/game/:id/player — authenticated player WebSocket (real-time fog-filtered view)
    // Worker validates the Bearer token here and passes playerId via X-Player-Id header.
    // The DO never sees raw tokens.
    const wsPlayerMatch = pathname.match(/^\/ws\/game\/([^/]+)\/player$/);
    if (wsPlayerMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      const session = await getPlayerGameSession(playerId, env);
      if (!session || session.game_id !== wsPlayerMatch[1]) {
        return Response.json({ error: 'Not a player in this game' }, { status: 403 });
      }
      // Strip Authorization, add trusted X-Player-Id for the DO
      const forwarded = new Request(request.url, request);
      forwarded.headers.delete('Authorization');
      forwarded.headers.set('X-Player-Id', playerId);
      return forwardToGameDO(env, wsPlayerMatch[1], '/', forwarded);
    }

    // ------------------------------------------------------------------
    // Authenticated player endpoints
    // ------------------------------------------------------------------

    // GET /api/player/stats
    if (pathname === '/api/player/stats' && method === 'GET') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerStats(playerId, env);
    }

    // GET /api/player/guide
    if (pathname === '/api/player/guide' && method === 'GET') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerGuide(playerId, url, env);
    }

    // GET /api/player/state
    if (pathname === '/api/player/state' && method === 'GET') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerState(playerId, env);
    }

    // POST /api/player/move
    if (pathname === '/api/player/move' && method === 'POST') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerMove(playerId, request, env);
    }

    // ------------------------------------------------------------------
    // Not found
    // ------------------------------------------------------------------
    return new Response('Not found', { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Game management handlers
// ---------------------------------------------------------------------------

async function handleListGames(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    'SELECT game_id, game_type, GROUP_CONCAT(player_id) AS player_ids FROM game_sessions GROUP BY game_id'
  ).all<{ game_id: string; game_type: string; player_ids: string }>();

  return Response.json(rows.results.map(r => ({
    gameId: r.game_id,
    gameType: r.game_type,
    playerCount: r.player_ids.split(',').length,
  })));
}

async function handleCreateGame(request: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const { gameType, config, playerIds, handleMap, teamMap } = body ?? {};
  if (!gameType || !config || !Array.isArray(playerIds) || playerIds.length === 0) {
    return Response.json({ error: 'gameType, config, and playerIds[] are required' }, { status: 400 });
  }

  const gameId = crypto.randomUUID();

  // Create game in the GameRoomDO
  const doStub = getGameDO(env, gameId);
  const createResp = await doStub.fetch(new Request('https://do/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameType, config, playerIds, handleMap: handleMap ?? {}, teamMap: teamMap ?? {} }),
  }));

  if (!createResp.ok) {
    const err = await createResp.json() as any;
    return Response.json({ error: err.error ?? 'Game creation failed' }, { status: createResp.status });
  }

  // Store player → game mapping in D1
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    'INSERT OR REPLACE INTO game_sessions (player_id, game_id, game_type, joined_at) VALUES (?, ?, ?, ?)'
  );
  await env.DB.batch(
    (playerIds as string[]).map(pid => stmt.bind(pid, gameId, gameType, now))
  );

  console.log(`[Worker] Created ${gameType} game ${gameId} for ${playerIds.length} players`);

  return Response.json({ gameId, gameType, playerCount: playerIds.length }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Player-scoped handlers (auth required)
// ---------------------------------------------------------------------------

async function handlePlayerGuide(playerId: string, url: URL, env: Env): Promise<Response> {
  const gameType = url.searchParams.get('game') ?? 'capture-the-lobster';
  // For now return a minimal guide; Phase 5 will wire up plugin.guide
  return Response.json({ guide: `# ${gameType}\nGame guide coming in Phase 5.` });
}

async function handlePlayerState(playerId: string, env: Env): Promise<Response> {
  const session = await getPlayerGameSession(playerId, env);
  if (!session) {
    return Response.json({ error: 'No active lobby or game. Join a lobby first.' }, { status: 404 });
  }

  const doStub = getGameDO(env, session.game_id);
  return doStub.fetch(new Request(
    `https://do/state?playerId=${encodeURIComponent(playerId)}`,
    { method: 'GET' },
  ));
}

async function handlePlayerMove(playerId: string, request: Request, env: Env): Promise<Response> {
  const session = await getPlayerGameSession(playerId, env);
  if (!session) {
    return Response.json({ error: 'Not in an active game' }, { status: 404 });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const doStub = getGameDO(env, session.game_id);
  return doStub.fetch(new Request('https://do/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, action: body }),
  }));
}

// ---------------------------------------------------------------------------
// Leaderboard / profile handlers (Phase 2, preserved)
// ---------------------------------------------------------------------------

async function handleLeaderboard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  ?? '50', 10), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0',  10), 0);
  const tracker = D1EloTracker.fromEnv(env);
  const players = await tracker.getLeaderboard(limit, offset);
  return Response.json(players);
}

async function handleProfile(handle: string, env: Env): Promise<Response> {
  const tracker = D1EloTracker.fromEnv(env);
  const player = await tracker.getPlayerByHandle(decodeURIComponent(handle));
  if (!player) return Response.json({ error: 'Player not found' }, { status: 404 });
  const { walletAddress: _omit, ...publicProfile } = player;
  return Response.json(publicProfile);
}

async function handlePlayerStats(playerId: string, env: Env): Promise<Response> {
  const tracker = D1EloTracker.fromEnv(env);
  const player = await tracker.getPlayer(playerId);
  if (!player) return Response.json({ error: 'Player not found' }, { status: 404 });
  const matches = await tracker.getPlayerMatches(playerId, 20);
  const { walletAddress: _omit, ...stats } = player;
  return Response.json({ ...stats, recentMatches: matches });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGameDO(env: Env, gameId: string): DurableObjectStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
}

async function getPlayerGameSession(
  playerId: string,
  env: Env,
): Promise<{ game_id: string; game_type: string } | null> {
  return env.DB.prepare(
    'SELECT game_id, game_type FROM game_sessions WHERE player_id = ?'
  ).bind(playerId).first<{ game_id: string; game_type: string }>();
}

function forwardToGameDO(env: Env, gameId: string, subPath: string, request: Request): Promise<Response> {
  const stub = getGameDO(env, gameId);
  const url = new URL(request.url);
  url.pathname = subPath;
  return stub.fetch(new Request(url.toString(), request));
}

function authRequired(): Response {
  return Response.json(
    { error: 'auth_required', message: 'Missing or invalid Authorization: Bearer <token> header' },
    { status: 401 },
  );
}
