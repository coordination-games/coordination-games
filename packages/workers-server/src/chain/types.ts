/** Data returned when looking up an agent by wallet address. */
export interface AgentInfo {
  address: string;
  agentId: string; // On-chain uint256 as string, or D1 UUID in mock mode
  name: string;
  credits: string; // Credit balance as string (bigint-safe)
  registered: boolean;
}

/** Parameters for on-chain registration with EIP-2612 USDC permit. */
export interface RegisterParams {
  name: string;
  address: string;
  agentURI: string;
  permitDeadline: number;
  v: number;
  r: string;
  s: string;
}

/** Balance info for an agent. */
export interface BalanceInfo {
  credits: string;
  usdc: string;
}

/** EIP-2612 permit parameters for USDC spending. */
export interface PermitParams {
  deadline: number;
  v: number;
  r: string;
  s: string;
  amount: string;
}

/** Pending burn/withdrawal request. */
export interface BurnRequest {
  pendingAmount: string;
  executeAfter: number;
}

/** Credit delta for game settlement. Per the locked number policy
 *  (`wiki/architecture/contracts.md`), all money values cross the chain
 *  boundary as `bigint`. The on-chain `int256` ABI parameter accepts BigInt
 *  natively via viem; the mock relay simply ignores the field. */
export interface CreditDelta {
  agentId: string;
  delta: bigint;
}

/** Game result for on-chain settlement. */
export interface GameSettlement {
  gameId: string;
  gameType: string;
  playerIds: string[];
  outcome: unknown;
  movesRoot: string;
  configHash: string;
  turnCount: number;
  timestamp: number;
}

/** Settlement receipt. */
export interface SettlementReceipt {
  txHash: string;
}

import type { OnChainRelay } from '../plugins/capabilities.js';

/**
 * ChainRelay — abstraction over on-chain contract interactions.
 * Two implementations: OnChainRelay (viem + real contracts) and MockRelay (D1-backed).
 *
 * Settlement (Phase 3.2) goes through `OnChainRelay` capability methods
 * (`submit` + `pollReceipt`) on the `ChainRelay` instance, driven by
 * `SettlementStateMachine`. The pre-3.2 synchronous `settleGame(result, deltas)`
 * is gone — submit + receipt-poll are now separate so we can survive
 * hibernation between broadcast and confirmation.
 */
export interface ChainRelay extends OnChainRelay {
  // Identity
  getAgentByAddress(address: string): Promise<AgentInfo | null>;
  checkName(name: string): Promise<{ available: boolean }>;
  register(params: RegisterParams): Promise<{ agentId: string; name: string; credits: string }>;

  // Credits
  getBalance(agentId: string): Promise<BalanceInfo>;
  topup(agentId: string, permit: PermitParams): Promise<{ credits: string }>;
  requestBurn(agentId: string, amount: string): Promise<BurnRequest>;
  executeBurn(agentId: string): Promise<{ credits: string }>;
  cancelBurn(agentId: string): Promise<void>;

  // Settlement: see OnChainRelay (submit / pollReceipt).
}
