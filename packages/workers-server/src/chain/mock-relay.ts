import type { ChainRelay, AgentInfo, RegisterParams, BalanceInfo, PermitParams, BurnRequest, CreditDelta, GameSettlement, SettlementReceipt } from './types.js';

export class MockRelay implements ChainRelay {
  constructor(private db: D1Database) {}

  async getAgentByAddress(address: string): Promise<AgentInfo | null> {
    const row = await this.db.prepare(
      'SELECT id, wallet_address, handle FROM players WHERE wallet_address = ? COLLATE NOCASE'
    ).bind(address).first<{ id: string; wallet_address: string; handle: string }>();
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
    const row = await this.db.prepare(
      'SELECT id FROM players WHERE handle = ? COLLATE NOCASE'
    ).bind(name).first();
    return { available: !row };
  }

  async register(params: RegisterParams): Promise<{ agentId: string; credits: string }> {
    const id = crypto.randomUUID();
    await this.db.prepare(
      'INSERT INTO players (id, wallet_address, handle, elo, games_played, wins, created_at) VALUES (?, ?, ?, 1000, 0, 0, ?)'
    ).bind(id, params.address, params.name, new Date().toISOString()).run();
    return { agentId: id, credits: '0' };
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
    return { txHash: '0x' + '0'.repeat(64) };
  }
}
