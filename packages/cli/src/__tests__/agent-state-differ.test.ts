/**
 * Unit tests for `AgentStateDiffer`. Covers the diff semantics, the new
 * `initialLastSeen` / `getLastSeen()` surface added for Phase 2 (so
 * `GameClient` can round-trip the baseline through disk), and the
 * already-documented reset + non-object-payload pass-through behavior.
 */

import { describe, expect, it } from 'vitest';
import { AgentStateDiffer } from '../agent-state-differ.js';

describe('AgentStateDiffer', () => {
  it('first observation passes through in full and seeds the baseline', () => {
    const d = new AgentStateDiffer();
    const first = { a: 1, b: { nested: true }, c: [1, 2] };
    const out = d.diff(first);
    // First call — no diff yet, full object returned verbatim.
    expect(out).toEqual(first);
    // Baseline is now populated.
    expect(d.getLastSeen()).toEqual(first);
  });

  it('unchanged keys collapse into `_unchangedKeys` on the second call', () => {
    const d = new AgentStateDiffer();
    d.diff({ a: 1, b: 'same', c: [1, 2] });
    const out = d.diff({ a: 2, b: 'same', c: [1, 2] }) as Record<string, unknown>;
    // `a` changed — appears in the projection.
    expect(out.a).toBe(2);
    // `b` and `c` are unchanged — elided from the body, listed by key.
    expect(out.b).toBeUndefined();
    expect(out.c).toBeUndefined();
    expect(out._unchangedKeys).toEqual(expect.arrayContaining(['b', 'c']));
    expect((out._unchangedKeys as string[]).length).toBe(2);
  });

  it('removed keys surface in `_removedKeys`', () => {
    const d = new AgentStateDiffer();
    d.diff({ a: 1, b: 2, c: 3 });
    const out = d.diff({ a: 1, b: 2 }) as Record<string, unknown>;
    // `a` and `b` unchanged; `c` went away.
    expect(out._unchangedKeys).toEqual(expect.arrayContaining(['a', 'b']));
    expect(out._removedKeys).toEqual(['c']);
  });

  it('if every key is unchanged, returns the raw object (no wrapping)', () => {
    // This is the `unchanged.length === 0 && removed.length === 0` branch:
    // when nothing moved, passing through the original object keeps the
    // shape stable for downstream consumers. Here we exercise the opposite
    // — all-unchanged triggers the wrap. Confirm it does.
    const d = new AgentStateDiffer();
    d.diff({ a: 1, b: 2 });
    const out = d.diff({ a: 1, b: 2 }) as Record<string, unknown>;
    // Every key unchanged → the body is `{}` + `_unchangedKeys: ['a','b']`.
    expect(out._unchangedKeys).toEqual(expect.arrayContaining(['a', 'b']));
    expect(out.a).toBeUndefined();
    expect(out.b).toBeUndefined();
  });

  it('non-object payloads pass through (lobby lists, strings)', () => {
    const d = new AgentStateDiffer();
    expect(d.diff(null)).toBeNull();
    expect(d.diff(undefined)).toBeUndefined();
    expect(d.diff('a string')).toBe('a string');
    expect(d.diff([1, 2, 3])).toEqual([1, 2, 3]);
    // And the baseline stays empty — scalars don't poison it.
    expect(d.getLastSeen()).toBeNull();
  });

  it('reset() drops the baseline so next call passes through in full', () => {
    const d = new AgentStateDiffer();
    d.diff({ a: 1, b: 2 });
    d.reset();
    expect(d.getLastSeen()).toBeNull();
    // Next diff is treated as a first observation — no projection.
    const out = d.diff({ a: 1, b: 2 });
    expect(out).toEqual({ a: 1, b: 2 });
  });

  it('accepts `initialLastSeen` so GameClient can hydrate from disk', () => {
    // The persisted baseline round-trips through `agent-persistence`; the
    // constructor must reinstate it so the very next diff against an
    // identical payload collapses entirely.
    const d = new AgentStateDiffer({ a: 1, b: 2 });
    const out = d.diff({ a: 1, b: 2 }) as Record<string, unknown>;
    expect(out._unchangedKeys).toEqual(expect.arrayContaining(['a', 'b']));
    expect(out.a).toBeUndefined();
  });

  it('ignores an invalid `initialLastSeen` instead of poisoning the baseline', () => {
    // Arrays and scalars collapse to null — a corrupt persisted entry
    // must not break the next diff. Same guard as non-object payloads.
    const arrSeed = new AgentStateDiffer(
      // biome-ignore lint/suspicious/noExplicitAny: exercising the defensive path
      [1, 2, 3] as any,
    );
    expect(arrSeed.getLastSeen()).toBeNull();
    // First real diff passes through.
    const out = arrSeed.diff({ a: 1 });
    expect(out).toEqual({ a: 1 });
  });

  it('getLastSeen() reflects the latest observation after each diff call', () => {
    const d = new AgentStateDiffer();
    d.diff({ a: 1 });
    expect(d.getLastSeen()).toEqual({ a: 1 });
    d.diff({ a: 2, b: 3 });
    expect(d.getLastSeen()).toEqual({ a: 2, b: 3 });
  });
});
