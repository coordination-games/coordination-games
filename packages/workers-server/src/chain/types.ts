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

/** Credit delta for game settlement. */
export interface CreditDelta {
  agentId: string;
  delta: number;
}

/** Game result for on-chain settlement. */
export interface GameSettlement {
  gameId: string;
  gameType: string;
  playerIds: string[];
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  outcome: any;
  movesRoot: string;
  configHash: string;
  turnCount: number;
  timestamp: number;
}

/** Settlement receipt. */
export interface SettlementReceipt {
  txHash: string;
}

/**
 * ChainRelay — abstraction over on-chain contract interactions.
 * Two implementations: OnChainRelay (viem + real contracts) and MockRelay (D1-backed).
 */
export interface ChainRelay {
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

  // Settlement
  settleGame(result: GameSettlement, deltas: CreditDelta[]): Promise<SettlementReceipt>;
}
