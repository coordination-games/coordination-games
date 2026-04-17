import { createPublicClient, http, keccak256, toBytes } from 'viem';
import { optimismSepolia } from 'viem/chains';

import type { Env } from '../env.js';
import { createRelay } from '../chain/index.js';
import { resolvePlayer, PlayerHandleTakenError } from '../db/player.js';

export interface PlatformIdentityVerification {
  chainAgentId: number | null;
}

export interface AuthenticatedPlatformPlayer {
  playerId: string;
  name: string;
  walletAddress: string;
  chainAgentId: number | null;
  reconnected: boolean;
}

export async function verifyOptionalPlatformIdentityOwnership(
  address: string,
  name: string,
  env: Env,
): Promise<PlatformIdentityVerification> {
  if (!(env.RPC_URL && env.REGISTRY_ADDRESS && env.ERC8004_ADDRESS)) {
    return { chainAgentId: null };
  }

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
  } as const);

  if (agentId === 0n) {
    throw new Error(`Name "${name}" is not registered on-chain`);
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
  } as const) as `0x${string}`;

  if (owner.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`Address ${address} does not own name "${name}"`);
  }

  return { chainAgentId: Number(agentId) };
}

export async function resolveAuthenticatedPlatformPlayer(
  address: string,
  name: string,
  env: Env,
): Promise<AuthenticatedPlatformPlayer> {
  const trimmed = name.trim();
  const walletAddress = address.toLowerCase();
  const verification = await verifyOptionalPlatformIdentityOwnership(walletAddress, trimmed, env);
  const relay = createRelay(env);

  try {
    const { player, created } = await resolvePlayer(walletAddress, relay, env.DB, {
      handle: trimmed,
      chainAgentId: verification.chainAgentId ?? undefined,
    });

    return {
      playerId: player.id,
      name: trimmed,
      walletAddress,
      chainAgentId: player.chainAgentId,
      reconnected: !created,
    };
  } catch (err) {
    if (err instanceof PlayerHandleTakenError) throw err;
    throw err;
  }
}
