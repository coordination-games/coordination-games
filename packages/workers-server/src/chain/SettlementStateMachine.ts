/**
 * SettlementStateMachine (Phase 3.2).
 *
 * Survives Worker hibernation and RPC failure. Persists its state to
 * `caps.storage` and re-arms an alarm via `caps.alarms` until the on-chain
 * settlement reaches a terminal state.
 *
 * State machine:
 *
 *     pending ─submit→ submitted ─pollReceipt→ confirmed   (terminal)
 *                  │              │
 *                  │              └────────→ failed         (terminal,
 *                  │                                       attempts ≥ MAX)
 *                  └─AlreadySettled→ confirmed              (idempotent)
 *
 * On `submit()` the machine writes a `pending` snapshot, then calls
 * `chain.submit` once (pinning a nonce). On success it transitions to
 * `submitted` and arms a poll alarm. The alarm's `tick()` polls for the
 * receipt; pending → reschedule with backoff, confirmed → terminal,
 * reverted → retry up to MAX_ATTEMPTS, then `failed`.
 *
 * Runtime-agnostic by construction: deps are a `Pick<Capabilities, ...>`,
 * not the DO. Phase 5.3 wraps this in a `ServerPlugin` with zero logic
 * change.
 */

import type {
  Capabilities,
  ReceiptResult,
  SettlementSubmitPayload,
  SubmitResult,
} from '../plugins/capabilities.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SettlementState =
  | { kind: 'pending'; computedAt: number; attempts: number }
  | {
      kind: 'submitted';
      txHash: `0x${string}`;
      submittedAt: number;
      nonce: number;
      attempts: number;
      computedAt: number;
    }
  | {
      kind: 'confirmed';
      txHash: `0x${string}`;
      blockNumber: number;
      computedAt: number;
      confirmedAt: number;
    }
  | {
      kind: 'failed';
      reason: string;
      lastTxHash?: `0x${string}`;
      attempts: number;
      computedAt: number;
      failedAt: number;
    };

/**
 * The shape the state machine submits. Identical to the chain-cap shape;
 * re-exported for callers that build the payload but don't import chain
 * internals directly.
 */
export type SettlementPayload = SettlementSubmitPayload;

export type SettlementDeps = Pick<Capabilities, 'storage' | 'chain' | 'alarms'> & {
  /**
   * Structured log sink. Implementations forward to console.log /
   * console.error / a metrics emitter as appropriate. Failed-terminal logs
   * call this with event=`settlement.failed` plus a separate console.error
   * inside the state machine so monitoring can page.
   */
  log: (event: string, data: unknown) => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Alarm kind used by the multiplexer to route firings here. */
export const SETTLEMENT_ALARM_KIND = 'settlement';

/** Cap on receipt-poll retries before transitioning to `failed`. */
export const MAX_ATTEMPTS = 10;

/** Backoff base + cap. `100ms * 2^attempts`, clamped at 30s. */
const BACKOFF_BASE_MS = 100;
const BACKOFF_MAX_MS = 30_000;

function backoffMs(attempts: number): number {
  // attempts=0 → 100ms, 1→200ms, ... 8→25.6s, 9+→30s.
  const raw = BACKOFF_BASE_MS * 2 ** attempts;
  return Math.min(raw, BACKOFF_MAX_MS);
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export class SettlementStateMachine {
  static readonly STATE_KEY = 'settlement:state';
  static readonly PAYLOAD_KEY = 'settlement:payload';

  constructor(private readonly deps: SettlementDeps) {}

  /**
   * Read the current persisted state. Returns null if the machine has
   * never been kicked off for this game.
   */
  async getState(): Promise<SettlementState | null> {
    return (await this.deps.storage.get<SettlementState>(SettlementStateMachine.STATE_KEY)) ?? null;
  }

  /**
   * Initial transition: write `pending`, persist payload, immediately try
   * the first submit. On success transitions to `submitted` and arms a
   * receipt-poll alarm. On submit failure stores `pending` with `attempts++`
   * and arms an alarm to retry; once `attempts ≥ MAX_ATTEMPTS` transitions
   * to `failed`.
   *
   * Idempotent w.r.t. multiple calls: if a non-terminal state already
   * exists, returns without re-submitting (the alarm path will drive it).
   */
  async submit(payload: SettlementPayload): Promise<void> {
    const existing = await this.getState();
    if (existing && existing.kind !== 'pending') {
      // Already in motion (submitted) or terminal (confirmed/failed). The
      // alarm path is the source of truth; return without doing anything.
      this.deps.log('settlement.submit.noop', { existing: existing.kind });
      return;
    }

    const computedAt = existing?.computedAt ?? Date.now();
    const initial: SettlementState = { kind: 'pending', computedAt, attempts: 0 };
    await this.deps.storage.put(SettlementStateMachine.STATE_KEY, initial);
    await this.deps.storage.put(SettlementStateMachine.PAYLOAD_KEY, this.serializePayload(payload));
    this.deps.log('settlement.state.transition', {
      from: 'init',
      to: 'pending',
      attempts: 0,
      msSinceComputed: 0,
    });

    // First submit attempt. Doesn't pass a nonce — the chain adapter pulls
    // one from the relayer's pending tx count.
    await this.attemptSubmit(payload, /* attempts */ 0, /* nonce */ undefined);
  }

  /**
   * Alarm-driven step. The alarm multiplexer dispatches to this when a
   * `kind: 'settlement'` entry pops. Idempotent across hibernation.
   */
  async tick(): Promise<void> {
    const state = await this.getState();
    if (!state) {
      // No settlement in flight. Probably a stale alarm from a deleted
      // game. Quiet exit.
      return;
    }

    switch (state.kind) {
      case 'pending': {
        // First-submit retry path. Re-load the payload and try again.
        const payload = await this.loadPayload();
        if (!payload) {
          this.deps.log('settlement.error', { reason: 'pending state lost payload' });
          await this.transitionTo({
            kind: 'failed',
            reason: 'lost payload',
            attempts: state.attempts,
            computedAt: state.computedAt,
            failedAt: Date.now(),
          });
          return;
        }
        await this.attemptSubmit(payload, state.attempts, /* nonce */ undefined);
        return;
      }
      case 'submitted': {
        await this.attemptPoll(state);
        return;
      }
      case 'confirmed':
      case 'failed':
        return; // terminal
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — submit / poll attempts
  // ---------------------------------------------------------------------------

  private async attemptSubmit(
    payload: SettlementPayload,
    attempts: number,
    nonce: number | undefined,
  ): Promise<void> {
    let result: SubmitResult;
    try {
      // exactOptionalPropertyTypes: pass `{}` (no key) when nonce is missing
      // rather than `{ nonce: undefined }`, which the OnChainRelay type
      // rejects.
      const submitOpts = nonce === undefined ? undefined : { nonce };
      result = await this.deps.chain.submit(payload, submitOpts);
    } catch (err) {
      const nextAttempts = attempts + 1;
      const reason = String(err instanceof Error ? err.message : err);
      // Detect the contract revert that means a previous submit landed.
      if (this.isAlreadySettledError(err)) {
        await this.transitionTo({
          kind: 'confirmed',
          // We don't know the original tx hash here (it was on a prior
          // submit attempt that beat us). Use the zero hash as a sentinel.
          txHash: `0x${'0'.repeat(64)}` as `0x${string}`,
          blockNumber: 0,
          computedAt: payload && (await this.computedAtOrNow()),
          confirmedAt: Date.now(),
        });
        this.deps.log('settlement.idempotent', { reason });
        return;
      }
      this.deps.log('settlement.submit.error', { reason, attempts: nextAttempts });
      if (nextAttempts >= MAX_ATTEMPTS) {
        await this.transitionToFailed(reason, undefined, nextAttempts);
        return;
      }
      await this.transitionTo({
        kind: 'pending',
        computedAt: await this.computedAtOrNow(),
        attempts: nextAttempts,
      });
      await this.scheduleNextPoll(nextAttempts);
      return;
    }

    const computedAt = await this.computedAtOrNow();
    await this.transitionTo({
      kind: 'submitted',
      txHash: result.txHash,
      submittedAt: Date.now(),
      nonce: result.nonce,
      attempts: 0,
      computedAt,
    });
    // Schedule the first receipt poll. Pollers run on the same backoff
    // schedule as submit retries, but attempt count is reset because
    // submit succeeded.
    await this.scheduleNextPoll(0);
  }

  private async attemptPoll(state: Extract<SettlementState, { kind: 'submitted' }>): Promise<void> {
    let receipt: ReceiptResult;
    try {
      receipt = await this.deps.chain.pollReceipt(state.txHash);
    } catch (err) {
      // Treat as transient pending-with-attempt-bump. RPC may be flapping.
      const nextAttempts = state.attempts + 1;
      const reason = String(err instanceof Error ? err.message : err);
      this.deps.log('settlement.poll.error', { reason, attempts: nextAttempts });
      if (nextAttempts >= MAX_ATTEMPTS) {
        await this.transitionToFailed(reason, state.txHash, nextAttempts);
        return;
      }
      await this.transitionTo({ ...state, attempts: nextAttempts });
      await this.scheduleNextPoll(nextAttempts);
      return;
    }

    if (receipt.status === 'pending') {
      const nextAttempts = state.attempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        await this.transitionToFailed('receipt poll exhausted', state.txHash, nextAttempts);
        return;
      }
      await this.transitionTo({ ...state, attempts: nextAttempts });
      await this.scheduleNextPoll(nextAttempts);
      return;
    }
    if (receipt.status === 'confirmed' || receipt.status === 'already-settled') {
      await this.transitionTo({
        kind: 'confirmed',
        txHash: state.txHash,
        blockNumber: receipt.status === 'confirmed' ? receipt.blockNumber : 0,
        computedAt: state.computedAt,
        confirmedAt: Date.now(),
      });
      return;
    }
    // Reverted. If we have attempts left, retry by re-submitting (a new
    // nonce will be picked up because the previous tx is on-chain).
    const nextAttempts = state.attempts + 1;
    const reason = receipt.reason ?? 'reverted';
    if (nextAttempts >= MAX_ATTEMPTS) {
      await this.transitionToFailed(reason, state.txHash, nextAttempts);
      return;
    }
    // Drop to pending so the next tick re-submits (with a fresh nonce).
    await this.transitionTo({
      kind: 'pending',
      computedAt: state.computedAt,
      attempts: nextAttempts,
    });
    await this.scheduleNextPoll(nextAttempts);
  }

  // ---------------------------------------------------------------------------
  // Internal — state transitions + persistence
  // ---------------------------------------------------------------------------

  private async transitionTo(next: SettlementState): Promise<void> {
    const prev = await this.getState();
    await this.deps.storage.put(SettlementStateMachine.STATE_KEY, next);
    const msSinceComputed =
      next.kind === 'failed' || next.kind === 'confirmed' || next.kind === 'submitted'
        ? Date.now() - next.computedAt
        : Date.now() - next.computedAt;
    this.deps.log('settlement.state.transition', {
      from: prev?.kind ?? 'init',
      to: next.kind,
      txHash:
        next.kind === 'submitted'
          ? next.txHash
          : next.kind === 'confirmed'
            ? next.txHash
            : next.kind === 'failed'
              ? next.lastTxHash
              : undefined,
      attempts:
        next.kind === 'submitted' || next.kind === 'pending' || next.kind === 'failed'
          ? next.attempts
          : 0,
      msSinceComputed,
    });
  }

  private async transitionToFailed(
    reason: string,
    lastTxHash: `0x${string}` | undefined,
    attempts: number,
  ): Promise<void> {
    const computedAt = await this.computedAtOrNow();
    // exactOptionalPropertyTypes: omit `lastTxHash` rather than setting it
    // to `undefined`.
    const failed: SettlementState =
      lastTxHash === undefined
        ? {
            kind: 'failed',
            reason,
            attempts,
            computedAt,
            failedAt: Date.now(),
          }
        : {
            kind: 'failed',
            reason,
            lastTxHash,
            attempts,
            computedAt,
            failedAt: Date.now(),
          };
    await this.transitionTo(failed);
    // Loud — monitoring should page on this.
    console.error(
      `[settlement.failed] reason="${reason}" lastTxHash=${lastTxHash ?? '-'} attempts=${attempts}`,
    );
  }

  private async scheduleNextPoll(attempts: number): Promise<void> {
    const when = Date.now() + backoffMs(attempts);
    await this.deps.alarms.scheduleAt(when, SETTLEMENT_ALARM_KIND, null);
  }

  /** Loads the existing computedAt (it should always exist post-submit). */
  private async computedAtOrNow(): Promise<number> {
    const cur = await this.getState();
    if (cur && 'computedAt' in cur && typeof cur.computedAt === 'number') return cur.computedAt;
    return Date.now();
  }

  /**
   * BigInt isn't JSON-serializable but DO storage uses structured clone
   * which DOES preserve BigInt — so we can persist the payload as-is. We
   * still pass through this helper so the boundary is single-purpose if
   * the storage backend ever changes.
   */
  private serializePayload(payload: SettlementPayload): SettlementPayload {
    return payload;
  }

  private async loadPayload(): Promise<SettlementPayload | null> {
    return (
      (await this.deps.storage.get<SettlementPayload>(SettlementStateMachine.PAYLOAD_KEY)) ?? null
    );
  }

  /**
   * Best-effort detection of the contract's `AlreadySettled` revert. The
   * chain adapter may report this two ways:
   *   - A thrown `ContractFunctionExecutionError` from viem (submit path).
   *   - A `pollReceipt` returning `{ status: 'already-settled' }`.
   * The poll path is handled directly in `attemptPoll`; here we sniff the
   * thrown error.
   */
  private isAlreadySettledError(err: unknown): boolean {
    const msg = String(err instanceof Error ? err.message : err);
    // Selectors / names viem typically surfaces; keep loose to survive
    // viem version changes.
    return /AlreadySettled/i.test(msg);
  }
}
