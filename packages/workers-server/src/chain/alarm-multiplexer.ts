/**
 * Alarm multiplexer (Phase 3.2).
 *
 * Cloudflare Durable Objects expose a single alarm slot per object — calling
 * `storage.setAlarm(when)` overwrites any previously scheduled alarm. Phase
 * 3.2 introduces a second alarm consumer (the settlement state machine) to a
 * DO that already uses alarms for turn deadlines, so we need to multiplex
 * the slot.
 *
 * Storage shape: a single `alarm:queue` key holds a sorted (ascending `when`)
 * array of `{ when, kind, payload }` entries. The DO's `alarm()` callback
 * pops every due entry, dispatches by `kind`, then re-arms the slot to the
 * earliest remaining `when`.
 *
 * The mux deliberately does not assume Date.now() at schedule-time — the DO
 * calls `storage.setAlarm(...)` from outside, after `schedule(...)` resolves,
 * so the runtime never sees a queue with a head that doesn't match the alarm
 * slot. (The DO wires this in `GameRoomDO.scheduleAlarmEntry` and after
 * dispatch in `alarm()`.)
 */

import type { DurableObjectStorage } from '@cloudflare/workers-types';

/** Single queued alarm entry. */
export type AlarmEntry = {
  /** ms since epoch — the `when` argument that DO `storage.setAlarm` expects. */
  when: number;
  /** Caller-defined kind tag; used by the DO to route to the right handler. */
  kind: string;
  /** Caller-defined payload, persisted as-is via DO storage's structured clone. */
  payload: unknown;
};

export interface AlarmMux {
  /** Add `entry` to the queue. Sorted insert by `when` (ascending). */
  schedule(entry: AlarmEntry): Promise<void>;
  /** Remove every entry whose `kind` matches. */
  cancelKind(kind: string): Promise<void>;
  /** Remove + return all entries with `when <= now`, leaving later ones queued. */
  popDue(now: number): Promise<AlarmEntry[]>;
  /** Earliest remaining `when`, or null if the queue is empty. */
  earliestWhen(): Promise<number | null>;
}

/**
 * DO-storage-backed multiplexer. The whole queue lives at one key; we read
 * + write the full array on every operation. This is fine for the expected
 * cardinality (≤ a handful of in-flight entries per DO) and avoids splitting
 * a single logical queue into separately-evolving keys.
 */
export class StorageAlarmMux implements AlarmMux {
  static readonly KEY = 'alarm:queue';

  constructor(private readonly storage: DurableObjectStorage) {}

  async schedule(entry: AlarmEntry): Promise<void> {
    const q = await this.load();
    q.push(entry);
    q.sort((a, b) => a.when - b.when);
    await this.storage.put(StorageAlarmMux.KEY, q);
  }

  async cancelKind(kind: string): Promise<void> {
    const q = await this.load();
    const filtered = q.filter((e) => e.kind !== kind);
    if (filtered.length === q.length) return; // no change → no write
    await this.storage.put(StorageAlarmMux.KEY, filtered);
  }

  async popDue(now: number): Promise<AlarmEntry[]> {
    const q = await this.load();
    if (q.length === 0) return [];
    const due = q.filter((e) => e.when <= now);
    if (due.length === 0) return [];
    const remaining = q.filter((e) => e.when > now);
    await this.storage.put(StorageAlarmMux.KEY, remaining);
    return due;
  }

  async earliestWhen(): Promise<number | null> {
    const q = await this.load();
    if (q.length === 0) return null;
    const first = q[0];
    // Sorted invariant guarantees first !== undefined after length check.
    return first === undefined ? null : first.when;
  }

  private async load(): Promise<AlarmEntry[]> {
    return (await this.storage.get<AlarmEntry[]>(StorageAlarmMux.KEY)) ?? [];
  }
}
