/**
 * Canonical encoder/decoder for deterministic outcome bytes.
 *
 * Goal: produce identical bytes for semantically-identical values, regardless
 * of object insertion order. This is the engine boundary for any payload that
 * gets hashed (Merkle leaves, `outcomeBytes`, on-chain anchored state).
 *
 * Number policy (locked, see `wiki/architecture/contracts.md`):
 * - Money values: `bigint` always (cents, satoshi-style fixed point). Serialized
 *   as `{ "__bigint": "<decimal-digits>" }` — object sentinel, stable across
 *   versions, no `n`-suffix string ambiguity.
 * - Counts / indices: `number`, but MUST pass `Number.isSafeInteger`.
 * - Floats / `NaN` / `Infinity`: rejected with `NonIntegerNumberError`.
 * - Non-POJO values (`Map`, `Set`, `Date`, `undefined`, class instances,
 *   functions): rejected with `NonPojoValueError`. Games convert to POJO
 *   before hashing.
 *
 * Round-trip property: `encode(decode(encode(x))) === encode(x)` (byte-equal).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NonIntegerNumberError extends Error {
  constructor(
    public path: string,
    public value: unknown,
  ) {
    super(`Non-integer number at ${path}: ${String(value)}`);
    this.name = 'NonIntegerNumberError';
  }
}

export class NonPojoValueError extends Error {
  constructor(
    public path: string,
    public ctor: string,
  ) {
    super(`Non-POJO value at ${path}: ${ctor}`);
    this.name = 'NonPojoValueError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const BIGINT_SENTINEL = '__bigint';

/** Returns true iff `x` is a plain object literal (POJO) or null-prototype object. */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== 'object') return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/** Describe a value's constructor for error messages. */
function describeCtor(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return t;
  const proto = Object.getPrototypeOf(value as object);
  if (proto?.constructor?.name) return proto.constructor.name;
  return Object.prototype.toString.call(value);
}

/** Detect the bigint sentinel object: `{ __bigint: "<decimal-digits>" }`. */
function isBigintSentinel(x: unknown): x is { [BIGINT_SENTINEL]: string } {
  if (!isPlainObject(x)) return false;
  const keys = Object.keys(x);
  if (keys.length !== 1 || keys[0] !== BIGINT_SENTINEL) return false;
  const v = (x as Record<string, unknown>)[BIGINT_SENTINEL];
  return typeof v === 'string' && /^-?\d+$/.test(v);
}

/**
 * Recursively convert `value` into a JSON-serializable form with:
 * - sorted object keys
 * - bigint replaced by `{ __bigint: "<decimal-digits>" }`
 * - strict validation per the number/POJO policy
 */
function toCanonical(value: unknown, path: string): unknown {
  // bigint → sentinel object
  if (typeof value === 'bigint') {
    return { [BIGINT_SENTINEL]: value.toString(10) };
  }

  // Reject NaN/Infinity/non-integer numbers
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new NonIntegerNumberError(path, value);
    }
    return value;
  }

  // Primitives we accept as-is
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;

  // undefined is not representable in JSON; reject loudly
  if (value === undefined) {
    throw new NonPojoValueError(path, 'undefined');
  }

  // Functions / symbols / etc — non-POJO
  if (typeof value !== 'object') {
    throw new NonPojoValueError(path, describeCtor(value));
  }

  // Arrays: walk in index order
  if (Array.isArray(value)) {
    return value.map((v, i) => toCanonical(v, `${path}[${i}]`));
  }

  // POJO (or null-prototype object): walk keys in lex sort order
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    for (const k of keys) {
      out[k] = toCanonical(value[k], path === '' ? k : `${path}.${k}`);
    }
    return out;
  }

  // Anything else (Map, Set, Date, class instance, ...) is rejected
  throw new NonPojoValueError(path, describeCtor(value));
}

/** Restore `bigint` from sentinel objects after JSON.parse. */
function fromCanonical(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(fromCanonical);
  }

  if (isBigintSentinel(value)) {
    return BigInt(value[BIGINT_SENTINEL]);
  }

  // Plain object — keys are already sorted in the canonical form, but we
  // re-walk to restore nested bigints.
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = fromCanonical((value as Record<string, unknown>)[k]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

import { keccak256, stringToBytes } from 'viem';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Encode a value to canonical, deterministic UTF-8 bytes.
 *
 * Throws:
 * - `NonIntegerNumberError` for floats, `NaN`, `Infinity`, or non-safe-integer numbers.
 * - `NonPojoValueError` for `Map`, `Set`, `Date`, `undefined`, class instances, functions, etc.
 */
export function canonicalEncode(value: unknown): Uint8Array {
  const canonical = toCanonical(value, '');
  // `JSON.stringify` walks keys in insertion order; toCanonical inserts in
  // sorted order, so the resulting string is lex-sorted.
  const json = JSON.stringify(canonical);
  return TEXT_ENCODER.encode(json);
}

/**
 * Encode a value to deterministic JSON text.
 *
 * This is the string-level companion to `canonicalEncode` for evidence bundles
 * and other payloads that need a stable JSON representation before hashing or
 * uploading. It shares the engine encoder's strict POJO/number policy.
 */
export function canonicalizeJson(value: unknown): string {
  return TEXT_DECODER.decode(canonicalEncode(value));
}

/** Hash the engine canonical JSON representation with Keccak-256. */
export function keccak256CanonicalJson(value: unknown): `0x${string}` {
  return keccak256(stringToBytes(canonicalizeJson(value)));
}

/**
 * Decode canonical bytes back into a value, restoring `bigint` from the
 * sentinel form.
 *
 * Round trip: `canonicalEncode(canonicalDecode(canonicalEncode(x)))`
 * is byte-equal to `canonicalEncode(x)`.
 */
export function canonicalDecode(bytes: Uint8Array): unknown {
  const json = TEXT_DECODER.decode(bytes);
  const parsed = JSON.parse(json);
  return fromCanonical(parsed);
}
