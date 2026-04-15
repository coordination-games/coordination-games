import { GameRoomDO } from './do/GameRoomDO.js';
import { LobbyDO } from './do/LobbyDO.js';
import { handleAuthChallenge, handleAuthVerify, validateBearerToken } from './auth.js';
import { D1EloTracker } from './db/elo.js';
import { getRegisteredGames, getGame } from '@coordination-games/engine';
import { createRelay } from './chain/index.js';
import type { Env } from './env.js';

// Re-export DO classes — required for Durable Object bindings to work
export { GameRoomDO, LobbyDO };

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

// ---------------------------------------------------------------------------
// Extracted helpers
// ---------------------------------------------------------------------------

/** Parse JSON body from a request, returning the parsed object or an error Response. */
async function parseJsonBody<T = any>(request: Request): Promise<T | Response> {
  try {
    return await request.json() as T;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

/** Validate bearer token and return playerId, or return a 401 Response. */
async function requireAuth(request: Request, env: Env): Promise<string | Response> {
  const playerId = await validateBearerToken(request, env);
  if (!playerId) {
    return Response.json(
      { error: 'auth_required', message: 'Missing or invalid Authorization: Bearer <token> header' },
      { status: 401 },
    );
  }
  return playerId;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const response = await handleRequest(request, env);
    // WebSocket upgrade responses (101) must be returned as-is —
    // wrapping them in new Response() strips the webSocket property.
    if (response.status === 101) return response;
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
      return Response.json({ ok: true, games: getRegisteredGames() });
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
    // Relay endpoints (public — no auth required)
    // ------------------------------------------------------------------
    const relay = createRelay(env);

    const relayStatusMatch = pathname.match(/^\/api\/relay\/status\/([^/]+)$/);
    if (relayStatusMatch && method === 'GET') {
      const address = decodeURIComponent(relayStatusMatch[1]);
      const agent = await relay.getAgentByAddress(address);
      return Response.json(agent ?? { registered: false });
    }

    const relayNameMatch = pathname.match(/^\/api\/relay\/check-name\/([^/]+)$/);
    if (relayNameMatch && method === 'GET') {
      const name = decodeURIComponent(relayNameMatch[1]);
      const result = await relay.checkName(name);
      return Response.json(result);
    }

    const relayBalanceMatch = pathname.match(/^\/api\/relay\/balance\/([^/]+)$/);
    if (relayBalanceMatch && method === 'GET') {
      const agentId = decodeURIComponent(relayBalanceMatch[1]);
      const result = await relay.getBalance(agentId);
      return Response.json(result);
    }

    // POST /api/relay/register
    const registerMatch = pathname === '/api/relay/register' && method === 'POST';
    if (registerMatch) {
      try {
        const body = await request.json() as any;
        const { name, address, agentURI, permitDeadline, v, r, s } = body;
        if (!name || !address || !agentURI) {
          return Response.json({ error: 'name, address, and agentURI are required' }, { status: 400 });
        }
        const result = await relay.register({ name, address, agentURI, permitDeadline, v, r, s });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/relay/topup
    if (pathname === '/api/relay/topup' && method === 'POST') {
      try {
        const body = await request.json() as any;
        const result = await relay.topup(body.agentId, {
          deadline: body.permitDeadline,
          v: body.v, r: body.r, s: body.s,
          amount: body.amount,
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/relay/burn-request
    if (pathname === '/api/relay/burn-request' && method === 'POST') {
      try {
        const body = await request.json() as any;
        const result = await relay.requestBurn(body.agentId, body.amount);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/relay/burn-execute
    if (pathname === '/api/relay/burn-execute' && method === 'POST') {
      try {
        const body = await request.json() as any;
        const result = await relay.executeBurn(body.agentId);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // POST /api/relay/burn-cancel
    if (pathname === '/api/relay/burn-cancel' && method === 'POST') {
      try {
        const body = await request.json() as any;
        await relay.cancelBurn(body.agentId);
        return Response.json({ ok: true });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // GET /api/relay/faucet/:address — testnet only, mints MockUSDC
    const faucetMatch = pathname.match(/^\/api\/relay\/faucet\/(.+)$/);
    if (faucetMatch && method === 'GET') {
      if (!env.RPC_URL || !env.USDC_ADDRESS || !env.RELAYER_PRIVATE_KEY) {
        return Response.json({ error: 'Faucet not available' }, { status: 503 });
      }
      try {
        const { createWalletClient, http } = await import('viem');
        const { privateKeyToAccount } = await import('viem/accounts');
        const { optimismSepolia } = await import('viem/chains');

        const address = decodeURIComponent(faucetMatch[1]);
        const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as `0x${string}`);
        const walletClient = createWalletClient({ account, chain: optimismSepolia, transport: http(env.RPC_URL) });

        const txHash = await walletClient.writeContract({
          address: env.USDC_ADDRESS as `0x${string}`,
          abi: [{ name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }] as const,
          functionName: 'mint',
          args: [address as `0x${string}`, 100_000_000n],
        } as any);

        return Response.json({ txHash, amount: '100000000' });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // ------------------------------------------------------------------
    // Framework info
    // ------------------------------------------------------------------
    if (pathname === '/api/framework' && method === 'GET') {
      return Response.json({ version: '0.1.0', games: getRegisteredGames(), status: 'active' });
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
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
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
    // Only allow unauthenticated access to spectator-safe paths
    const gameMatch = pathname.match(/^\/api\/games\/([^/]+)(\/.*)?$/);
    if (gameMatch) {
      const gameId = gameMatch[1];
      const sub = gameMatch[2] ?? '/spectator';

      // Spectator-safe paths (no auth required)
      const spectatorPaths = ['/spectator', '/replay'];
      if (spectatorPaths.includes(sub)) {
        return forwardToGameDO(env, gameId, sub, request);
      }

      // All other game sub-paths require auth
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      const playerId = auth;
      const forwarded = new Request(request.url, request);
      forwarded.headers.set('X-Player-Id', playerId);
      return forwardToGameDO(env, gameId, sub, forwarded);
    }

    // WS /ws/game/:id — unauthenticated spectator WebSocket (delayed view)
    const wsSpectatorMatch = pathname.match(/^\/ws\/game\/([^/]+)$/);
    if (wsSpectatorMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return forwardToGameDO(env, wsSpectatorMatch[1], '/', request);
    }

    // WS /ws/game/:id/player — authenticated player WebSocket (real-time fog-filtered)
    const wsPlayerMatch = pathname.match(/^\/ws\/game\/([^/]+)\/player$/);
    if (wsPlayerMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      const playerId = auth;
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

    if (pathname === '/api/player/leaderboard' && method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handleLeaderboard(request, env);
    }

    if (pathname === '/api/player/stats' && method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerStats(auth, env);
    }

if (pathname === '/api/player/state' && method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerState(auth, env);
    }

    // GET /api/player/wait — poll for state updates (CLI long-poll shim)
    if (pathname === '/api/player/wait' && method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerState(auth, env);
    }

    // POST /api/player/move — game actions (lobby actions go through /api/player/lobby/action)
    if (pathname === '/api/player/move' && method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerMove(auth, request, env);
    }

    // POST /api/player/lobby/join — join a lobby
    if (pathname === '/api/player/lobby/join' && method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerLobbyJoin(auth, request, env);
    }

    // POST /api/player/lobby/action — generic lobby phase action
    if (pathname === '/api/player/lobby/action' && method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerLobbyAction(auth, request, env);
    }

    // POST /api/player/lobby/tool — plugin tool call during lobby (chat, etc.)
    if (pathname === '/api/player/lobby/tool' && method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerLobbyTool(auth, request, env);
    }

    // POST /api/player/tool — plugin tool calls during game (chat, etc.)
    if (pathname === '/api/player/tool' && method === 'POST') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerTool(auth, request, env);
    }

    // GET /api/player/guide — game guide + available tools
    if (pathname === '/api/player/guide' && method === 'GET') {
      const auth = await requireAuth(request, env);
      if (auth instanceof Response) return auth;
      return handlePlayerGuide(auth, request, env);
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
    "SELECT l.id, l.game_type, l.team_size, l.phase, l.created_at, l.game_id, " +
    "COUNT(ls.player_id) as player_count " +
    "FROM lobbies l " +
    "LEFT JOIN lobby_sessions ls ON ls.lobby_id = l.id " +
    "WHERE l.phase NOT IN ('failed', 'game') " +
    "GROUP BY l.id " +
    "ORDER BY l.created_at DESC LIMIT 50"
  ).all<{ id: string; game_type: string; team_size: number; phase: string; created_at: string; game_id: string | null; player_count: number }>();

  return Response.json(rows.results.map(r => ({
    lobbyId: r.id,
    gameType: r.game_type,
    teamSize: r.team_size,
    phase: r.phase,
    createdAt: r.created_at,
    gameId: r.game_id,
    playerCount: r.player_count,
  })));
}

async function handleCreateLobby(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const gameType  = (body?.gameType as string) ?? 'capture-the-lobster';
  const noTimeout = !!body?.noTimeout;
  // Broad bounds — LobbyDO enforces per-game limits via plugin.lobby.matchmaking
  const teamSize  = Math.min(20, Math.max(1, Math.floor((body?.teamSize as number) ?? 2)));

  const lobbyId = crypto.randomUUID();

  // Write the discovery row to D1 first
  try {
    await env.DB.prepare(
      'INSERT INTO lobbies (id, game_type, team_size, phase, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(lobbyId, gameType, teamSize, 'running', new Date().toISOString()).run();
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
// Game management handlers
// ---------------------------------------------------------------------------

async function handleListGames(env: Env): Promise<Response> {
  await ensureGameSummariesTable(env);

  // Auto-cleanup: mark stale unfinished games with no summary as finished
  // (Games write a summary on creation; no summary = failed/orphaned)
  await env.DB.prepare(
    `UPDATE games SET finished = 1
     WHERE finished = 0
       AND game_id NOT IN (SELECT game_id FROM game_summaries)`
  ).run().catch(() => {});

  const rows = await env.DB.prepare(
    `SELECT g.game_id, g.game_type, g.finished,
            COUNT(s.player_id) AS player_count,
            gs.progress_counter, gs.summary_json
     FROM games g
     LEFT JOIN game_sessions s ON s.game_id = g.game_id
     LEFT JOIN game_summaries gs ON gs.game_id = g.game_id
     GROUP BY g.game_id
     ORDER BY g.finished ASC, g.created_at DESC
     LIMIT 50`
  ).all<{ game_id: string; game_type: string; finished: number; player_count: number; progress_counter: number | null; summary_json: string | null }>();

  return Response.json(rows.results.map(r => {
    const summary = r.summary_json ? JSON.parse(r.summary_json) : {};
    return {
      gameId: r.game_id,
      gameType: r.game_type,
      playerCount: r.player_count,
      finished: r.finished === 1,
      progressCounter: r.progress_counter ?? 0,
      ...summary,
    };
  }));
}

let _summariesTableReady = false;
async function ensureGameSummariesTable(env: Env): Promise<void> {
  if (_summariesTableReady) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS game_summaries (
        game_id TEXT PRIMARY KEY REFERENCES games(game_id),
        progress_counter INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')))`
    ).run();
    _summariesTableReady = true;
  } catch (err) {
    console.error('[Worker] Failed to ensure game_summaries table:', err);
  }
}

async function handleCreateGame(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

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
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  // Lobby action via /move (legacy compatibility) — forward to generic lobby action handler
  if (body?.action && typeof body.action === 'string') {
    const lobbySession = await getPlayerLobbySession(playerId, env);
    if (!lobbySession) {
      return Response.json({ error: 'Not in an active lobby' }, { status: 404 });
    }
    const lobbyId = lobbySession.lobby_id;
    // Map legacy action format to generic { playerId, type, payload }
    return forwardToLobbyDO(env, lobbyId, '/action', makeRequest('POST', {
      playerId,
      type: body.action,
      payload: body,
    }));
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
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

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

  // Clone the response so we can inspect it and still return it
  const joinBody = await joinResp.json() as any;

  // If the join immediately triggered a game start (e.g. OATHBREAKER reaching min players),
  // the lobby_sessions row was already deleted by LobbyDO. Don't re-insert it.
  if (joinBody?.phase !== 'game' && joinBody?.phase !== 'starting') {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO lobby_sessions (player_id, lobby_id, joined_at) VALUES (?, ?, ?)'
    ).bind(playerId, lobbyId, new Date().toISOString()).run();
  }

  return Response.json(joinBody, { status: joinResp.status });
}

/** Generic lobby phase action — forwards to LobbyDO POST /action */
async function handlePlayerLobbyAction(playerId: string, request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const lobbySession = await getPlayerLobbySession(playerId, env);
  if (!lobbySession) {
    return Response.json({ error: 'Not in an active lobby' }, { status: 404 });
  }

  const { type, payload } = body ?? {};
  if (!type) {
    return Response.json({ error: 'type is required' }, { status: 400 });
  }

  return forwardToLobbyDO(env, lobbySession.lobby_id, '/action', makeRequest('POST', {
    playerId,
    type,
    payload: payload ?? {},
  }));
}

/** Plugin tool call during lobby (chat, etc.) — forwards to LobbyDO POST /tool */
async function handlePlayerLobbyTool(playerId: string, request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const lobbySession = await getPlayerLobbySession(playerId, env);
  if (!lobbySession) {
    return Response.json({ error: 'Not in an active lobby' }, { status: 404 });
  }

  const { relay } = body ?? {};
  if (!relay?.type || !relay?.pluginId) {
    return Response.json({ error: 'Body must be { relay: { type, data, scope, pluginId } }' }, { status: 400 });
  }

  return forwardToLobbyDO(env, lobbySession.lobby_id, '/tool', makeRequest('POST', {
    playerId,
    relay,
  }));
}

async function handlePlayerTool(playerId: string, request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

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

// ---------------------------------------------------------------------------
// Guide handler
// ---------------------------------------------------------------------------

async function handlePlayerGuide(playerId: string, request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let gameType = url.searchParams.get('game');

  if (!gameType) {
    // Try active game session first
    const gameSession = await getPlayerGameSession(playerId, env);
    if (gameSession) {
      gameType = gameSession.game_type;
    } else {
      // Try lobby session — join to lobbies table to get game_type
      const lobbyRow = await env.DB.prepare(
        'SELECT l.game_type FROM lobby_sessions ls JOIN lobbies l ON l.id = ls.lobby_id WHERE ls.player_id = ?'
      ).bind(playerId).first<{ game_type: string }>();
      if (lobbyRow) gameType = lobbyRow.game_type;
    }
  }

  if (!gameType) {
    return Response.json({ games: getRegisteredGames() });
  }

  const plugin = getGame(gameType);
  if (!plugin) {
    return Response.json({ error: 'Unknown game', gameType }, { status: 404 });
  }

  const guide = plugin.guide ?? 'No guide available.';

  // Collect tool names from lobby phases and required/recommended plugins
  const tools: string[] = [];
  if (plugin.lobby?.phases) {
    for (const phase of plugin.lobby.phases) {
      if (phase.tools) {
        tools.push(...phase.tools.map((t: any) => t.name ?? t));
      }
    }
  }

  return Response.json({ gameType, guide, tools });
}

// ---------------------------------------------------------------------------
// Leaderboard / profile handlers
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
