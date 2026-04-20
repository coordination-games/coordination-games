/**
 * SettlementStateMachine unit tests (Phase 3.2).
 *
 * Covers the state-machine paths that production-ready settlement depends
 * on:
 *   - submit() → submitted
 *   - tick() on submitted + confirmed receipt → confirmed (terminal)
 *   - tick() on submitted + RPC blip → submitted (attempts++) +
 *     re-armed alarm with exponential backoff
 *   - tick() exhausting MAX_ATTEMPTS → failed (terminal)
 *   - submit() with AlreadySettled revert → confirmed (idempotent)
 *   - hibernation: rebuild the state machine from the same storage and
 *     verify it picks up where it left off
 */

import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { CTL_GAME_ID } from '@coordination-games/game-ctl';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ATTEMPTS,
  SETTLEMENT_ALARM_KIND,
  type SettlementPayload,
  type SettlementState,
  SettlementStateMachine,
} from '../chain/SettlementStateMachine.js';
import {
  type AlarmScheduler,
  NamespacedStorage,
  type OnChainRelay,
  type ReceiptResult,
  type SubmitResult,
} from '../plugins/capabilities.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeMemoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  // Real DO storage uses structured clone (which preserves BigInt). Use the
  // platform's `structuredClone` so the stub matches DO semantics; falling
  // back to identity if Node lacks it (it's been built-in since 17).
  const clone = typeof structuredClone === 'function' ? structuredClone : <T>(v: T): T => v;
  // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the subset NamespacedStorage uses
  const stub: any = {
    async get(key: string): Promise<unknown> {
      const v = map.get(key);
      if (v === undefined) return undefined;
      return clone(v);
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, clone(value));
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
    async list(opts?: { prefix?: string }): Promise<Map<string, unknown>> {
      const out = new Map<string, unknown>();
      for (const [k, v] of map.entries()) {
        if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v);
      }
      return out;
    },
    _raw: map,
  };
  return stub as DurableObjectStorage;
}

/**
 * Mock alarm scheduler — records every scheduleAt + cancel call so tests
 * can assert backoff progression.
 */
type AlarmCall =
  | { op: 'scheduleAt'; when: number; kind: string; payload: unknown }
  | { op: 'cancel'; kind: string };

function makeAlarmRecorder(): AlarmScheduler & { calls: AlarmCall[] } {
  const calls: AlarmCall[] = [];
  return {
    calls,
    async scheduleAt(when, kind, payload) {
      calls.push({ op: 'scheduleAt', when, kind, payload });
    },
    async cancel(kind) {
      calls.push({ op: 'cancel', kind });
    },
  };
}

/**
 * Programmable OnChainRelay test double. Each call to submit/pollReceipt
 * pulls the next entry from the queued script; missing entries throw so
 * tests fail loud on unintended calls.
 */
type SubmitOutcome = { kind: 'ok'; result: SubmitResult } | { kind: 'throw'; err: unknown };

function makeChainStub(opts: {
  submit?: SubmitOutcome[];
  poll?: ReceiptResult[] | ((calls: number) => ReceiptResult);
}): OnChainRelay & { submitCalls: number; pollCalls: number } {
  let submitCalls = 0;
  let pollCalls = 0;
  return {
    get submitCalls() {
      return submitCalls;
    },
    get pollCalls() {
      return pollCalls;
    },
    async submit(_payload, _opts) {
      const i = submitCalls++;
      const next = opts.submit?.[i];
      if (!next) throw new Error(`unexpected submit call #${i}`);
      if (next.kind === 'throw') throw next.err;
      return next.result;
    },
    async pollReceipt(_txHash) {
      const i = pollCalls++;
      if (typeof opts.poll === 'function') return opts.poll(i);
      const next = opts.poll?.[i];
      if (!next) throw new Error(`unexpected pollReceipt call #${i}`);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Common payload
// ---------------------------------------------------------------------------

const PAYLOAD: SettlementPayload = {
  gameId: 'game-test',
  gameType: CTL_GAME_ID,
  playerIds: ['p1', 'p2'],
  outcome: { winner: 'A' },
  movesRoot: `0x${'1'.repeat(64)}`,
  configHash: `0x${'2'.repeat(64)}`,
  turnCount: 10,
  timestamp: 1_700_000_000_000,
  deltas: [
    { agentId: 'p1', delta: 100n },
    { agentId: 'p2', delta: -100n },
  ],
};

// Helper: build a SM hooked up to the recorders we need.
function buildSm(opts: {
  storage?: DurableObjectStorage;
  chain: OnChainRelay;
  alarms?: AlarmScheduler & { calls: AlarmCall[] };
  log?: (event: string, data: unknown) => void;
}) {
  const storage = opts.storage ?? makeMemoryStorage();
  const alarms = opts.alarms ?? makeAlarmRecorder();
  const log = opts.log ?? (() => {});
  const sm = new SettlementStateMachine({
    storage: new NamespacedStorage(storage, 'settlement'),
    chain: opts.chain,
    alarms,
    log,
  });
  return { sm, storage, alarms, log };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettlementStateMachine — happy path', () => {
  it('submit() with successful chain.submit transitions pending → submitted', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xabc' as `0x${string}`, nonce: 7 } }],
    });
    const { sm, alarms } = buildSm({ chain });

    await sm.submit(PAYLOAD);

    const state = (await sm.getState()) as Extract<SettlementState, { kind: 'submitted' }>;
    expect(state.kind).toBe('submitted');
    expect(state.txHash).toBe('0xabc');
    expect(state.nonce).toBe(7);
    expect(state.attempts).toBe(0);
    // First poll alarm armed (with attempts=0 → backoff = 100ms).
    const sched = alarms.calls.filter((c) => c.op === 'scheduleAt');
    expect(sched.length).toBeGreaterThanOrEqual(1);
    expect(sched[0]).toMatchObject({ kind: SETTLEMENT_ALARM_KIND });
  });

  it('tick() on submitted + confirmed receipt → confirmed (terminal)', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xdef' as `0x${string}`, nonce: 1 } }],
      poll: [{ status: 'confirmed', blockNumber: 12345 }],
    });
    const { sm } = buildSm({ chain });

    await sm.submit(PAYLOAD);
    await sm.tick();

    const state = (await sm.getState()) as Extract<SettlementState, { kind: 'confirmed' }>;
    expect(state.kind).toBe('confirmed');
    expect(state.txHash).toBe('0xdef');
    expect(state.blockNumber).toBe(12345);
  });

  it('tick() on a confirmed (terminal) state is a no-op', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xfff' as `0x${string}`, nonce: 0 } }],
      poll: [{ status: 'confirmed', blockNumber: 1 }],
    });
    const { sm, alarms } = buildSm({ chain });
    await sm.submit(PAYLOAD);
    await sm.tick();
    const before = alarms.calls.length;
    await sm.tick();
    await sm.tick();
    expect(alarms.calls.length).toBe(before); // no further alarms armed
  });
});

describe('SettlementStateMachine — receipt poll retry path', () => {
  it('tick() with pending receipt re-arms alarm with exponential backoff', async () => {
    const polls: ReceiptResult[] = [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'confirmed', blockNumber: 99 },
    ];
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0x111' as `0x${string}`, nonce: 0 } }],
      poll: polls,
    });
    const { sm, alarms } = buildSm({ chain });

    await sm.submit(PAYLOAD);
    const baseTimeBefore = Date.now();
    await sm.tick(); // pending #1 → attempts=1
    await sm.tick(); // pending #2 → attempts=2
    await sm.tick(); // confirmed

    const state = await sm.getState();
    expect(state?.kind).toBe('confirmed');

    // Capture all settlement-kind scheduleAt calls; expected backoffs are
    // 100, 200, 400ms after submit/tick (with attempts=0,1,2).
    const sched = alarms.calls
      .filter((c) => c.op === 'scheduleAt' && c.kind === SETTLEMENT_ALARM_KIND)
      .map((c) => c as AlarmCall & { op: 'scheduleAt' });
    // 1 alarm after submit, 2 alarms after each pending tick = 3 total.
    expect(sched.length).toBe(3);
    // Backoffs should be increasing.
    const deltas = sched.map((s) => s.when - baseTimeBefore);
    const d0 = deltas[0] ?? 0;
    const d1 = deltas[1] ?? 0;
    const d2 = deltas[2] ?? 0;
    expect(d0).toBeGreaterThanOrEqual(100);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it('tick() with thrown RPC error bumps attempts and re-arms alarm', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0x222' as `0x${string}`, nonce: 0 } }],
      poll: () => {
        throw new Error('RPC 502 bad gateway');
      },
    });
    const { sm } = buildSm({ chain });
    await sm.submit(PAYLOAD);
    await sm.tick();
    const state = (await sm.getState()) as Extract<SettlementState, { kind: 'submitted' }>;
    expect(state.kind).toBe('submitted');
    expect(state.attempts).toBe(1);
  });

  it('after MAX_ATTEMPTS pending polls → failed terminal state', async () => {
    // Drive one submit + MAX_ATTEMPTS pending polls.
    const polls: ReceiptResult[] = Array.from({ length: MAX_ATTEMPTS + 1 }, () => ({
      status: 'pending' as const,
    }));
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0x333' as `0x${string}`, nonce: 5 } }],
      poll: polls,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sm, alarms } = buildSm({ chain });

    await sm.submit(PAYLOAD);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await sm.tick();
    }

    const state = (await sm.getState()) as Extract<SettlementState, { kind: 'failed' }>;
    expect(state.kind).toBe('failed');
    expect(state.attempts).toBe(MAX_ATTEMPTS);
    expect(state.lastTxHash).toBe('0x333');
    // No further alarm scheduled after the failed transition.
    // Filter for settlement scheduleAt calls only and verify the count
    // matches MAX_ATTEMPTS - 1 (one per retry before terminal). The submit
    // arms one alarm + each pending tick before terminal arms one. The
    // very last tick (which transitions to failed) MUST NOT arm one.
    const settlementSchedules = alarms.calls.filter(
      (c): c is AlarmCall & { op: 'scheduleAt' } =>
        c.op === 'scheduleAt' && c.kind === SETTLEMENT_ALARM_KIND,
    );
    // submit() arms 1, then each of the first MAX_ATTEMPTS-1 ticks arms 1,
    // and the MAX_ATTEMPTS-th tick is terminal so it arms zero.
    expect(settlementSchedules.length).toBe(MAX_ATTEMPTS);
    // Loud-fail logged
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();

    // tick() on failed is a no-op.
    await sm.tick();
    expect((await sm.getState())?.kind).toBe('failed');
  });
});

describe('SettlementStateMachine — submit retry + idempotency', () => {
  it('submit() with AlreadySettled revert → confirmed (idempotent)', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'throw', err: new Error('execution reverted: AlreadySettled') }],
    });
    const { sm } = buildSm({ chain });
    await sm.submit(PAYLOAD);
    const state = await sm.getState();
    expect(state?.kind).toBe('confirmed');
  });

  it('submit() failure (non-AlreadySettled) bumps attempts and remains pending', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'throw', err: new Error('connection reset') }],
    });
    const { sm } = buildSm({ chain });
    await sm.submit(PAYLOAD);
    const state = (await sm.getState()) as Extract<SettlementState, { kind: 'pending' }>;
    expect(state.kind).toBe('pending');
    expect(state.attempts).toBe(1);
  });
});

describe('SettlementStateMachine — hibernation simulation', () => {
  it('state survives across SM instances built on the same storage', async () => {
    const storage = makeMemoryStorage();

    // First SM: submit + transition to submitted.
    const chain1 = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xabc' as `0x${string}`, nonce: 11 } }],
    });
    const sm1 = buildSm({ storage, chain: chain1 }).sm;
    await sm1.submit(PAYLOAD);
    const stateBefore = (await sm1.getState()) as Extract<SettlementState, { kind: 'submitted' }>;
    expect(stateBefore.kind).toBe('submitted');
    expect(stateBefore.txHash).toBe('0xabc');

    // ----- "Worker hibernates here. Throw away the SM instance." -----

    // Second SM: build fresh, tick the alarm, observe transition → confirmed.
    const chain2 = makeChainStub({
      poll: [{ status: 'confirmed', blockNumber: 42 }],
    });
    const sm2 = buildSm({ storage, chain: chain2 }).sm;
    // Loaded state should match what sm1 wrote.
    const loaded = (await sm2.getState()) as Extract<SettlementState, { kind: 'submitted' }>;
    expect(loaded.txHash).toBe('0xabc');
    expect(loaded.nonce).toBe(11);

    await sm2.tick();
    const final = await sm2.getState();
    expect(final?.kind).toBe('confirmed');
    if (final?.kind === 'confirmed') {
      expect(final.blockNumber).toBe(42);
    }
    // sm2 must not have re-submitted (chain2.submit was never queued)
    expect(chain2.submitCalls).toBe(0);
  });

  it('submit() is idempotent across instances — does not re-broadcast on re-submit', async () => {
    const storage = makeMemoryStorage();
    const chain1 = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xfeed' as `0x${string}`, nonce: 3 } }],
    });
    const sm1 = buildSm({ storage, chain: chain1 }).sm;
    await sm1.submit(PAYLOAD);

    // Second SM: simulate the kickoff being re-invoked (e.g. DO crash + re-init).
    // chain2 has zero submit entries — if submit() tried to re-broadcast the
    // test would throw.
    const chain2 = makeChainStub({});
    const sm2 = buildSm({ storage, chain: chain2 }).sm;
    await sm2.submit(PAYLOAD);
    expect(chain2.submitCalls).toBe(0);
  });
});
