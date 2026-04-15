import { verifyMessage, createPublicClient, http, keccak256, toBytes } from 'viem';
import { optimismSepolia } from 'viem/chains';
import type { Env } from './env.js';

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

  // Optional: ERC-8004 on-chain name ownership check
  if (env.RPC_URL && env.REGISTRY_ADDRESS && env.ERC8004_ADDRESS) {
    try {
      const client = createPublicClient({
        chain: optimismSepolia,
        transport: http(env.RPC_URL),
      });

      const registryAbi = [{
        name: 'nameToAgent',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'nameKey', type: 'bytes32' }],
        outputs: [{ name: '', type: 'uint256' }],
      }] as const;
      const nameKey = keccak256(toBytes(name.toLowerCase()));
      const agentId = await client.readContract({
        address: env.REGISTRY_ADDRESS as `0x${string}`,
        abi: registryAbi,
        functionName: 'nameToAgent',
        args: [nameKey],
      } as any);

      if (agentId === 0n) {
        return Response.json({ error: `Name "${name}" is not registered on-chain` }, { status: 401 });
      }

      const erc8004Abi = [{
        name: 'ownerOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ name: '', type: 'address' }],
      }] as const;
      const owner = await client.readContract({
        address: env.ERC8004_ADDRESS as `0x${string}`,
        abi: erc8004Abi,
        functionName: 'ownerOf',
        args: [agentId],
      } as any) as `0x${string}`;

      if (owner.toLowerCase() !== address.toLowerCase()) {
        return Response.json(
          { error: `Address ${address} does not own name "${name}"` },
          { status: 401 },
        );
      }

      console.log(`[auth] On-chain verified: "${name}" owned by ${address}`);
    } catch (err: any) {
      console.error('[auth] On-chain verification failed:', err.message);
      return Response.json({ error: 'On-chain verification failed: ' + err.message }, { status: 500 });
    }
  }

  // Upsert player by wallet address
  const trimmed = name.trim();
  const addressLower = address.toLowerCase();

  const existing = await env.DB.prepare(
    'SELECT id FROM players WHERE wallet_address = ? COLLATE NOCASE'
  ).bind(addressLower).first<{ id: string }>();

  let playerId: string;
  let reconnected = false;

  if (existing) {
    playerId = existing.id;
    reconnected = true;
    // Keep handle current in case they changed their registered name
    await env.DB.prepare('UPDATE players SET handle = ? WHERE id = ?').bind(trimmed, playerId).run();
  } else {
    playerId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO players (id, wallet_address, handle) VALUES (?, ?, ?)'
      ).bind(playerId, addressLower, trimmed).run();
    } catch (err: any) {
      // Handle UNIQUE conflict on handle — another player already took this name
      if (err.message?.includes('UNIQUE')) {
        return Response.json({ error: `Handle "${trimmed}" is already taken` }, { status: 409 });
      }
      throw err;
    }
  }

  // Issue session token
  const token = hexRandom(20);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await env.DB.prepare(
    'INSERT OR REPLACE INTO auth_sessions (token, player_id, name, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, playerId, trimmed, expiresAt).run();

  console.log(`[auth] Verified "${trimmed}" wallet=${addressLower} playerId=${playerId} reconnected=${reconnected}`);

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
    'SELECT player_id, expires_at FROM auth_sessions WHERE token = ?'
  ).bind(token).first<{ player_id: string; expires_at: string }>();

  if (!row) return null;

  if (Date.now() > new Date(row.expires_at).getTime()) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run();
    return null;
  }

  return row.player_id;
}
