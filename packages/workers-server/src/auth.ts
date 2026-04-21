import { keccak256, toBytes, verifyMessage } from 'viem';
import { createRelay } from './chain/index.js';
import { PlayerHandleTakenError, resolvePlayer } from './db/player.js';
import type { Env } from './env.js';
import { createFallbackPublicClient, parseRpcUrls } from './rpc-fallback.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hexRandom(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// POST /api/player/auth/challenge
// ---------------------------------------------------------------------------

export async function handleAuthChallenge(_request: Request, env: Env): Promise<Response> {
  const nonce = hexRandom(32);
  const message = `Sign this message to authenticate with Coordination Games.\nNonce: ${nonce}`;
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

  // wallet_address is NOT NULL in schema but unknown at challenge time — store placeholder
  await env.DB.prepare(
    'INSERT INTO auth_nonces (nonce, wallet_address, expires_at) VALUES (?, ?, ?)',
  )
    .bind(nonce, '', expiresAt)
    .run();

  return Response.json({ nonce, message, expiresAt });
}

// ---------------------------------------------------------------------------
// POST /api/player/auth/verify
// ---------------------------------------------------------------------------

export async function handleAuthVerify(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    nonce: rawNonce,
    signature: rawSig,
    address: rawAddr,
    name: rawName,
  } = body ?? ({} as Record<string, unknown>);
  if (!rawNonce || !rawSig || !rawAddr || !rawName) {
    return Response.json(
      { error: 'nonce, signature, address, and name are all required' },
      { status: 400 },
    );
  }
  const nonce = rawNonce as string;
  const signature = rawSig as string;
  const address = rawAddr as string;
  const name = rawName as string;

  // Look up and consume nonce (one-time use)
  const nonceRow = await env.DB.prepare('SELECT nonce, expires_at FROM auth_nonces WHERE nonce = ?')
    .bind(nonce)
    .first<{ nonce: string; expires_at: string }>();

  if (!nonceRow) {
    return Response.json({ error: 'Invalid or expired challenge nonce' }, { status: 401 });
  }

  await env.DB.prepare('DELETE FROM auth_nonces WHERE nonce = ?').bind(nonce).run();

  if (Date.now() > new Date(nonceRow.expires_at).getTime()) {
    return Response.json({ error: 'Invalid or expired challenge nonce' }, { status: 401 });
  }

  // Verify EIP-712 signature
  const message = `Sign this message to authenticate with Coordination Games.\nNonce: ${nonce}`;
  let isValid: boolean;
  try {
    isValid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Signature verification failed: ${msg}` }, { status: 401 });
  }

  if (!isValid) {
    return Response.json(
      { error: 'Signature verification failed — recovered address does not match' },
      { status: 401 },
    );
  }

  // Optional: ERC-8004 on-chain name ownership check
  const rpcUrls = parseRpcUrls(env);
  if (rpcUrls.length > 0 && env.REGISTRY_ADDRESS && env.ERC8004_ADDRESS) {
    try {
      // One fallback client per request — `currentUrl` cache lives here so
      // both readContract calls below reuse the same known-good URL.
      const { client } = createFallbackPublicClient(rpcUrls);

      const registryAbi = [
        {
          name: 'nameToAgent',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'nameKey', type: 'bytes32' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const;
      const nameKey = keccak256(toBytes(name.toLowerCase()));
      const agentId = await client.readContract({
        address: env.REGISTRY_ADDRESS as `0x${string}`,
        abi: registryAbi,
        functionName: 'nameToAgent',
        args: [nameKey],
      });

      if (agentId === 0n) {
        return Response.json(
          { error: `Name "${name}" is not registered on-chain` },
          { status: 401 },
        );
      }

      const erc8004Abi = [
        {
          name: 'ownerOf',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'tokenId', type: 'uint256' }],
          outputs: [{ name: '', type: 'address' }],
        },
      ] as const;
      const owner = (await client.readContract({
        address: env.ERC8004_ADDRESS as `0x${string}`,
        abi: erc8004Abi,
        functionName: 'ownerOf',
        args: [agentId],
      })) as `0x${string}`;

      if (owner.toLowerCase() !== address.toLowerCase()) {
        return Response.json(
          { error: `Address ${address} does not own name "${name}"` },
          { status: 401 },
        );
      }

      console.log(`[auth] On-chain verified: "${name}" owned by ${address}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[auth] On-chain verification failed:', msg);
      return Response.json({ error: `On-chain verification failed: ${msg}` }, { status: 500 });
    }
  }

  // Resolve player via read-through cache (chain → D1)
  const trimmed = name.trim();
  const relay = createRelay(env);

  let playerId: string;
  let reconnected: boolean;
  try {
    const { player, created } = await resolvePlayer(address, relay, env.DB, { handle: trimmed });
    playerId = player.id;
    reconnected = !created;
  } catch (err) {
    if (err instanceof PlayerHandleTakenError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  // Issue session token
  const token = hexRandom(20);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await env.DB.prepare(
    'INSERT OR REPLACE INTO auth_sessions (token, player_id, name, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(token, playerId, trimmed, expiresAt)
    .run();

  console.log(
    `[auth] Verified "${trimmed}" wallet=${address.toLowerCase()} playerId=${playerId} reconnected=${reconnected}`,
  );

  return Response.json({ token, agentId: playerId, name: trimmed, expiresAt, reconnected });
}

// ---------------------------------------------------------------------------
// Bearer token validation — returns playerId or null
// ---------------------------------------------------------------------------

export async function validateBearerToken(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const row = await env.DB.prepare(
    'SELECT player_id, expires_at FROM auth_sessions WHERE token = ?',
  )
    .bind(token)
    .first<{ player_id: string; expires_at: string }>();

  if (!row) return null;

  if (Date.now() > new Date(row.expires_at).getTime()) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run();
    return null;
  }

  return row.player_id;
}

// ---------------------------------------------------------------------------
// WebSocket tickets — single-use, short-lived auth for WS upgrades
//
// Native WebSocket clients (including Node's global and browsers) can't set
// custom headers on the upgrade request. The ticket pattern keeps the
// long-lived session token in `Authorization: Bearer` on HTTP and only
// exposes a ~30s single-use ID in the URL, so access logs can't be replayed.
// ---------------------------------------------------------------------------

const WS_TICKET_TTL_MS = 30_000;

/** Issue a new single-use ticket for the given player. Caller must be authed. */
export async function createWsTicket(playerId: string, env: Env): Promise<string> {
  const ticket = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + WS_TICKET_TTL_MS).toISOString();
  await env.DB.prepare('INSERT INTO ws_tickets (ticket, player_id, expires_at) VALUES (?, ?, ?)')
    .bind(ticket, playerId, expiresAt)
    .run();
  return ticket;
}

/**
 * Consume the `?ticket=` query param from a WS upgrade URL. The row is
 * deleted unconditionally — even when missing or expired — so a leaked ID
 * can't be replayed. Returns the associated playerId on success.
 */
export async function consumeWsTicket(url: URL, env: Env): Promise<string | null> {
  const ticket = url.searchParams.get('ticket');
  if (!ticket) return null;
  const row = await env.DB.prepare('SELECT player_id, expires_at FROM ws_tickets WHERE ticket = ?')
    .bind(ticket)
    .first<{ player_id: string; expires_at: string }>();
  // Unconditional delete: single-use semantics.
  await env.DB.prepare('DELETE FROM ws_tickets WHERE ticket = ?').bind(ticket).run();
  if (!row) return null;
  if (Date.now() > new Date(row.expires_at).getTime()) return null;
  return row.player_id;
}
