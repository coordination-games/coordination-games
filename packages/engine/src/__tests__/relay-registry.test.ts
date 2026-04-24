/**
 * Tests for the per-type relay validation registry (Phase 4.2).
 *
 * Coverage:
 *   - Schema registration: success, collision detection.
 *   - validateRelay: success returns a NEW branded envelope; unknown type
 *     and malformed body throw the right error subclasses.
 *   - validateRelayBody: same outcomes for the type+data shape used at
 *     publish time (no index/timestamp yet).
 *   - registerPluginRelayTypes: idempotent for same schema reference,
 *     throws on different-schema collisions.
 *   - Brand: ValidatedRelayEnvelope<T> assignable to RelayEnvelope<T> but
 *     not vice versa.
 */

import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  clearRelayRegistry,
  isRelayTypeRegistered,
  RelayUnknownTypeError,
  RelayValidationError,
  registerPluginRelayTypes,
  registerRelayType,
  type ValidatedRelayEnvelope,
  validateRelay,
  validateRelayBody,
} from '../relay-registry.js';
import type { RelayEnvelope } from '../types.js';

beforeEach(() => {
  clearRelayRegistry();
});

function makeEnv<T>(type: string, data: T): RelayEnvelope<T> {
  return {
    index: 0,
    type,
    pluginId: 'test',
    sender: 'p1',
    scope: { kind: 'all' },
    turn: null,
    timestamp: 0,
    data,
  };
}

describe('registerRelayType', () => {
  it('registers a schema and isRelayTypeRegistered reports true', () => {
    expect(isRelayTypeRegistered('foo:bar')).toBe(false);
    registerRelayType('foo:bar', z.object({ x: z.number() }));
    expect(isRelayTypeRegistered('foo:bar')).toBe(true);
  });

  it('throws on collision when two different schemas claim the same type', () => {
    registerRelayType('dup', z.object({ a: z.string() }));
    expect(() => registerRelayType('dup', z.object({ b: z.number() }))).toThrow(
      /Relay type collision at registration: dup/,
    );
  });
});

describe('validateRelay', () => {
  it('returns a branded ValidatedRelayEnvelope on a matching envelope', () => {
    registerRelayType('foo:bar', z.object({ x: z.number() }));
    const env = makeEnv('foo:bar', { x: 7 });
    const validated = validateRelay<{ x: number }>(env);
    expect(validated.data).toEqual({ x: 7 });
    // Brand: assignable to RelayEnvelope<T>, but the brand itself is opaque.
    expectTypeOf<typeof validated>().toMatchTypeOf<RelayEnvelope<{ x: number }>>();
  });

  it('returns a NEW object (not the input) so callers cannot mutate the wire envelope', () => {
    registerRelayType('foo:bar', z.object({ x: z.number() }));
    const env = makeEnv('foo:bar', { x: 1 });
    const validated = validateRelay<{ x: number }>(env);
    expect(validated).not.toBe(env);
  });

  it('throws RelayUnknownTypeError on an unregistered type', () => {
    const env = makeEnv('nope', { anything: true });
    expect(() => validateRelay(env)).toThrow(RelayUnknownTypeError);
    try {
      validateRelay(env);
    } catch (err) {
      expect(err).toBeInstanceOf(RelayUnknownTypeError);
      expect((err as RelayUnknownTypeError).type).toBe('nope');
    }
  });

  it('throws RelayValidationError on malformed body', () => {
    registerRelayType('strict', z.object({ count: z.number() }));
    const env = makeEnv('strict', { count: 'not-a-number' });
    expect(() => validateRelay(env)).toThrow(RelayValidationError);
    try {
      validateRelay(env);
    } catch (err) {
      expect(err).toBeInstanceOf(RelayValidationError);
      expect((err as RelayValidationError).type).toBe('strict');
      expect(Array.isArray((err as RelayValidationError).zodIssues)).toBe(true);
    }
  });

  it('parses/coerces data through the schema (returned data is the parsed value)', () => {
    registerRelayType('coerce', z.object({ n: z.coerce.number() }));
    const env = makeEnv('coerce', { n: '42' });
    const validated = validateRelay<{ n: number }>(env);
    expect(validated.data).toEqual({ n: 42 });
  });
});

describe('validateRelayBody', () => {
  it('parses just (type, data) without an envelope', () => {
    registerRelayType('body', z.object({ greeting: z.string() }));
    const parsed = validateRelayBody<{ greeting: string }>('body', { greeting: 'hi' });
    expect(parsed).toEqual({ greeting: 'hi' });
  });

  it('throws RelayUnknownTypeError on unknown type', () => {
    expect(() => validateRelayBody('nope', {})).toThrow(RelayUnknownTypeError);
  });

  it('throws RelayValidationError on malformed body', () => {
    registerRelayType('body', z.object({ greeting: z.string() }));
    expect(() => validateRelayBody('body', { greeting: 7 })).toThrow(RelayValidationError);
  });
});

describe('registerPluginRelayTypes', () => {
  it('registers every entry from the plugin.relayTypes map', () => {
    const schema = z.object({ a: z.string() });
    registerPluginRelayTypes({ id: 'p1', relayTypes: { 'p1:foo': schema } });
    expect(isRelayTypeRegistered('p1:foo')).toBe(true);
  });

  it('is idempotent for the same schema reference (same module re-imported)', () => {
    const schema = z.object({ a: z.string() });
    const plugin = { id: 'p1', relayTypes: { 'p1:foo': schema } };
    registerPluginRelayTypes(plugin);
    expect(() => registerPluginRelayTypes(plugin)).not.toThrow();
  });

  it('throws on collision when a different schema claims the same type', () => {
    registerPluginRelayTypes({ id: 'p1', relayTypes: { dup: z.string() } });
    expect(() => registerPluginRelayTypes({ id: 'p2', relayTypes: { dup: z.number() } })).toThrow(
      /Relay type collision at registration: dup/,
    );
  });

  it('no-ops when relayTypes is undefined', () => {
    expect(() => registerPluginRelayTypes({ id: 'p3' })).not.toThrow();
  });
});

describe('ValidatedRelayEnvelope branding (type-level)', () => {
  it('ValidatedRelayEnvelope<T> is assignable to RelayEnvelope<T>', () => {
    expectTypeOf<ValidatedRelayEnvelope<{ x: number }>>().toMatchTypeOf<
      RelayEnvelope<{ x: number }>
    >();
  });

  it('RelayEnvelope<T> is NOT assignable to ValidatedRelayEnvelope<T> (one-way brand)', () => {
    // @ts-expect-error — unbranded RelayEnvelope cannot be widened into ValidatedRelayEnvelope
    const _x: ValidatedRelayEnvelope<{ x: number }> = makeEnv('foo', { x: 1 });
    void _x;
  });
});
