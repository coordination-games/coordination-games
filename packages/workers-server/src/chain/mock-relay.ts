import { resolvePlayer } from '../db/player.js';
import type {
  AgentInfo,
  BalanceInfo,
  BurnRequest,
  ChainRelay,
  CreditDelta,
  GameSettlement,
  PermitParams,
  RegisterParams,
  SettlementReceipt,
} from './types.js';

export class MockRelay implements ChainRelay {
  constructor(private db: D1Database) {}

  async getAgentByAddress(address: string): Promise<AgentInfo | null> {
    const row = await this.db
      .prepare(
        'SELECT id, wallet_address, handle FROM players WHERE wallet_address = ? COLLATE NOCASE',
      )
      .bind(address)
      .first<{ id: string; wallet_address: string; handle: string }>();
    if (!row) return null;
    return {
      address: row.wallet_address,
      agentId: row.id,
      name: row.handle,
      credits: '0',
      registered: true,
    };
  }

  async checkName(name: string): Promise<{ available: boolean }> {
    const row = await this.db
      .prepare('SELECT id FROM players WHERE handle = ? COLLATE NOCASE')
      .bind(name)
      .first();
    return { available: !row };
  }

  async register(
    params: RegisterParams,
  ): Promise<{ agentId: string; name: string; credits: string }> {
    const { player } = await resolvePlayer(params.address, this, this.db, { handle: params.name });
    return { agentId: player.id, name: player.handle, credits: '0' };
  }

  async getBalance(_agentId: string): Promise<BalanceInfo> {
    return { credits: '0', usdc: '0' };
  }

  async topup(_agentId: string, _permit: PermitParams): Promise<{ credits: string }> {
    throw new Error('Credits not available in mock mode');
  }

  async requestBurn(_agentId: string, _amount: string): Promise<BurnRequest> {
    throw new Error('Withdrawal not available in mock mode');
  }

  async executeBurn(_agentId: string): Promise<{ credits: string }> {
    throw new Error('Withdrawal not available in mock mode');
  }

  async cancelBurn(_agentId: string): Promise<void> {
    throw new Error('Withdrawal not available in mock mode');
  }

  async settleGame(_result: GameSettlement, _deltas: CreditDelta[]): Promise<SettlementReceipt> {
    // Mock: no-op, return fake tx hash
    return { txHash: `0x${'0'.repeat(64)}` };
  }
}
