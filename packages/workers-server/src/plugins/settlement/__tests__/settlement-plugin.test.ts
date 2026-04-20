/**
 * Unit tests for the Settlement ServerPlugin (Phase 5.3).
 *
 * The plugin is a thin wrapper around `SettlementStateMachine`; the SM's
 * own behaviour is covered by `__tests__/settlement-state-machine.test.ts`.
 * These tests exercise the plugin contract: capability requirements,
 * `handleCall` routing (`'submit'` / `'state'`), `handleAlarm` routing on
 * the canonical kind, and that errors don't crash the runtime's dispatch.
 */

import type { D1Database, DurableObjectStorage } from '@cloudflare/workers-types';
import type { RelayEnvelope } from '@coordination-games/engine';
import { describe, expect, it, vi } from 'vitest';
import {
  SETTLEMENT_ALARM_KIND,
  type SettlementPayload,
  type SettlementState,
} from '../../../chain/SettlementStateMachine.js';
import {
  type AlarmScheduler,
  type Capabilities,
  NamespacedStorage,
  type OnChainRelay,
  type ReceiptResult,
  type RelayClient,
  type SpectatorViewer,
  type SubmitResult,
} from '../../capabilities.js';
import { ServerPluginRuntime } from '../../runtime.js';
import {
  createSettlementPlugin,
  SETTLEMENT_PLUGIN_ID,
  SettlementUnknownCallError,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeMemoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  const clone = typeof structuredClone === 'function' ? structuredClone : <T>(v: T): T => v;
  // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the subset NamespacedStorage uses
  const stub: any = {
    async get(key: string): Promise<unknown> {
      const v = map.get(key);
      return v === undefined ? undefined : clone(v);
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
  };
  return stub as DurableObjectStorage;
}

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

function makeChainStub(opts: {
  submit?: ({ kind: 'ok'; result: SubmitResult } | { kind: 'throw'; err: unknown })[];
  poll?: ReceiptResult[];
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
      const next = opts.poll?.[i];
      if (!next) throw new Error(`unexpected pollReceipt call #${i}`);
      return next;
    },
  };
}

function buildCaps(opts: {
  storage: DurableObjectStorage;
  chain: OnChainRelay;
  alarms: AlarmScheduler;
}): Capabilities {
  const fakeRelay: RelayClient = {
    publish: vi.fn(async () => {}),
    visibleTo: vi.fn(async (_v: SpectatorViewer) => [] as RelayEnvelope[]),
    since: vi.fn(async (_i: number, _v: SpectatorViewer) => [] as RelayEnvelope[]),
  };
  return {
    storage: new NamespacedStorage(opts.storage, SETTLEMENT_PLUGIN_ID),
    relay: fakeRelay,
    alarms: opts.alarms,
    d1: {} as D1Database,
    // biome-ignore lint/suspicious/noExplicitAny: chain stub typed as OnChainRelay (Capabilities.chain is narrowed at the SM boundary)
    chain: opts.chain as any,
  };
}

const PAYLOAD: SettlementPayload = {
  gameId: 'game-test',
  gameType: 'capture-the-lobster',
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

const ADMIN: SpectatorViewer = { kind: 'admin' };

async function buildRuntime(opts: {
  storage?: DurableObjectStorage;
  chain?: OnChainRelay;
  alarms?: AlarmScheduler & { calls: AlarmCall[] };
}): Promise<{
  runtime: ServerPluginRuntime;
  storage: DurableObjectStorage;
  alarms: AlarmScheduler & { calls: AlarmCall[] };
  chain: OnChainRelay & { submitCalls: number; pollCalls: number };
}> {
  const storage = opts.storage ?? makeMemoryStorage();
  const alarms = opts.alarms ?? makeAlarmRecorder();
  const chain =
    (opts.chain as (OnChainRelay & { submitCalls: number; pollCalls: number }) | undefined) ??
    makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xabc' as `0x${string}`, nonce: 7 } }],
    });
  const caps = buildCaps({ storage, chain, alarms });
  const runtime = new ServerPluginRuntime(caps, { gameId: 'game-test' });
  await runtime.register(createSettlementPlugin());
  return { runtime, storage, alarms, chain };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Settlement ServerPlugin — registration', () => {
  it('declares the canonical id and capability requirements', () => {
    const plugin = createSettlementPlugin();
    expect(plugin.id).toBe(SETTLEMENT_PLUGIN_ID);
    expect(plugin.id).toBe('settlement');
    // Order doesn't matter, but the set MUST equal {storage, chain, alarms}.
    expect([...plugin.requires].sort()).toEqual(['alarms', 'chain', 'storage']);
  });

  it('registers cleanly with a runtime that owns the required caps', async () => {
    const { runtime } = await buildRuntime({});
    expect(runtime.has(SETTLEMENT_PLUGIN_ID)).toBe(true);
  });
});

describe('Settlement ServerPlugin — handleCall', () => {
  it('submit routes to SettlementStateMachine.submit and returns ok', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xfeed' as `0x${string}`, nonce: 3 } }],
    });
    const { runtime } = await buildRuntime({ chain });
    const out = await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'submit', PAYLOAD, ADMIN);
    expect(out).toEqual({ ok: true });
    expect(chain.submitCalls).toBe(1);
  });

  it('state reflects the SM transition to submitted', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xdead' as `0x${string}`, nonce: 9 } }],
    });
    const { runtime } = await buildRuntime({ chain });
    await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'submit', PAYLOAD, ADMIN);
    const out = (await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'state', {}, ADMIN)) as {
      state: SettlementState | null;
    };
    expect(out.state?.kind).toBe('submitted');
    if (out.state?.kind === 'submitted') {
      expect(out.state.txHash).toBe('0xdead');
      expect(out.state.nonce).toBe(9);
    }
  });

  it('state returns null before any submit', async () => {
    const { runtime } = await buildRuntime({});
    const out = (await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'state', {}, ADMIN)) as {
      state: SettlementState | null;
    };
    expect(out.state).toBeNull();
  });

  it('unknown call name throws SettlementUnknownCallError', async () => {
    const { runtime } = await buildRuntime({});
    await expect(
      runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'totally-not-real', {}, ADMIN),
    ).rejects.toBeInstanceOf(SettlementUnknownCallError);
  });

  it('chain.submit failure does not crash the runtime — SM lands in pending with attempts++', async () => {
    // The SM swallows submit errors and transitions to `pending` with bumped
    // attempts (the alarm path drives further retries). The plugin's
    // handleCall therefore still resolves `{ ok: true }`, but the persisted
    // state must reflect the failed attempt — and the runtime must remain
    // operational for follow-up calls.
    const chain = makeChainStub({
      submit: [{ kind: 'throw', err: new Error('connection reset') }],
    });
    const alarms = makeAlarmRecorder();
    const { runtime } = await buildRuntime({ chain, alarms });
    const submitOut = await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'submit', PAYLOAD, ADMIN);
    expect(submitOut).toEqual({ ok: true });

    // Runtime is still operational afterwards.
    const stateOut = (await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'state', {}, ADMIN)) as {
      state: SettlementState | null;
    };
    expect(stateOut.state?.kind).toBe('pending');
    if (stateOut.state?.kind === 'pending') {
      expect(stateOut.state.attempts).toBe(1);
    }
    // SM armed a retry alarm with the canonical kind.
    const sched = alarms.calls.filter((c) => c.op === 'scheduleAt');
    expect(sched.length).toBeGreaterThanOrEqual(1);
    expect(sched[0]).toMatchObject({ kind: SETTLEMENT_ALARM_KIND });
  });

  it('idempotent re-submit: the SM short-circuits when state already exists', async () => {
    // First call kicks off — second call must be a no-op (SM logs "noop" and
    // returns without re-broadcasting). Plugin still resolves `{ ok: true }`.
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0xfeed' as `0x${string}`, nonce: 3 } }],
    });
    const { runtime } = await buildRuntime({ chain });
    await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'submit', PAYLOAD, ADMIN);
    expect(chain.submitCalls).toBe(1);
    await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'submit', PAYLOAD, ADMIN);
    expect(chain.submitCalls).toBe(1); // not 2 — second call short-circuited
  });
});

describe('Settlement ServerPlugin — handleAlarm', () => {
  it('routes the canonical alarm kind to SettlementStateMachine.tick', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0x0123' as `0x${string}`, nonce: 1 } }],
      poll: [{ status: 'confirmed', blockNumber: 42 }],
    });
    const { runtime } = await buildRuntime({ chain });
    await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'submit', PAYLOAD, ADMIN);
    expect(chain.pollCalls).toBe(0);
    await runtime.handleAlarm(SETTLEMENT_ALARM_KIND);
    expect(chain.pollCalls).toBe(1);
    const out = (await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'state', {}, ADMIN)) as {
      state: SettlementState | null;
    };
    expect(out.state?.kind).toBe('confirmed');
  });

  it('ignores alarm kinds it does not own', async () => {
    const chain = makeChainStub({
      submit: [{ kind: 'ok', result: { txHash: '0x0456' as `0x${string}`, nonce: 1 } }],
    });
    const { runtime } = await buildRuntime({ chain });
    await runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'submit', PAYLOAD, ADMIN);
    const beforePolls = chain.pollCalls;
    // Unrelated alarm kind — the plugin should no-op rather than tick.
    await runtime.handleAlarm('deadline');
    expect(chain.pollCalls).toBe(beforePolls);
  });
});
