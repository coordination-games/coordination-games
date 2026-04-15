import type { Env } from '../env.js';
import type { ChainRelay, AgentInfo, RegisterParams, BalanceInfo, PermitParams, BurnRequest, CreditDelta, GameSettlement, SettlementReceipt } from './types.js';

export class OnChainRelay implements ChainRelay {
  constructor(private env: Env) {}

  async getAgentByAddress(_address: string): Promise<AgentInfo | null> {
    throw new Error('OnChainRelay.getAgentByAddress not implemented');
  }

  async checkName(_name: string): Promise<{ available: boolean }> {
    throw new Error('OnChainRelay.checkName not implemented');
  }

  async register(_params: RegisterParams): Promise<{ agentId: string; credits: string }> {
    throw new Error('OnChainRelay.register not implemented');
  }

  async getBalance(_agentId: string): Promise<BalanceInfo> {
    throw new Error('OnChainRelay.getBalance not implemented');
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
