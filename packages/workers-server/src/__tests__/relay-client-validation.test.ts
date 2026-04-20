/**
 * Phase 4.2 — DOStorageRelayClient enforces the relay validation registry.
 *
 * publish() must:
 *  - Accept envelopes whose `type` has a registered schema and `data`
 *    parses against it. The persisted envelope carries the parsed body.
 *  - Reject envelopes with an unregistered `type` (RelayUnknownTypeError).
 *  - Reject envelopes whose `data` fails the schema (RelayValidationError).
 *  - Emit a structured `relay.validation.reject` log on failure.
 */

import type { DurableObjectStorage } from '@cloudflare/workers-types';
import {
  clearRelayRegistry,
  type RelayEnvelope,
  RelayUnknownTypeError,
  RelayValidationError,
  registerRelayType,
} from '@coordination-games/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DOStorageRelayClient } from '../plugins/relay-client.js';

// ---------------------------------------------------------------------------
// Reuse the in-memory storage stand-in shape from relay-client.test.ts
// ---------------------------------------------------------------------------

interface MemStorage extends DurableObjectStorage {
  _raw: Map<string, unknown>;
}

function makeMemoryStorage(): MemStorage {
  const map = new Map<string, unknown>();
  const stub = {
    async get(keyOrKeys: string | string[]): Promise<unknown> {
      if (Array.isArray(keyOrKeys)) {
        const out = new Map<string, unknown>();
        for (const k of keyOrKeys) {
          if (map.has(k)) out.set(k, map.get(k));
        }
        return out;
      }
      return map.get(keyOrKeys);
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
    async list(opts?: {
      prefix?: string;
      start?: string;
      end?: string;
    }): Promise<Map<string, unknown>> {
      const prefix = opts?.prefix ?? '';
      const start = opts?.start;
      const end = opts?.end;
      const keys = [...map.keys()].sort();
      const out = new Map<string, unknown>();
      for (const k of keys) {
        if (prefix && !k.startsWith(prefix)) continue;
        if (start && k < start) continue;
        if (end && k >= end) continue;
        out.set(k, map.get(k));
      }
      return out;
    },
    _raw: map,
  };
  return stub as unknown as MemStorage;
}

type Partial = Omit<RelayEnvelope, 'index' | 'timestamp'>;

function pub(type: string, data: unknown): Partial {
  return {
    type,
    pluginId: 'test',
    sender: 'p1',
    scope: { kind: 'all' },
    turn: null,
    data,
  };
}

beforeEach(() => {
  clearRelayRegistry();
});

describe('DOStorageRelayClient.publish — validation registry', () => {
  it('publishes when the envelope type is registered and the body is valid', async () => {
    registerRelayType('chat:message', z.object({ body: z.string() }));
    const storage = makeMemoryStorage();
    const client = new DOStorageRelayClient(storage);

    await client.publish(pub('chat:message', { body: 'hello' }));

    const seen = await client.visibleTo({ kind: 'admin' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('chat:message');
    expect(seen[0]?.data).toEqual({ body: 'hello' });
  });

  it('persists the parsed (coerced) data, not the raw input', async () => {
    registerRelayType('coerce:thing', z.object({ n: z.coerce.number() }));
    const storage = makeMemoryStorage();
    const client = new DOStorageRelayClient(storage);

    await client.publish(pub('coerce:thing', { n: '42' }));

    const seen = await client.visibleTo({ kind: 'admin' });
    expect(seen[0]?.data).toEqual({ n: 42 });
  });

  it('rejects an UNregistered relay type with RelayUnknownTypeError', async () => {
    const storage = makeMemoryStorage();
    const log = vi.fn();
    const client = new DOStorageRelayClient(storage, { log });

    await expect(client.publish(pub('not:registered', { x: 1 }))).rejects.toBeInstanceOf(
      RelayUnknownTypeError,
    );

    // Nothing persisted.
    expect(storage._raw.size).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'relay.validation.reject',
      expect.objectContaining({ type: 'not:registered', reason: 'RelayUnknownTypeError' }),
    );
  });

  it('rejects a malformed body with RelayValidationError', async () => {
    registerRelayType('strict:body', z.object({ count: z.number() }));
    const storage = makeMemoryStorage();
    const log = vi.fn();
    const client = new DOStorageRelayClient(storage, { log });

    await expect(
      client.publish(pub('strict:body', { count: 'not-a-number' })),
    ).rejects.toBeInstanceOf(RelayValidationError);

    expect(storage._raw.size).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'relay.validation.reject',
      expect.objectContaining({
        type: 'strict:body',
        reason: 'RelayValidationError',
        zodIssues: expect.any(Array),
      }),
    );
  });

  it('does NOT advance the relay tip when validation fails', async () => {
    registerRelayType('ok', z.object({ body: z.string() }));
    const storage = makeMemoryStorage();
    const client = new DOStorageRelayClient(storage);

    await client.publish(pub('ok', { body: 'first' }));
    await expect(client.publish(pub('unknown', { body: 'second' }))).rejects.toThrow();
    await client.publish(pub('ok', { body: 'third' }));

    const seen = await client.visibleTo({ kind: 'admin' });
    expect(seen.map((e) => e.index)).toEqual([0, 1]);
    expect(seen.map((e) => (e.data as { body: string }).body)).toEqual(['first', 'third']);
  });
});
