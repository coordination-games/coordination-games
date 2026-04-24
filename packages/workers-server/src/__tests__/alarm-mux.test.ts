/**
 * StorageAlarmMux unit tests (Phase 3.2).
 *
 * The mux is the only thing standing between two DO alarm consumers (turn
 * deadlines + settlement state machine) and a clobbered alarm slot. These
 * tests pin the queue mechanics: sorted insert, pop-due splits, cancel by
 * kind, earliest-when reads.
 */

import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { type AlarmEntry, StorageAlarmMux } from '../chain/alarm-multiplexer.js';

function makeMemoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  const stub = {
    async get(key: string): Promise<unknown> {
      // structuredClone-equivalent for arrays — DO storage doesn't share
      // refs across get/put either.
      const v = map.get(key);
      if (v === undefined) return undefined;
      return JSON.parse(JSON.stringify(v));
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
  };
  return stub as unknown as DurableObjectStorage;
}

describe('StorageAlarmMux', () => {
  it('schedules entries sorted by `when` (ascending)', async () => {
    const mux = new StorageAlarmMux(makeMemoryStorage());
    await mux.schedule({ when: 300, kind: 'a', payload: 1 });
    await mux.schedule({ when: 100, kind: 'b', payload: 2 });
    await mux.schedule({ when: 200, kind: 'c', payload: 3 });
    expect(await mux.earliestWhen()).toBe(100);
    const due = await mux.popDue(1000);
    expect(due.map((e) => e.when)).toEqual([100, 200, 300]);
  });

  it('popDue returns only entries with `when <= now` and removes them', async () => {
    const mux = new StorageAlarmMux(makeMemoryStorage());
    await mux.schedule({ when: 100, kind: 'a', payload: null });
    await mux.schedule({ when: 200, kind: 'b', payload: null });
    await mux.schedule({ when: 300, kind: 'c', payload: null });

    const due = await mux.popDue(200);
    expect(due.map((e) => e.kind)).toEqual(['a', 'b']);

    // Remaining entries still queued
    expect(await mux.earliestWhen()).toBe(300);
    const remaining = await mux.popDue(500);
    expect(remaining.map((e) => e.kind)).toEqual(['c']);
    expect(await mux.earliestWhen()).toBeNull();
  });

  it('popDue is a no-op when nothing is due (does not write empty queue)', async () => {
    const mux = new StorageAlarmMux(makeMemoryStorage());
    await mux.schedule({ when: 1000, kind: 'future', payload: null });
    const due = await mux.popDue(0);
    expect(due).toEqual([]);
    expect(await mux.earliestWhen()).toBe(1000);
  });

  it('cancelKind removes only entries of the matching kind', async () => {
    const mux = new StorageAlarmMux(makeMemoryStorage());
    await mux.schedule({ when: 100, kind: 'deadline', payload: 'd1' });
    await mux.schedule({ when: 200, kind: 'settlement', payload: 's1' });
    await mux.schedule({ when: 300, kind: 'deadline', payload: 'd2' });
    await mux.schedule({ when: 400, kind: 'settlement', payload: 's2' });

    await mux.cancelKind('deadline');
    const remaining = await mux.popDue(10_000);
    expect(remaining.map((e) => e.kind)).toEqual(['settlement', 'settlement']);
    expect(remaining.map((e) => e.payload)).toEqual(['s1', 's2']);
  });

  it('cancelKind on an empty queue is a safe no-op', async () => {
    const mux = new StorageAlarmMux(makeMemoryStorage());
    await mux.cancelKind('anything');
    expect(await mux.earliestWhen()).toBeNull();
  });

  it('earliestWhen returns null on an empty queue', async () => {
    const mux = new StorageAlarmMux(makeMemoryStorage());
    expect(await mux.earliestWhen()).toBeNull();
  });

  it('queue survives across mux instances on the same storage', async () => {
    // Hibernation-equivalent: drop the mux instance, build a new one from
    // the same storage, and verify the queue is intact.
    const storage = makeMemoryStorage();
    const muxA = new StorageAlarmMux(storage);
    await muxA.schedule({ when: 500, kind: 'settlement', payload: { round: 1 } });
    await muxA.schedule({ when: 100, kind: 'deadline', payload: { turn: 7 } });

    const muxB = new StorageAlarmMux(storage);
    expect(await muxB.earliestWhen()).toBe(100);
    const due = await muxB.popDue(1000);
    expect(due.length).toBe(2);
    expect(due[0]?.kind).toBe('deadline');
    expect(due[1]?.kind).toBe('settlement');
  });

  it('preserves arbitrary payload shapes through a put/get round-trip', async () => {
    const mux = new StorageAlarmMux(makeMemoryStorage());
    const payload: AlarmEntry['payload'] = {
      action: { type: 'tick', turn: 3 },
      deadlineMs: 12345,
      nested: [1, 2, { foo: 'bar' }],
    };
    await mux.schedule({ when: 50, kind: 'deadline', payload });
    const due = await mux.popDue(100);
    expect(due[0]?.payload).toEqual(payload);
  });
});
