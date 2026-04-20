import { resolvePlayer } from '../db/player.js';
import type {
  ReceiptResult,
  SettlementSubmitPayload,
  SubmitResult,
} from '../plugins/capabilities.js';
import type {
  AgentInfo,
  BalanceInfo,
  BurnRequest,
  ChainRelay,
  PermitParams,
  RegisterParams,
} from './types.js';

/**
 * In-memory dev/test relay.
 *
 * MockRelay does NOT track credit balances: `getAgentByAddress` / `getBalance`
 * always return `credits: '0'`, `topup` / `requestBurn` / `executeBurn` throw
 * ("Credits not available in mock mode"), and `submit` is a no-op that
 * discards the deltas after returning a fake tx hash. Because of that, the
 * 6-decimal scaling applied in `GameRoomDO.kickOffSettlement` (see
 * `CREDIT_SCALE` in `@coordination-games/engine`) has no observable effect
 * here — scaled or unscaled, the numbers go nowhere.
 *
 * Consequence: in-memory mode stays internally consistent whether deltas are
 * scaled or not, which is why the pre-scaling bug was silent. On-chain mode
 * is the only path where the scale mismatch would corrupt balances, and
 * that path is fixed at the settlement boundary.
 */
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

  /**
   * Mock settlement submit — no-op, return a deterministic fake tx hash so
   * the state machine can observe it through `pollReceipt`.
   * The "nonce" is a monotonic counter scoped to this MockRelay instance.
   */
  private _mockNonce = 0;
  async submit(
    _payload: SettlementSubmitPayload,
    opts?: { nonce?: number },
  ): Promise<SubmitResult> {
    const nonce = opts?.nonce ?? this._mockNonce++;
    const txHash = `0x${'0'.repeat(63)}${(nonce & 0xf).toString(16)}` as `0x${string}`;
    return { txHash, nonce };
  }

  async pollReceipt(_txHash: `0x${string}`): Promise<ReceiptResult> {
    // Mock mode: every submitted tx is instantly "confirmed" at block 0 so
    // local-dev settlement never sits in the submitted state forever.
    return { status: 'confirmed', blockNumber: 0 };
  }
}
