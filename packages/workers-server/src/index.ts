import { getGame, getRegisteredGames } from '@coordination-games/engine';
import { handleAuthChallenge, handleAuthVerify, validateBearerToken } from './auth.js';
import { createRelay } from './chain/index.js';
import { GameRoomDO } from './do/GameRoomDO.js';
import { LobbyDO } from './do/LobbyDO.js';
import type { Env } from './env.js';
import {
  handlePluginCall,
  PluginEndpointBadRequestError,
  PluginEndpointNotFoundError,
  PluginEndpointUnauthorizedError,
} from './plugin-endpoint.js';
import { dispatchToolCall, handleAdminSessionTools } from './tool-dispatcher.js';

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
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Extracted helpers
// ---------------------------------------------------------------------------

/** Parse JSON body from a request, returning the parsed object or an error Response. */
// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
async function parseJsonBody<T = any>(request: Request): Promise<T | Response> {
  try {
    return (await request.json()) as T;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
}

/** Validate bearer token and return playerId, or return a 401 Response. */
async function requireAuth(request: Request, env: Env): Promise<string | Response> {
  const playerId = await validateBearerToken(request, env);
  if (!playerId) {
    return Response.json(
      {
        error: 'auth_required',
        message: 'Missing or invalid Authorization: Bearer <token> header',
      },
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
    try {
      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      const address = decodeURIComponent(relayStatusMatch[1]);
      const agent = await relay.getAgentByAddress(address);
      return Response.json(agent ?? { registered: false });
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      console.error('[relay/status] Error:', err);
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  const relayNameMatch = pathname.match(/^\/api\/relay\/check-name\/([^/]+)$/);
  if (relayNameMatch && method === 'GET') {
    try {
      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      const name = decodeURIComponent(relayNameMatch[1]);
      const result = await relay.checkName(name);
      return Response.json(result);
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      console.error('[relay/check-name] Error:', err);
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  const relayBalanceMatch = pathname.match(/^\/api\/relay\/balance\/([^/]+)$/);
  if (relayBalanceMatch && method === 'GET') {
    try {
      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      const agentId = decodeURIComponent(relayBalanceMatch[1]);
      const result = await relay.getBalance(agentId);
      return Response.json(result);
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      console.error('[relay/balance] Error:', err);
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // POST /api/relay/register
  const registerMatch = pathname === '/api/relay/register' && method === 'POST';
  if (registerMatch) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      const body = (await request.json()) as any;
      const { name, address, agentURI, permitDeadline, v, r, s } = body;
      if (!name || !address || !agentURI) {
        return Response.json(
          { error: 'name, address, and agentURI are required' },
          { status: 400 },
        );
      }
      const result = await relay.register({ name, address, agentURI, permitDeadline, v, r, s });
      return Response.json(result);
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // POST /api/relay/topup
  if (pathname === '/api/relay/topup' && method === 'POST') {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      const body = (await request.json()) as any;
      const result = await relay.topup(body.agentId, {
        deadline: body.permitDeadline,
        v: body.v,
        r: body.r,
        s: body.s,
        amount: body.amount,
      });
      return Response.json(result);
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // POST /api/relay/burn-request
  if (pathname === '/api/relay/burn-request' && method === 'POST') {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      const body = (await request.json()) as any;
      const result = await relay.requestBurn(body.agentId, body.amount);
      return Response.json(result);
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // POST /api/relay/burn-execute
  if (pathname === '/api/relay/burn-execute' && method === 'POST') {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      const body = (await request.json()) as any;
      const result = await relay.executeBurn(body.agentId);
      return Response.json(result);
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // POST /api/relay/burn-cancel
  if (pathname === '/api/relay/burn-cancel' && method === 'POST') {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      const body = (await request.json()) as any;
      await relay.cancelBurn(body.agentId);
      return Response.json({ ok: true });
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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

      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      const address = decodeURIComponent(faucetMatch[1]);
      const account = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: optimismSepolia,
        transport: http(env.RPC_URL),
      });

      const txHash = await walletClient.writeContract({
        address: env.USDC_ADDRESS as `0x${string}`,
        abi: [
          {
            name: 'mint',
            type: 'function',
            stateMutability: 'nonpayable',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [],
          },
        ] as const,
        functionName: 'mint',
        args: [address as `0x${string}`, 100_000_000n],
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      } as any);

      return Response.json({ txHash, amount: '100000000' });
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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
  // Generic plugin-call endpoint
  //
  // POST /api/plugin/:pluginId/call  body: { name, args }
  //
  // Single entry point for every server-plugin handleCall (Phase 5.2 — ELO
  // is the first user; settlement migrates to the same shape in 5.3).
  // Identity comes from the optional `Authorization: Bearer <token>` header
  // (validated → playerId), exactly the same way every other authenticated
  // route works. Unauthenticated callers reach the plugin as
  // `{ kind: 'spectator' }`; plugins gate sensitive calls themselves.
  // ------------------------------------------------------------------
  const pluginCallMatch = pathname.match(/^\/api\/plugin\/([^/]+)\/call$/);
  if (pluginCallMatch && method === 'POST') {
    // biome-ignore lint/style/noNonNullAssertion: regex group always present when match() returns
    const pluginId = pluginCallMatch[1]!;
    // Optional auth — leaderboard is public, my-stats requires playerId.
    const playerId = await validateBearerToken(request, env);
    try {
      const body = await parseJsonBody<{ name?: string; args?: unknown }>(request);
      if (body instanceof Response) return body;
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name) {
        return Response.json(
          { error: 'plugin call body must include `name` (string)' },
          { status: 400 },
        );
      }
      const result = await handlePluginCall(env, pluginId, name, body.args ?? {}, playerId);
      return Response.json(result);
    } catch (err) {
      if (err instanceof PluginEndpointNotFoundError) {
        return Response.json({ error: err.message }, { status: 404 });
      }
      if (err instanceof PluginEndpointBadRequestError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof PluginEndpointUnauthorizedError) {
        return Response.json({ error: err.message }, { status: 401 });
      }
      console.error(`[plugin-call] ${pluginId}.${(err as Error)?.message ?? err}`);
      return Response.json(
        { error: (err as Error)?.message ?? 'plugin call failed' },
        { status: 500 },
      );
    }
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

  // /api/lobbies/:id[/subpath] — forward to LobbyDO.
  // GET /state is public (spectator view). Every other sub-path requires
  // Bearer auth; the Worker forwards identity in X-Player-Id.
  const lobbyRestMatch = pathname.match(/^\/api\/lobbies\/([^/]+)(\/.*)?$/);
  if (lobbyRestMatch) {
    const lobbyId = lobbyRestMatch[1];
    const sub = lobbyRestMatch[2] ?? (method === 'DELETE' ? '/' : '/state');

    const publicPaths = new Set(['/state']);
    if (method === 'GET' && publicPaths.has(sub)) {
      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      return forwardToLobbyDO(env, lobbyId, sub, request);
    }

    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;
    const playerId = auth;
    // Strip attacker-controlled playerId query param before forwarding.
    const sanitisedUrl = new URL(request.url);
    sanitisedUrl.searchParams.delete('playerId');
    const forwarded = new Request(sanitisedUrl.toString(), request);
    forwarded.headers.set('X-Player-Id', playerId);
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    return forwardToLobbyDO(env, lobbyId, sub, forwarded);
  }

  // WS /ws/lobby/:id — unauthenticated spectator WebSocket for lobby updates
  const wsLobbyMatch = pathname.match(/^\/ws\/lobby\/([^/]+)$/);
  if (wsLobbyMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
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
    const spectatorPaths = ['/spectator', '/replay', '/bundle'];
    if (spectatorPaths.includes(sub)) {
      // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
      return forwardToGameDO(env, gameId, sub, request);
    }

    // All other game sub-paths require auth
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;
    const playerId = auth;
    // Strip the playerId query param — the DO trusts only X-Player-Id.
    const sanitisedUrl = new URL(request.url);
    sanitisedUrl.searchParams.delete('playerId');
    const forwarded = new Request(sanitisedUrl.toString(), request);
    forwarded.headers.set('X-Player-Id', playerId);
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    return forwardToGameDO(env, gameId, sub, forwarded);
  }

  // WS /ws/game/:id — unauthenticated spectator WebSocket (delayed view)
  const wsSpectatorMatch = pathname.match(/^\/ws\/game\/([^/]+)$/);
  if (wsSpectatorMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    return forwardToGameDO(env, wsSpectatorMatch[1], '/', request);
  }

  // WS /ws/game/:id/player — authenticated player WebSocket (real-time fog-filtered)
  const wsPlayerMatch = pathname.match(/^\/ws\/game\/([^/]+)\/player$/);
  if (wsPlayerMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;
    const playerId = auth;
    const location = await getPlayerLocation(playerId, env);
    if (location?.kind !== 'game' || location.gameId !== wsPlayerMatch[1]) {
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

  // POST /api/player/lobby/join — join a lobby
  if (pathname === '/api/player/lobby/join' && method === 'POST') {
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;
    return handlePlayerLobbyJoin(auth, request, env);
  }

  // POST /api/player/tool — UNIFIED tool-call endpoint.
  // Replaces /api/player/move, /api/player/lobby/action, and the pre-refactor
  // /api/player/tool + /api/player/lobby/tool plugin-relay endpoints.
  // Wire shape: { toolName: string, args: object }. Dispatcher routes by
  // declarer (game vs lobby-phase vs legacy plugin-relay). See
  // src/tool-dispatcher.ts for the full algorithm.
  if (pathname === '/api/player/tool' && method === 'POST') {
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;
    return dispatchToolCall(auth, request, env);
  }

  // GET /api/player/guide — game guide + available tools
  if (pathname === '/api/player/guide' && method === 'GET') {
    const auth = await requireAuth(request, env);
    if (auth instanceof Response) return auth;
    return handlePlayerGuide(auth, request, env);
  }

  // ------------------------------------------------------------------
  // Admin endpoints — ADMIN_TOKEN via X-Admin-Token header
  // ------------------------------------------------------------------

  const adminToolsMatch = pathname.match(/^\/api\/admin\/session\/([^/]+)\/tools$/);
  if (adminToolsMatch && method === 'GET') {
    // @ts-expect-error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'st — TODO(2.3-followup)
    return handleAdminSessionTools(decodeURIComponent(adminToolsMatch[1]), request, env);
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
    'SELECT l.id, l.game_type, l.team_size, l.phase, l.created_at, l.game_id, ' +
      'COUNT(ps.player_id) as player_count ' +
      'FROM lobbies l ' +
      'LEFT JOIN player_sessions ps ON ps.lobby_id = l.id ' +
      // Only show lobbies still accepting players (post-Phase-4.6 unified
      // GamePhaseKind: 'lobby' | 'in_progress' | 'finished').
      "WHERE l.phase = 'lobby' " +
      'GROUP BY l.id ' +
      'ORDER BY l.created_at DESC LIMIT 50',
  ).all<{
    id: string;
    game_type: string;
    team_size: number;
    phase: string;
    created_at: string;
    game_id: string | null;
    player_count: number;
  }>();

  return Response.json(
    rows.results.map((r) => ({
      lobbyId: r.id,
      gameType: r.game_type,
      teamSize: r.team_size,
      phase: r.phase,
      createdAt: r.created_at,
      gameId: r.game_id,
      playerCount: r.player_count,
    })),
  );
}

async function handleCreateLobby(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  // Default to the first registered game (matches the web shell's
  // `getDefaultPlugin()`). No literal — adding/removing games doesn't
  // require shell edits.
  const registered = getRegisteredGames();
  const defaultGameType = registered[0];
  if (!defaultGameType) {
    return Response.json({ error: 'No games registered' }, { status: 500 });
  }
  const gameType = (body?.gameType as string) ?? defaultGameType;
  const noTimeout = !!body?.noTimeout;
  // Broad bounds — LobbyDO enforces per-game limits via plugin.lobby.matchmaking
  const teamSize = Math.min(20, Math.max(1, Math.floor((body?.teamSize as number) ?? 2)));

  const lobbyId = crypto.randomUUID();

  // Write the discovery row to D1 first
  try {
    await env.DB.prepare(
      'INSERT INTO lobbies (id, game_type, team_size, phase, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(lobbyId, gameType, teamSize, 'lobby', new Date().toISOString())
      .run();
  } catch (_err) {
    return Response.json({ error: 'Failed to create lobby record' }, { status: 500 });
  }

  // Create LobbyDO
  const doStub = getLobbyDO(env, lobbyId);
  const createResp = await doStub.fetch(
    new Request('https://do/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lobbyId, gameType, teamSize, noTimeout }),
    }),
  );

  if (!createResp.ok) {
    // Roll back D1 row
    await env.DB.prepare('DELETE FROM lobbies WHERE id = ?')
      .bind(lobbyId)
      .run()
      .catch(() => {});
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    const err = (await createResp.json()) as any;
    return Response.json(
      { error: err.error ?? 'Lobby creation failed' },
      { status: createResp.status },
    );
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
  // (Games write a summary after the first action; a game older than 60s
  // with no summary is almost certainly failed/orphaned. The 60s grace
  // window prevents a race where a freshly-created game is marked finished
  // before its first action lands.)
  await env.DB.prepare(
    `UPDATE games SET finished = 1
     WHERE finished = 0
       AND game_id NOT IN (SELECT game_id FROM game_summaries)
       AND datetime(created_at) < datetime('now', '-60 seconds')`,
  )
    .run()
    .catch(() => {});

  const rows = await env.DB.prepare(
    `SELECT g.game_id, g.game_type, g.finished,
            COUNT(ps.player_id) AS player_count,
            gs.progress_counter, gs.summary_json
     FROM games g
     LEFT JOIN lobbies l ON l.game_id = g.game_id
     LEFT JOIN player_sessions ps ON ps.lobby_id = l.id
     LEFT JOIN game_summaries gs ON gs.game_id = g.game_id
     GROUP BY g.game_id
     ORDER BY g.finished ASC, g.created_at DESC
     LIMIT 50`,
  ).all<{
    game_id: string;
    game_type: string;
    finished: number;
    player_count: number;
    progress_counter: number | null;
    summary_json: string | null;
  }>();

  return Response.json(
    rows.results.map((r) => {
      const summary = r.summary_json ? JSON.parse(r.summary_json) : {};
      return {
        gameId: r.game_id,
        gameType: r.game_type,
        playerCount: r.player_count,
        finished: r.finished === 1,
        progressCounter: r.progress_counter ?? 0,
        ...summary,
      };
    }),
  );
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
        updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
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
    return Response.json(
      { error: 'gameType, config, and playerIds[] are required' },
      { status: 400 },
    );
  }

  const gameId = crypto.randomUUID();

  const doStub = getGameDO(env, gameId);
  const createResp = await doStub.fetch(
    new Request('https://do/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId,
        gameType,
        config,
        playerIds,
        handleMap: handleMap ?? {},
        teamMap: teamMap ?? {},
      }),
    }),
  );

  if (!createResp.ok) {
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    const err = (await createResp.json()) as any;
    return Response.json(
      { error: err.error ?? 'Game creation failed' },
      { status: createResp.status },
    );
  }

  // Every game is modeled as the child of a lobby (see player_sessions →
  // lobbies.game_id). Direct game creation (no lobby) is a dev-only path;
  // synthesize a lobby row so routing through player_sessions still works.
  const now = new Date().toISOString();
  const syntheticLobbyId = `synthetic-${gameId}`;
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR REPLACE INTO games (game_id, game_type, finished, created_at) VALUES (?, ?, 0, ?)',
    ).bind(gameId, gameType, now),
    env.DB.prepare(
      `INSERT OR REPLACE INTO lobbies (id, game_type, team_size, phase, created_at, game_id)
       VALUES (?, ?, ?, 'in_progress', ?, ?)`,
    ).bind(syntheticLobbyId, gameType, (playerIds as string[]).length, now, gameId),
    ...(playerIds as string[]).map((pid) =>
      env.DB.prepare(
        'INSERT OR REPLACE INTO player_sessions (player_id, lobby_id, joined_at) VALUES (?, ?, ?)',
      ).bind(pid, syntheticLobbyId, now),
    ),
  ]);

  console.log(`[Worker] Created ${gameType} game ${gameId} for ${playerIds.length} players`);
  return Response.json({ gameId, gameType, playerCount: playerIds.length }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Player-scoped handlers (auth required)
// ---------------------------------------------------------------------------

async function handlePlayerState(playerId: string, env: Env): Promise<Response> {
  const location = await getPlayerLocation(playerId, env);
  if (!location) {
    return Response.json(
      { error: 'No active lobby or game. Join a lobby first.' },
      { status: 404 },
    );
  }

  const stub =
    location.kind === 'game' ? getGameDO(env, location.gameId) : getLobbyDO(env, location.lobbyId);
  return stub.fetch(
    new Request('https://do/state', {
      method: 'GET',
      headers: { 'X-Player-Id': playerId },
    }),
  );
}

async function handlePlayerLobbyJoin(
  playerId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body instanceof Response) return body;

  const lobbyId = body?.lobbyId ?? body?.gameId;
  if (!lobbyId) return Response.json({ error: 'lobbyId is required' }, { status: 400 });

  // Fetch handle + ELO from D1 players table
  const player = await env.DB.prepare('SELECT handle, elo FROM players WHERE id = ?')
    .bind(playerId)
    .first<{ handle: string; elo: number }>();
  const handle = player?.handle ?? playerId;
  const elo = player?.elo ?? 1000;

  // Forward join to LobbyDO — identity goes in the header, body carries
  // only the player's display info.
  const doStub = getLobbyDO(env, lobbyId);
  const joinResp = await doStub.fetch(
    new Request('https://do/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Player-Id': playerId },
      body: JSON.stringify({ handle, elo }),
    }),
  );

  if (!joinResp.ok) return joinResp;

  // Clone the response so we can inspect it and still return it
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  const joinBody = (await joinResp.json()) as any;

  // Point the player's session at this lobby. Works for all phases — if the
  // join immediately transitioned the lobby into 'game' phase, the session
  // row still correctly points at the lobby, and getPlayerLocation() resolves
  // through lobbies.game_id to the GameRoomDO.
  await env.DB.prepare(
    'INSERT OR REPLACE INTO player_sessions (player_id, lobby_id, joined_at) VALUES (?, ?, ?)',
  )
    .bind(playerId, lobbyId, new Date().toISOString())
    .run();

  return Response.json(joinBody, { status: joinResp.status });
}

// ---------------------------------------------------------------------------
// Guide handler
// ---------------------------------------------------------------------------

async function handlePlayerGuide(playerId: string, request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let gameType = url.searchParams.get('game');

  if (!gameType) {
    const location = await getPlayerLocation(playerId, env);
    if (location) gameType = location.gameType;
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
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
        tools.push(...phase.tools.map((t: any) => t.name ?? t));
      }
    }
  }

  return Response.json({ gameType, guide, tools });
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

/**
 * Resolve where a player's actions should route.
 *
 * A player has at most one `player_sessions` row, which references a lobby.
 * The lobby's `game_id` column (set by LobbyDO at handoff) determines whether
 * routing targets the LobbyDO or the spawned GameRoomDO.
 *
 * Returns `null` if the player has no session row (not in any lobby or game).
 */
async function getPlayerLocation(
  playerId: string,
  env: Env,
): Promise<
  | { kind: 'lobby'; lobbyId: string; gameType: string }
  | { kind: 'game'; lobbyId: string; gameId: string; gameType: string }
  | null
> {
  const row = await env.DB.prepare(
    `SELECT l.id AS lobby_id, l.game_id, l.game_type
     FROM player_sessions ps
     JOIN lobbies l ON l.id = ps.lobby_id
     WHERE ps.player_id = ?`,
  )
    .bind(playerId)
    .first<{ lobby_id: string; game_id: string | null; game_type: string }>();

  if (!row) return null;
  if (row.game_id) {
    return { kind: 'game', lobbyId: row.lobby_id, gameId: row.game_id, gameType: row.game_type };
  }
  return { kind: 'lobby', lobbyId: row.lobby_id, gameType: row.game_type };
}

function forwardToGameDO(
  env: Env,
  gameId: string,
  subPath: string,
  request: Request,
): Promise<Response> {
  const stub = getGameDO(env, gameId);
  const url = new URL(request.url);
  url.pathname = subPath;
  return stub.fetch(new Request(url.toString(), request));
}

function forwardToLobbyDO(
  env: Env,
  lobbyId: string,
  subPath: string,
  request: Request,
): Promise<Response> {
  const stub = getLobbyDO(env, lobbyId);
  const url = new URL(request.url);
  url.pathname = subPath;
  return stub.fetch(new Request(url.toString(), request));
}
