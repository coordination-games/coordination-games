import { createPublicClient, http } from 'viem';
import { optimismSepolia } from 'viem/chains';
import type { Env } from '../env.js';
import type { ChainRelay, AgentInfo, RegisterParams, BalanceInfo, PermitParams, BurnRequest, CreditDelta, GameSettlement, SettlementReceipt } from './types.js';

// Minimal ABIs for read operations
const erc8004Abi = [
  { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
] as const;

const registryAbi = [
  { name: 'checkName', type: 'function', stateMutability: 'view', inputs: [{ name: 'name', type: 'string' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'nameToAgent', type: 'function', stateMutability: 'view', inputs: [{ name: 'nameKey', type: 'bytes32' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'displayName', type: 'function', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }] },
  { name: 'registered', type: 'function', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

const creditsAbi = [
  { name: 'balances', type: 'function', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

const erc20Abi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

export class OnChainRelay implements ChainRelay {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem 2.x PublicClient generics fight inline ABIs
  private client: any;

  constructor(private env: Env) {
    this.client = createPublicClient({
      chain: optimismSepolia,
      transport: http(env.RPC_URL),
    });
  }

  async getAgentByAddress(address: string): Promise<AgentInfo | null> {
    // First check D1 cache for chain_agent_id
    const cached = await this.env.DB.prepare(
      'SELECT id, wallet_address, handle, chain_agent_id FROM players WHERE wallet_address = ? COLLATE NOCASE'
    ).bind(address).first<{ id: string; wallet_address: string; handle: string; chain_agent_id: number | null }>();

    if (cached?.chain_agent_id) {
      // We have a cached on-chain mapping — read live balance
      const credits = await this.client.readContract({
        address: this.env.CREDITS_ADDRESS as `0x${string}`,
        abi: creditsAbi,
        functionName: 'balances',
        args: [BigInt(cached.chain_agent_id)],
      }) as bigint;

      return {
        address: cached.wallet_address,
        agentId: String(cached.chain_agent_id),
        name: cached.handle,
        credits: credits.toString(),
        registered: true,
      };
    }

    // Scan ERC-8004 ownership — check recent token IDs
    try {
      const totalSupply = await this.client.readContract({
        address: this.env.ERC8004_ADDRESS as `0x${string}`,
        abi: erc8004Abi,
        functionName: 'totalSupply',
      }) as bigint;

      for (let id = totalSupply; id > 0n; id--) {
        const owner = await this.client.readContract({
          address: this.env.ERC8004_ADDRESS as `0x${string}`,
          abi: erc8004Abi,
          functionName: 'ownerOf',
          args: [id],
        }) as string;

        if (owner.toLowerCase() === address.toLowerCase()) {
          // Found! Get name and credits
          const [name, credits] = await Promise.all([
            this.client.readContract({
              address: this.env.REGISTRY_ADDRESS as `0x${string}`,
              abi: registryAbi,
              functionName: 'displayName',
              args: [id],
            }) as Promise<string>,
            this.client.readContract({
              address: this.env.CREDITS_ADDRESS as `0x${string}`,
              abi: creditsAbi,
              functionName: 'balances',
              args: [id],
            }) as Promise<bigint>,
          ]);

          // Cache in D1
          if (cached) {
            await this.env.DB.prepare('UPDATE players SET chain_agent_id = ? WHERE id = ?').bind(Number(id), cached.id).run();
          }

          return {
            address,
            agentId: id.toString(),
            name: name || cached?.handle || '',
            credits: credits.toString(),
            registered: true,
          };
        }
      }
    } catch (err) {
      console.error('[OnChainRelay] Error scanning ERC-8004:', err);
    }

    // Not registered on-chain
    if (cached) {
      return { address, agentId: cached.id, name: cached.handle, credits: '0', registered: false };
    }
    return null;
  }

  async checkName(name: string): Promise<{ available: boolean }> {
    const available = await this.client.readContract({
      address: this.env.REGISTRY_ADDRESS as `0x${string}`,
      abi: registryAbi,
      functionName: 'checkName',
      args: [name],
    }) as boolean;
    return { available };
  }

  async getBalance(agentId: string): Promise<BalanceInfo> {
    const [credits, usdc] = await Promise.all([
      this.client.readContract({
        address: this.env.CREDITS_ADDRESS as `0x${string}`,
        abi: creditsAbi,
        functionName: 'balances',
        args: [BigInt(agentId)],
      }) as Promise<bigint>,
      // For USDC balance, we need the owner address — get it from ERC-8004
      this.getOwnerUsdcBalance(BigInt(agentId)),
    ]);

    return { credits: credits.toString(), usdc: usdc.toString() };
  }

  private async getOwnerUsdcBalance(agentId: bigint): Promise<bigint> {
    try {
      const owner = await this.client.readContract({
        address: this.env.ERC8004_ADDRESS as `0x${string}`,
        abi: erc8004Abi,
        functionName: 'ownerOf',
        args: [agentId],
      }) as `0x${string}`;

      return await this.client.readContract({
        address: this.env.USDC_ADDRESS as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      }) as bigint;
    } catch {
      return 0n;
    }
  }

  // --- Write stubs (Phase 3-4) ---
  async register(_params: RegisterParams): Promise<{ agentId: string; credits: string }> {
    throw new Error('OnChainRelay.register not implemented');
  }
  async topup(_agentId: string, _permit: PermitParams): Promise<{ credits: string }> {
    throw new Error('OnChainRelay.topup not implemented');
  }
  async requestBurn(_agentId: string, _amount: string): Promise<BurnRequest> {
    throw new Error('OnChainRelay.requestBurn not implemented');
  }
  async executeBurn(_agentId: string): Promise<{ credits: string }> {
    throw new Error('OnChainRelay.executeBurn not implemented');
  }
  async cancelBurn(_agentId: string): Promise<void> {
    throw new Error('OnChainRelay.cancelBurn not implemented');
  }
  async settleGame(_result: GameSettlement, _deltas: CreditDelta[]): Promise<SettlementReceipt> {
    throw new Error('OnChainRelay.settleGame not implemented');
  }
}
