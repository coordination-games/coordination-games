import { GameRoomDO } from './do/GameRoomDO.js';
import { LobbyDO } from './do/LobbyDO.js';
import { handleAuthChallenge, handleAuthVerify, validateBearerToken } from './auth.js';
import { D1EloTracker } from './db/elo.js';
import type { Env } from './env.js';

// Re-export DO classes — required for Durable Object bindings to work
export { GameRoomDO, LobbyDO };

const GIT_SHA = 'phase-6';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const response = await handleRequest(request, env);
    return withCors(response);
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
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
    // Lobby endpoints — /api/lobbies
    // ------------------------------------------------------------------

    if (pathname === '/api/lobbies' && method === 'GET') {
      return handleListLobbies(env);
    }

    if (pathname === '/api/lobbies/create' && method === 'POST') {
      return handleCreateLobby(request, env);
    }

    // /api/lobbies/:id[/subpath] — forward to LobbyDO
    const lobbyRestMatch = pathname.match(/^\/api\/lobbies\/([^/]+)(\/.*)?$/);
    if (lobbyRestMatch) {
      const lobbyId = lobbyRestMatch[1];
      // DELETE without subpath → disband ('/')
      // Everything else without subpath → state ('/state')
      const sub = lobbyRestMatch[2] ?? (method === 'DELETE' ? '/' : '/state');
      return forwardToLobbyDO(env, lobbyId, sub, request);
    }

    // WS /ws/lobby/:id — unauthenticated spectator WebSocket for lobby updates
    const wsLobbyMatch = pathname.match(/^\/ws\/lobby\/([^/]+)$/);
    if (wsLobbyMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return forwardToLobbyDO(env, wsLobbyMatch[1], '/', request);
    }

    // ------------------------------------------------------------------
    // Game endpoints — /api/games
    // ------------------------------------------------------------------

    if (pathname === '/api/games' && method === 'GET') {
      return handleListGames(env);
    }

    if (pathname === '/api/games/create' && method === 'POST') {
      return handleCreateGame(request, env);
    }

    // /api/games/:id[/subpath] — forward to GameRoomDO
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

    // WS /ws/game/:id/player — authenticated player WebSocket (real-time fog-filtered)
    const wsPlayerMatch = pathname.match(/^\/ws\/game\/([^/]+)\/player$/);
    if (wsPlayerMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      const session = await getPlayerGameSession(playerId, env);
      if (!session || session.game_id !== wsPlayerMatch[1]) {
        return Response.json({ error: 'Not a player in this game' }, { status: 403 });
      }
      const forwarded = new Request(request.url, request);
      forwarded.headers.delete('Authorization');
      forwarded.headers.set('X-Player-Id', playerId);
      return forwardToGameDO(env, wsPlayerMatch[1], '/', forwarded);
    }

    // ------------------------------------------------------------------
    // Authenticated player endpoints
    // ------------------------------------------------------------------

    if (pathname === '/api/player/stats' && method === 'GET') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerStats(playerId, env);
    }

    if (pathname === '/api/player/guide' && method === 'GET') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerGuide(playerId, url, env);
    }

    if (pathname === '/api/player/state' && method === 'GET') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerState(playerId, env);
    }

    // POST /api/player/move — game actions AND lobby actions (propose-team, choose-class, etc.)
    if (pathname === '/api/player/move' && method === 'POST') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerMove(playerId, request, env);
    }

    // POST /api/player/lobby/join — join a lobby
    if (pathname === '/api/player/lobby/join' && method === 'POST') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerLobbyJoin(playerId, request, env);
    }

    // POST /api/player/tool — plugin tool calls (chat, etc.)
    if (pathname === '/api/player/tool' && method === 'POST') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerTool(playerId, request, env);
    }

    // Dedicated lobby action shortcuts (same as via /move but explicit endpoints)
    if (pathname === '/api/player/team/propose' && method === 'POST') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerLobbyActionDedicated(playerId, 'propose-team', request, env);
    }
    if (pathname === '/api/player/team/accept' && method === 'POST') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerLobbyActionDedicated(playerId, 'accept-team', request, env);
    }
    if (pathname === '/api/player/team/leave' && method === 'POST') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerLobbyActionDedicated(playerId, 'leave-team', request, env);
    }
    if (pathname === '/api/player/class' && method === 'POST') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerLobbyActionDedicated(playerId, 'choose-class', request, env);
    }

    // ------------------------------------------------------------------
    // Not found
    // ------------------------------------------------------------------
    return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------------------
// Lobby management handlers
// ---------------------------------------------------------------------------

async function handleListLobbies(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, game_type, team_size, phase, created_at, game_id FROM lobbies " +
    "WHERE phase NOT IN ('failed', 'game') ORDER BY created_at DESC LIMIT 50"
  ).all<{ id: string; game_type: string; team_size: number; phase: string; created_at: string; game_id: string | null }>();

  return Response.json(rows.results.map(r => ({
    lobbyId: r.id,
    gameType: r.game_type,
    teamSize: r.team_size,
    phase: r.phase,
    createdAt: r.created_at,
    gameId: r.game_id,
  })));
}

async function handleCreateLobby(request: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const gameType  = (body?.gameType as string) ?? 'capture-the-lobster';
  const teamSize  = Math.min(6, Math.max(2, Math.floor((body?.teamSize as number) ?? 2)));
  const noTimeout = !!body?.noTimeout;

  const lobbyId = crypto.randomUUID();

  // Write the discovery row to D1 first
  try {
    await env.DB.prepare(
      'INSERT INTO lobbies (id, game_type, team_size, phase, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(lobbyId, gameType, teamSize, 'forming', new Date().toISOString()).run();
  } catch (err) {
    return Response.json({ error: 'Failed to create lobby record' }, { status: 500 });
  }

  // Create LobbyDO
  const doStub = getLobbyDO(env, lobbyId);
  const createResp = await doStub.fetch(new Request('https://do/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId, gameType, teamSize, noTimeout }),
  }));

  if (!createResp.ok) {
    // Roll back D1 row
    await env.DB.prepare('DELETE FROM lobbies WHERE id = ?').bind(lobbyId).run().catch(() => {});
    const err = await createResp.json() as any;
    return Response.json({ error: err.error ?? 'Lobby creation failed' }, { status: createResp.status });
  }

  console.log(`[Worker] Created ${gameType} lobby ${lobbyId} (teamSize=${teamSize})`);
  return Response.json({ lobbyId, gameType, teamSize }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Game management handlers (Phase 3, preserved)
// ---------------------------------------------------------------------------

async function handleListGames(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT g.game_id, g.game_type, COUNT(s.player_id) AS player_count
     FROM games g
     LEFT JOIN game_sessions s ON s.game_id = g.game_id
     WHERE g.finished = 0
     GROUP BY g.game_id
     ORDER BY g.created_at DESC
     LIMIT 50`
  ).all<{ game_id: string; game_type: string; player_count: number }>();

  return Response.json(rows.results.map(r => ({
    gameId: r.game_id,
    gameType: r.game_type,
    playerCount: r.player_count,
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

  const doStub = getGameDO(env, gameId);
  const createResp = await doStub.fetch(new Request('https://do/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gameId, gameType, config, playerIds, handleMap: handleMap ?? {}, teamMap: teamMap ?? {} }),
  }));

  if (!createResp.ok) {
    const err = await createResp.json() as any;
    return Response.json({ error: err.error ?? 'Game creation failed' }, { status: createResp.status });
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR REPLACE INTO games (game_id, game_type, finished, created_at) VALUES (?, ?, 0, ?)'
    ).bind(gameId, gameType, now),
    ...((playerIds as string[]).map(pid =>
      env.DB.prepare(
        'INSERT OR REPLACE INTO game_sessions (player_id, game_id, game_type, joined_at) VALUES (?, ?, ?, ?)'
      ).bind(pid, gameId, gameType, now)
    )),
  ]);

  console.log(`[Worker] Created ${gameType} game ${gameId} for ${playerIds.length} players`);
  return Response.json({ gameId, gameType, playerCount: playerIds.length }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Player-scoped handlers (auth required)
// ---------------------------------------------------------------------------

async function handlePlayerGuide(playerId: string, url: URL, env: Env): Promise<Response> {
  const gameType = url.searchParams.get('game') ?? 'capture-the-lobster';
  return Response.json({ guide: `# ${gameType}\nGame guide coming in Phase 5.` });
}

async function handlePlayerState(playerId: string, env: Env): Promise<Response> {
  // Active game takes priority
  const gameSession = await getPlayerGameSession(playerId, env);
  if (gameSession) {
    const doStub = getGameDO(env, gameSession.game_id);
    return doStub.fetch(new Request(
      `https://do/state?playerId=${encodeURIComponent(playerId)}`,
      { method: 'GET' },
    ));
  }

  // Lobby session
  const lobbySession = await getPlayerLobbySession(playerId, env);
  if (lobbySession) {
    const doStub = getLobbyDO(env, lobbySession.lobby_id);
    return doStub.fetch(new Request(
      `https://do/state?playerId=${encodeURIComponent(playerId)}`,
      { method: 'GET' },
    ));
  }

  return Response.json({ error: 'No active lobby or game. Join a lobby first.' }, { status: 404 });
}

async function handlePlayerMove(playerId: string, request: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  // Lobby action: body has an `action` string field (not `type`)
  if (body?.action && typeof body.action === 'string') {
    return dispatchLobbyAction(playerId, body, env);
  }

  // Game action: forward to GameRoomDO
  const session = await getPlayerGameSession(playerId, env);
  if (!session) {
    return Response.json({ error: 'Not in an active game' }, { status: 404 });
  }
  const doStub = getGameDO(env, session.game_id);
  return doStub.fetch(new Request('https://do/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, action: body }),
  }));
}

async function handlePlayerLobbyJoin(playerId: string, request: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const lobbyId = body?.lobbyId ?? body?.gameId;
  if (!lobbyId) return Response.json({ error: 'lobbyId is required' }, { status: 400 });

  // Fetch handle + ELO from D1 players table
  const player = await env.DB.prepare(
    'SELECT handle, elo FROM players WHERE id = ?'
  ).bind(playerId).first<{ handle: string; elo: number }>();
  const handle = player?.handle ?? playerId;
  const elo    = player?.elo    ?? 1000;

  // Forward join to LobbyDO
  const doStub = getLobbyDO(env, lobbyId);
  const joinResp = await doStub.fetch(new Request('https://do/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, handle, elo }),
  }));

  if (!joinResp.ok) return joinResp;

  // Write lobby_sessions row to D1 (INSERT OR REPLACE handles re-joins)
  await env.DB.prepare(
    'INSERT OR REPLACE INTO lobby_sessions (player_id, lobby_id, joined_at) VALUES (?, ?, ?)'
  ).bind(playerId, lobbyId, new Date().toISOString()).run();

  return joinResp;
}

// Dedicated endpoints for team/class actions (same logic as through /move)
async function handlePlayerLobbyActionDedicated(
  playerId: string,
  action: string,
  request: Request,
  env: Env,
): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch { body = {}; }

  return dispatchLobbyAction(playerId, { action, ...body }, env);
}

async function handlePlayerTool(playerId: string, request: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  // Body is { relay: { type, data, scope, pluginId } } — produced by the CLI
  // calling plugin.handleCall() locally. We just store and route it.
  const { relay } = body ?? {};
  if (!relay?.type || !relay?.pluginId) {
    return Response.json({ error: 'Body must be { relay: { type, data, scope, pluginId } }' }, { status: 400 });
  }

  const session = await getPlayerGameSession(playerId, env);
  if (!session) {
    return Response.json({ error: 'Not in an active game' }, { status: 404 });
  }

  return forwardToGameDO(env, session.game_id, '/tool', makeRequest('POST', { relay, playerId }));
}

// Common dispatch for lobby actions coming from either /move or dedicated endpoints
async function dispatchLobbyAction(playerId: string, body: any, env: Env): Promise<Response> {
  const lobbySession = await getPlayerLobbySession(playerId, env);
  if (!lobbySession) {
    return Response.json({ error: 'Not in an active lobby' }, { status: 404 });
  }
  const lobbyId = lobbySession.lobby_id;

  const { action, target } = body;
  const unitClass = body.class ?? body.unitClass;

  switch (action) {
    case 'propose-team': {
      if (!target) return Response.json({ error: 'propose-team requires "target" (agentId or handle)' }, { status: 400 });
      return forwardToLobbyDO(env, lobbyId, '/team/propose', makeRequest('POST', { fromId: playerId, toId: target }));
    }
    case 'accept-team': {
      if (!target) return Response.json({ error: 'accept-team requires "target" (teamId)' }, { status: 400 });
      return forwardToLobbyDO(env, lobbyId, '/team/accept', makeRequest('POST', { agentId: playerId, teamId: target }));
    }
    case 'leave-team': {
      return forwardToLobbyDO(env, lobbyId, '/team/leave', makeRequest('POST', { agentId: playerId }));
    }
    case 'choose-class': {
      const cls = unitClass ?? target;
      if (!cls) return Response.json({ error: 'choose-class requires "class" (rogue, knight, or mage)' }, { status: 400 });
      return forwardToLobbyDO(env, lobbyId, '/class', makeRequest('POST', { agentId: playerId, unitClass: cls }));
    }
    default:
      return Response.json({
        error: `Unknown lobby action "${action}". Valid: propose-team, accept-team, leave-team, choose-class`,
      }, { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Leaderboard / profile handlers (Phase 2, preserved)
// ---------------------------------------------------------------------------

async function handleLeaderboard(request: Request, env: Env): Promise<Response> {
  const url     = new URL(request.url);
  const limit   = Math.min(parseInt(url.searchParams.get('limit')  ?? '50', 10), 200);
  const offset  = Math.max(parseInt(url.searchParams.get('offset') ?? '0',  10), 0);
  const tracker = D1EloTracker.fromEnv(env);
  const players = await tracker.getLeaderboard(limit, offset);
  return Response.json(players);
}

async function handleProfile(handle: string, env: Env): Promise<Response> {
  const tracker = D1EloTracker.fromEnv(env);
  const player  = await tracker.getPlayerByHandle(decodeURIComponent(handle));
  if (!player) return Response.json({ error: 'Player not found' }, { status: 404 });
  const { walletAddress: _omit, ...publicProfile } = player;
  return Response.json(publicProfile);
}

async function handlePlayerStats(playerId: string, env: Env): Promise<Response> {
  const tracker = D1EloTracker.fromEnv(env);
  const player  = await tracker.getPlayer(playerId);
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

function getLobbyDO(env: Env, lobbyId: string): DurableObjectStub {
  return env.LOBBY.get(env.LOBBY.idFromName(lobbyId));
}

async function getPlayerGameSession(
  playerId: string,
  env: Env,
): Promise<{ game_id: string; game_type: string } | null> {
  return env.DB.prepare(
    'SELECT game_id, game_type FROM game_sessions WHERE player_id = ?'
  ).bind(playerId).first<{ game_id: string; game_type: string }>();
}

async function getPlayerLobbySession(
  playerId: string,
  env: Env,
): Promise<{ lobby_id: string } | null> {
  return env.DB.prepare(
    'SELECT lobby_id FROM lobby_sessions WHERE player_id = ?'
  ).bind(playerId).first<{ lobby_id: string }>();
}

function forwardToGameDO(env: Env, gameId: string, subPath: string, request: Request): Promise<Response> {
  const stub = getGameDO(env, gameId);
  const url = new URL(request.url);
  url.pathname = subPath;
  return stub.fetch(new Request(url.toString(), request));
}

function forwardToLobbyDO(env: Env, lobbyId: string, subPath: string, request: Request): Promise<Response> {
  const stub = getLobbyDO(env, lobbyId);
  const url = new URL(request.url);
  url.pathname = subPath;
  return stub.fetch(new Request(url.toString(), request));
}

/** Build a simple POST Request with a JSON body to forward to a DO. */
function makeRequest(method: string, body: unknown): Request {
  return new Request('https://do/', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function authRequired(): Response {
  return Response.json(
    { error: 'auth_required', message: 'Missing or invalid Authorization: Bearer <token> header' },
    { status: 401 },
  );
}
