import { GameRoomDO } from './do/GameRoomDO.js';
import { LobbyDO } from './do/LobbyDO.js';
import { handleAuthChallenge, handleAuthVerify, validateBearerToken } from './auth.js';
import { D1EloTracker } from './db/elo.js';
import type { Env } from './env.js';

// Re-export DO classes — required for Durable Object bindings to work
export { GameRoomDO, LobbyDO };

const GIT_SHA = '521587b';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname, method } = Object.assign(url, { method: request.method });

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
    // Public read endpoints
    // ------------------------------------------------------------------

    // GET /api/leaderboard
    if (pathname === '/api/leaderboard' && method === 'GET') {
      return handleLeaderboard(request, env);
    }

    // GET /api/profile/:handle  (no auth required — public profiles)
    const profileMatch = pathname.match(/^\/api\/profile\/([^/]+)$/);
    if (profileMatch && method === 'GET') {
      return handleProfile(profileMatch[1], env);
    }

    // ------------------------------------------------------------------
    // Authenticated endpoints
    // ------------------------------------------------------------------

    // GET /api/player/stats — own stats
    if (pathname === '/api/player/stats' && method === 'GET') {
      const playerId = await validateBearerToken(request, env);
      if (!playerId) return authRequired();
      return handlePlayerStats(playerId, env);
    }

    // ------------------------------------------------------------------
    // Not found
    // ------------------------------------------------------------------
    return new Response('Not found', { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Route handlers
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
  if (!player) {
    return Response.json({ error: 'Player not found' }, { status: 404 });
  }
  // Omit wallet_address from public profile
  const { walletAddress: _omit, ...publicProfile } = player;
  return Response.json(publicProfile);
}

async function handlePlayerStats(playerId: string, env: Env): Promise<Response> {
  const tracker = D1EloTracker.fromEnv(env);
  const player = await tracker.getPlayer(playerId);
  if (!player) {
    return Response.json({ error: 'Player not found' }, { status: 404 });
  }
  const matches = await tracker.getPlayerMatches(playerId, 20);
  const { walletAddress: _omit, ...stats } = player;
  return Response.json({ ...stats, recentMatches: matches });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authRequired(): Response {
  return Response.json(
    { error: 'auth_required', message: 'Missing or invalid Authorization: Bearer <token> header' },
    { status: 401 },
  );
}
