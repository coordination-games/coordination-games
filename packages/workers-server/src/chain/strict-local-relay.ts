import { keccak256, toBytes } from 'viem';
import type {
  ReceiptResult,
  SettlementSubmitPayload,
  SubmitResult,
} from '../plugins/capabilities.js';
import { MockRelay } from './mock-relay.js';

type PlayerRow = { readonly id: string; readonly chain_agent_id: number | null };
type ReceiptRow = { readonly block_number: number };

export class StrictLocalSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictLocalSettlementError';
  }
}

export class StrictLocalRelay extends MockRelay {
  constructor(
    private readonly strictDb: D1Database,
    private readonly treasuryHandle: string | undefined,
  ) {
    super(strictDb);
  }

  override async submit(
    payload: SettlementSubmitPayload,
    opts?: { readonly nonce?: number },
  ): Promise<SubmitResult> {
    await this.ensureReceiptTable();
    const participants = this.validateShape(payload);
    const treasuryId = await this.validateIdentities(payload, participants);
    this.validateEconomics(payload, treasuryId);

    const txHash = this.hashPayload(payload);
    await this.strictDb
      .prepare(
        'INSERT OR IGNORE INTO strict_local_settlement_receipts (tx_hash, block_number) VALUES (?, ?)',
      )
      .bind(txHash, 1)
      .run();
    return { txHash, nonce: opts?.nonce ?? 0 };
  }

  override async pollReceipt(txHash: `0x${string}`): Promise<ReceiptResult> {
    await this.ensureReceiptTable();
    const receipt = await this.strictDb
      .prepare('SELECT block_number FROM strict_local_settlement_receipts WHERE tx_hash = ?')
      .bind(txHash)
      .first<ReceiptRow>();
    return receipt === null
      ? { status: 'pending' }
      : { status: 'confirmed', blockNumber: receipt.block_number };
  }

  private async ensureReceiptTable(): Promise<void> {
    await this.strictDb.exec(
      'CREATE TABLE IF NOT EXISTS strict_local_settlement_receipts (tx_hash TEXT PRIMARY KEY, block_number INTEGER NOT NULL)',
    );
  }

  private validateShape(payload: SettlementSubmitPayload): readonly string[] {
    if (
      !Number.isSafeInteger(payload.turnCount) ||
      payload.turnCount < 0 ||
      payload.turnCount > 0xffff
    ) {
      throw new StrictLocalSettlementError('Settlement turnCount must be a uint16');
    }
    if (payload.playerIds.length === 0 || payload.playerIds.length !== payload.deltas.length) {
      throw new StrictLocalSettlementError(
        'Settlement playerIds and deltas must have the same non-zero length',
      );
    }
    const playerIds = new Set(payload.playerIds);
    if (playerIds.size !== payload.playerIds.length) {
      throw new StrictLocalSettlementError('Settlement participant IDs must be unique');
    }
    for (const [index, delta] of payload.deltas.entries()) {
      if (typeof delta.delta !== 'bigint') {
        throw new StrictLocalSettlementError('Settlement deltas must be bigint values');
      }
      if (delta.agentId !== payload.playerIds[index]) {
        throw new StrictLocalSettlementError(
          'Settlement delta participants must align with playerIds',
        );
      }
    }
    const sum = payload.deltas.reduce((total, delta) => total + delta.delta, 0n);
    if (sum !== 0n) throw new StrictLocalSettlementError('Settlement deltas must be zero-sum');
    return payload.playerIds;
  }

  private async validateIdentities(
    payload: SettlementSubmitPayload,
    participants: readonly string[],
  ): Promise<string | null> {
    const rows = await this.strictDb
      .prepare(
        `SELECT id, chain_agent_id FROM players WHERE id IN (${participants.map(() => '?').join(',')})`,
      )
      .bind(...participants)
      .all<PlayerRow>();
    const registered = new Map((rows.results ?? []).map((row) => [row.id, row.chain_agent_id]));
    const missing = participants.filter(
      (id) => registered.get(id) === undefined || registered.get(id) === null,
    );
    if (missing.length > 0) {
      throw new StrictLocalSettlementError(
        `Settlement participant(s) missing chain_agent_id: ${missing.join(', ')}`,
      );
    }
    if (!this.isTournament(payload)) return null;
    if (this.treasuryHandle === undefined) {
      throw new StrictLocalSettlementError('Tournament settlement requires a configured treasury');
    }
    const treasury = await this.strictDb
      .prepare('SELECT id, chain_agent_id FROM players WHERE handle = ?')
      .bind(this.treasuryHandle)
      .first<PlayerRow>();
    if (treasury === null || treasury.chain_agent_id === null) {
      throw new StrictLocalSettlementError('Configured tournament treasury is not registered');
    }
    if (participants.filter((id) => id === treasury.id).length !== 1) {
      throw new StrictLocalSettlementError(
        'Tournament settlement must include configured treasury exactly once',
      );
    }
    return treasury.id;
  }

  private validateEconomics(payload: SettlementSubmitPayload, treasuryId: string | null): void {
    if (!this.isTournament(payload)) return;
    if (payload.entryCost === undefined || payload.entryCost < 0n) {
      throw new StrictLocalSettlementError(
        'Tournament settlement requires a non-negative frozen entryCost',
      );
    }
    for (const delta of payload.deltas) {
      if (delta.agentId !== treasuryId && delta.delta < -payload.entryCost) {
        throw new StrictLocalSettlementError(
          `Settlement player floor violated for ${delta.agentId}`,
        );
      }
    }
  }

  private isTournament(payload: SettlementSubmitPayload): boolean {
    return payload.tournament === true || payload.horizonReveal !== undefined;
  }

  private hashPayload(payload: SettlementSubmitPayload): `0x${string}` {
    return keccak256(toBytes(canonicalValue(payload)));
  }
}

function canonicalValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalValue(child)}`).join(',')}}`;
  }
  throw new StrictLocalSettlementError(`Unsupported canonical settlement value: ${typeof value}`);
}
