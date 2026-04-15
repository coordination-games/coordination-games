import { createPublicClient, createWalletClient, http, keccak256, toBytes, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
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

  // --- Write methods (Phase 3) ---

  async register(params: RegisterParams): Promise<{ agentId: string; credits: string }> {
    const account = privateKeyToAccount(this.env.RELAYER_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: optimismSepolia,
      transport: http(this.env.RPC_URL),
    });

    const registerAbi = [{
      name: 'registerNew',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'user', type: 'address' },
        { name: 'name', type: 'string' },
        { name: 'agentURI', type: 'string' },
        { name: 'deadline', type: 'uint256' },
        { name: 'v', type: 'uint8' },
        { name: 'r', type: 'bytes32' },
        { name: 's', type: 'bytes32' },
      ],
      outputs: [],
    }] as const;

    const txHash = await walletClient.writeContract({
      address: this.env.REGISTRY_ADDRESS as `0x${string}`,
      abi: registerAbi,
      functionName: 'registerNew',
      args: [
        params.address as `0x${string}`,
        params.name,
        params.agentURI,
        BigInt(params.permitDeadline),
        params.v,
        params.r as `0x${string}`,
        params.s as `0x${string}`,
      ],
    } as any);

    // Wait for receipt
    const receipt = await this.client.waitForTransactionReceipt({ hash: txHash });

    // Parse Registered event to get agentId
    // Event: Registered(address indexed user, uint256 indexed agentId, string name)
    const registeredTopic = keccak256(toBytes('Registered(address,uint256,string)'));
    const registeredLog = receipt.logs.find((l: any) => l.topics[0] === registeredTopic);
    const agentId = registeredLog ? BigInt(registeredLog.topics[2]).toString() : '0';

    // Cache chain_agent_id in D1
    const existing = await this.env.DB.prepare(
      'SELECT id FROM players WHERE wallet_address = ? COLLATE NOCASE'
    ).bind(params.address).first<{ id: string }>();

    if (existing) {
      await this.env.DB.prepare('UPDATE players SET chain_agent_id = ?, handle = ? WHERE id = ?')
        .bind(Number(agentId), params.name, existing.id).run();
    } else {
      const playerId = crypto.randomUUID();
      await this.env.DB.prepare(
        'INSERT INTO players (id, wallet_address, handle, chain_agent_id, elo, games_played, wins, created_at) VALUES (?, ?, ?, ?, 1000, 0, 0, ?)'
      ).bind(playerId, params.address, params.name, Number(agentId), new Date().toISOString()).run();
    }

    // Read initial credits
    const credits = await this.client.readContract({
      address: this.env.CREDITS_ADDRESS as `0x${string}`,
      abi: creditsAbi,
      functionName: 'balances',
      args: [BigInt(agentId)],
    }) as bigint;

    return { agentId, credits: credits.toString() };
  }

  async settleGame(result: GameSettlement, deltas: CreditDelta[]): Promise<SettlementReceipt> {
    const account = privateKeyToAccount(this.env.RELAYER_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: optimismSepolia,
      transport: http(this.env.RPC_URL),
    });

    // Translate D1 player UUIDs to on-chain agentIds
    const onChainPlayers: bigint[] = [];
    for (const pid of result.playerIds) {
      const row = await this.env.DB.prepare(
        'SELECT chain_agent_id FROM players WHERE id = ?'
      ).bind(pid).first<{ chain_agent_id: number | null }>();
      if (!row?.chain_agent_id) throw new Error(`Player ${pid} has no on-chain identity`);
      onChainPlayers.push(BigInt(row.chain_agent_id));
    }

    // Build on-chain deltas (parallel to onChainPlayers)
    const onChainDeltas = deltas.map(d => {
      const idx = result.playerIds.indexOf(d.agentId);
      if (idx === -1) throw new Error(`Delta for unknown player ${d.agentId}`);
      return BigInt(d.delta);
    });

    const gameIdBytes = keccak256(toBytes(result.gameId)) as `0x${string}`;
    const movesRootBytes = result.movesRoot as `0x${string}`;
    const configHashBytes = result.configHash as `0x${string}`;
    const outcomeBytes = toHex(JSON.stringify(result.outcome)) as `0x${string}`;

    const gameAnchorAbi = [{
      name: 'settleGame',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'result', type: 'tuple', components: [
          { name: 'gameId', type: 'bytes32' },
          { name: 'gameType', type: 'string' },
          { name: 'players', type: 'uint256[]' },
          { name: 'outcome', type: 'bytes' },
          { name: 'movesRoot', type: 'bytes32' },
          { name: 'configHash', type: 'bytes32' },
          { name: 'turnCount', type: 'uint16' },
          { name: 'timestamp', type: 'uint64' },
        ]},
        { name: 'deltas', type: 'int256[]' },
      ],
      outputs: [],
    }] as const;

    const txHash = await walletClient.writeContract({
      address: this.env.GAME_ANCHOR_ADDRESS as `0x${string}`,
      abi: gameAnchorAbi,
      functionName: 'settleGame',
      args: [
        {
          gameId: gameIdBytes,
          gameType: result.gameType,
          players: onChainPlayers,
          outcome: outcomeBytes,
          movesRoot: movesRootBytes,
          configHash: configHashBytes,
          turnCount: result.turnCount,
          timestamp: BigInt(result.timestamp),
        },
        onChainDeltas,
      ],
    } as any);

    await this.client.waitForTransactionReceipt({ hash: txHash });
    return { txHash };
  }

  // --- Write methods (Phase 4: Credits) ---

  async topup(agentId: string, permit: PermitParams): Promise<{ credits: string }> {
    const account = privateKeyToAccount(this.env.RELAYER_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: optimismSepolia, transport: http(this.env.RPC_URL) });

    const txHash = await walletClient.writeContract({
      address: this.env.CREDITS_ADDRESS as `0x${string}`,
      abi: [{ name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'usdcAmount', type: 'uint256' }], outputs: [] }] as const,
      functionName: 'mint',
      args: [BigInt(agentId), BigInt(permit.amount)],
    } as any);
    await this.client.waitForTransactionReceipt({ hash: txHash });

    const credits = await this.client.readContract({
      address: this.env.CREDITS_ADDRESS as `0x${string}`,
      abi: creditsAbi,
      functionName: 'balances',
      args: [BigInt(agentId)],
    } as any) as bigint;
    return { credits: credits.toString() };
  }

  async requestBurn(agentId: string, amount: string): Promise<BurnRequest> {
    const account = privateKeyToAccount(this.env.RELAYER_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: optimismSepolia, transport: http(this.env.RPC_URL) });

    const txHash = await walletClient.writeContract({
      address: this.env.CREDITS_ADDRESS as `0x${string}`,
      abi: [{ name: 'requestBurn', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'amount', type: 'uint256' }], outputs: [] }] as const,
      functionName: 'requestBurn',
      args: [BigInt(agentId), BigInt(amount)],
    } as any);
    await this.client.waitForTransactionReceipt({ hash: txHash });

    const pending = await this.client.readContract({
      address: this.env.CREDITS_ADDRESS as `0x${string}`,
      abi: [{ name: 'pendingBurns', type: 'function', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }, { name: 'executeAfter', type: 'uint256' }] }] as const,
      functionName: 'pendingBurns',
      args: [BigInt(agentId)],
    } as any) as [bigint, bigint];

    return { pendingAmount: pending[0].toString(), executeAfter: Number(pending[1]) };
  }

  async executeBurn(agentId: string): Promise<{ credits: string }> {
    const account = privateKeyToAccount(this.env.RELAYER_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: optimismSepolia, transport: http(this.env.RPC_URL) });

    const txHash = await walletClient.writeContract({
      address: this.env.CREDITS_ADDRESS as `0x${string}`,
      abi: [{ name: 'executeBurn', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [] }] as const,
      functionName: 'executeBurn',
      args: [BigInt(agentId)],
    } as any);
    await this.client.waitForTransactionReceipt({ hash: txHash });

    const credits = await this.client.readContract({
      address: this.env.CREDITS_ADDRESS as `0x${string}`,
      abi: creditsAbi,
      functionName: 'balances',
      args: [BigInt(agentId)],
    } as any) as bigint;
    return { credits: credits.toString() };
  }

  async cancelBurn(agentId: string): Promise<void> {
    const account = privateKeyToAccount(this.env.RELAYER_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: optimismSepolia, transport: http(this.env.RPC_URL) });

    const txHash = await walletClient.writeContract({
      address: this.env.CREDITS_ADDRESS as `0x${string}`,
      abi: [{ name: 'cancelBurn', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [] }] as const,
      functionName: 'cancelBurn',
      args: [BigInt(agentId)],
    } as any);
    await this.client.waitForTransactionReceipt({ hash: txHash });
  }
}
