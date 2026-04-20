/**
 * Tests for the canonical encoder/decoder used to produce deterministic
 * `outcomeBytes` for Merkle leaves and on-chain anchored payloads.
 *
 * Policy under test:
 * - Sorted-key JSON. Insertion order must not change the bytes.
 * - bigint serialized via `{ "__bigint": "<decimal-digits>" }` sentinel.
 * - number must pass `Number.isSafeInteger` — floats / NaN / Infinity rejected.
 * - Non-POJO values (Map, Set, Date, undefined, class instances, functions)
 *   rejected at the encoder boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalDecode,
  canonicalEncode,
  NonIntegerNumberError,
  NonPojoValueError,
} from '../canonical-encoding.js';

const td = new TextDecoder();
const decode = (b: Uint8Array): string => td.decode(b);

describe('canonicalEncode — round-trip', () => {
  it('round-trips primitives', () => {
    for (const v of ['hello', '', true, false, null, 0, 1, -1, 42]) {
      const bytes = canonicalEncode(v);
      expect(canonicalDecode(bytes)).toEqual(v);
    }
  });

  it('round-trips nested objects and arrays', () => {
    const x = {
      name: 'lobster',
      counts: [1, 2, 3],
      nested: { inner: { deep: 'value' }, arr: [{ a: 1 }, { a: 2 }] },
      flag: true,
      empty: null,
    };
    const bytes = canonicalEncode(x);
    expect(canonicalDecode(bytes)).toEqual(x);
  });

  it('round-trips bigints via sentinel form', () => {
    const x = { n: 1234567890n };
    const bytes = canonicalEncode(x);
    expect(canonicalDecode(bytes)).toEqual({ n: 1234567890n });
  });

  it('round-trips a very large bigint past Number.MAX_SAFE_INTEGER', () => {
    const huge = 12345678901234567890n;
    const bytes = canonicalEncode({ n: huge });
    const out = canonicalDecode(bytes) as { n: bigint };
    expect(out.n).toBe(huge);
    expect(typeof out.n).toBe('bigint');
  });

  it('round-trips bigints in arrays and nested under sorted keys', () => {
    const x = {
      players: [
        { id: 'p1', balance: 1000n },
        { id: 'p2', balance: 2000n },
      ],
      pot: 3000n,
    };
    const bytes = canonicalEncode(x);
    expect(canonicalDecode(bytes)).toEqual(x);
  });

  it('idempotent: encode(decode(encode(x))) === encode(x)', () => {
    const x = {
      z: 1n,
      a: [{ b: 2, c: 'x' }, { b: 3 }],
      nested: { y: 5n, x: 6 },
    };
    const first = canonicalEncode(x);
    const second = canonicalEncode(canonicalDecode(first));
    expect(decode(first)).toBe(decode(second));
  });
});

describe('canonicalEncode — determinism (sorted-key)', () => {
  it('produces identical bytes regardless of key insertion order', () => {
    const a = canonicalEncode({ a: 1, b: 2 });
    const b = canonicalEncode({ b: 2, a: 1 });
    expect(decode(a)).toBe(decode(b));
  });

  it('cross-game determinism on nested objects with different insertion orders', () => {
    const left = {
      players: [
        { id: 'p1', score: 10 },
        { id: 'p2', score: 20 },
      ],
      pot: 100n,
      meta: { round: 3, phase: 'final' },
    };
    const right = {
      meta: { phase: 'final', round: 3 },
      pot: 100n,
      players: [
        { score: 10, id: 'p1' },
        { score: 20, id: 'p2' },
      ],
    };
    expect(decode(canonicalEncode(left))).toBe(decode(canonicalEncode(right)));
  });

  it('emits keys in lex-sort order in the JSON string', () => {
    const bytes = canonicalEncode({ z: 1, a: 2, m: 3 });
    expect(decode(bytes)).toBe('{"a":2,"m":3,"z":1}');
  });
});

describe('canonicalEncode — number policy', () => {
  it('throws NonIntegerNumberError on a float', () => {
    expect(() => canonicalEncode({ x: 1.5 })).toThrow(NonIntegerNumberError);
  });

  it('throws on NaN', () => {
    expect(() => canonicalEncode({ x: Number.NaN })).toThrow(NonIntegerNumberError);
  });

  it('throws on +Infinity', () => {
    expect(() => canonicalEncode({ x: Number.POSITIVE_INFINITY })).toThrow(NonIntegerNumberError);
  });

  it('throws on -Infinity', () => {
    expect(() => canonicalEncode({ x: Number.NEGATIVE_INFINITY })).toThrow(NonIntegerNumberError);
  });

  it('throws on a number larger than MAX_SAFE_INTEGER', () => {
    expect(() => canonicalEncode({ x: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      NonIntegerNumberError,
    );
  });

  it('error path includes the offending key', () => {
    try {
      canonicalEncode({ outer: { inner: 1.5 } });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NonIntegerNumberError);
      expect((err as NonIntegerNumberError).path).toBe('outer.inner');
      expect((err as NonIntegerNumberError).value).toBe(1.5);
    }
  });

  it('accepts safe integers, including 0 and negative', () => {
    expect(() => canonicalEncode({ a: 0, b: -42, c: Number.MAX_SAFE_INTEGER })).not.toThrow();
  });
});

describe('canonicalEncode — non-POJO rejection', () => {
  it('throws NonPojoValueError on a Map', () => {
    expect(() => canonicalEncode(new Map([['a', 1]]))).toThrow(NonPojoValueError);
  });

  it('throws on a Set', () => {
    expect(() => canonicalEncode(new Set([1, 2, 3]))).toThrow(NonPojoValueError);
  });

  it('throws on a Date', () => {
    expect(() => canonicalEncode({ when: new Date() })).toThrow(NonPojoValueError);
  });

  it('throws on a function', () => {
    expect(() => canonicalEncode({ fn: () => 1 })).toThrow(NonPojoValueError);
  });

  it('throws on a class instance', () => {
    class Foo {
      x = 1;
    }
    expect(() => canonicalEncode(new Foo())).toThrow(NonPojoValueError);
  });

  it('throws on undefined VALUE in a property', () => {
    expect(() => canonicalEncode({ x: undefined })).toThrow(NonPojoValueError);
  });

  it('throws on top-level undefined', () => {
    expect(() => canonicalEncode(undefined)).toThrow(NonPojoValueError);
  });

  it('does NOT throw on an object with no properties', () => {
    expect(() => canonicalEncode({})).not.toThrow();
    expect(decode(canonicalEncode({}))).toBe('{}');
  });

  it('error path includes the offending key for nested non-POJO', () => {
    try {
      canonicalEncode({ outer: { bag: new Map() } });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NonPojoValueError);
      expect((err as NonPojoValueError).path).toBe('outer.bag');
      expect((err as NonPojoValueError).ctor).toBe('Map');
    }
  });

  it('accepts null-prototype objects as POJO-equivalent', () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.a = 1;
    obj.b = 'x';
    expect(() => canonicalEncode(obj)).not.toThrow();
    expect(decode(canonicalEncode(obj))).toBe('{"a":1,"b":"x"}');
  });
});

describe('canonicalEncode — bigint sentinel form', () => {
  it('serializes a bigint using the {"__bigint":"..."} sentinel', () => {
    const bytes = canonicalEncode({ n: 100n });
    expect(decode(bytes)).toBe('{"n":{"__bigint":"100"}}');
  });

  it('serializes a negative bigint', () => {
    const bytes = canonicalEncode({ n: -7n });
    expect(decode(bytes)).toBe('{"n":{"__bigint":"-7"}}');
  });

  it('serializes 0n distinctly from 0', () => {
    expect(decode(canonicalEncode({ n: 0n }))).toBe('{"n":{"__bigint":"0"}}');
    expect(decode(canonicalEncode({ n: 0 }))).toBe('{"n":0}');
  });
});
