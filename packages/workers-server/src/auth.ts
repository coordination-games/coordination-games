import { verifyMessage } from 'viem';
import type { Env } from './env.js';
import { PlayerHandleTakenError } from './db/player.js';
import { resolveAuthenticatedPlatformPlayer } from './platform/identity.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;    // 5 minutes
const SESSION_TTL_MS   = 24 * 60 * 60 * 1000; // 24 hours

function hexRandom(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
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
    'INSERT INTO auth_nonces (nonce, wallet_address, expires_at) VALUES (?, ?, ?)'
  ).bind(nonce, '', expiresAt).run();

  return Response.json({ nonce, message, expiresAt });
}

// ---------------------------------------------------------------------------
// POST /api/player/auth/verify
// ---------------------------------------------------------------------------

export async function handleAuthVerify(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { nonce: rawNonce, signature: rawSig, address: rawAddr, name: rawName } = body ?? {} as Record<string, unknown>;
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
  const nonceRow = await env.DB.prepare(
    'SELECT nonce, expires_at FROM auth_nonces WHERE nonce = ?'
  ).bind(nonce).first<{ nonce: string; expires_at: string }>();

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
  } catch (err: any) {
    return Response.json({ error: 'Signature verification failed: ' + err.message }, { status: 401 });
  }

  if (!isValid) {
    return Response.json(
      { error: 'Signature verification failed — recovered address does not match' },
      { status: 401 },
    );
  }

  let playerId: string;
  let reconnected: boolean;
  let normalizedName: string;
  try {
    const resolved = await resolveAuthenticatedPlatformPlayer(address, name, env);
    playerId = resolved.playerId;
    reconnected = resolved.reconnected;
    normalizedName = resolved.name;
    if (resolved.chainAgentId !== null) {
      console.log(`[auth] On-chain verified: "${normalizedName}" owned by ${resolved.walletAddress} (agent ${resolved.chainAgentId})`);
    }
  } catch (err: any) {
    if (err instanceof PlayerHandleTakenError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    if (
      String(err?.message ?? '').includes('is not registered on-chain') ||
      String(err?.message ?? '').includes('does not own name')
    ) {
      return Response.json({ error: err.message }, { status: 401 });
    }
    if (String(err?.message ?? '').includes('on-chain')) {
      console.error('[auth] On-chain verification failed:', err.message);
      return Response.json({ error: 'On-chain verification failed: ' + err.message }, { status: 500 });
    }
    throw err;
  }

  // Issue session token
  const token = hexRandom(20);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await env.DB.prepare(
    'INSERT OR REPLACE INTO auth_sessions (token, player_id, name, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, playerId, normalizedName, expiresAt).run();

  console.log(`[auth] Verified "${normalizedName}" wallet=${address.toLowerCase()} playerId=${playerId} reconnected=${reconnected}`);

  return Response.json({ token, agentId: playerId, name: normalizedName, expiresAt, reconnected });
}

// ---------------------------------------------------------------------------
// Bearer token validation — returns playerId or null
// ---------------------------------------------------------------------------

export async function validateBearerToken(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const row = await env.DB.prepare(
    'SELECT player_id, expires_at FROM auth_sessions WHERE token = ?'
  ).bind(token).first<{ player_id: string; expires_at: string }>();

  if (!row) return null;

  if (Date.now() > new Date(row.expires_at).getTime()) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run();
    return null;
  }

  return row.player_id;
}
