/**
 * Tests for ServerPluginRuntime — capability-injection invariants
 * (Phase 4.3).
 *
 * Coverage:
 *  - A plugin requiring `['storage']` does NOT see `relay` or `chain`
 *    in its init cap subset.
 *  - Storage namespacing: two plugins putting under the same key string
 *    produce distinct underlying keys (`plugin:<id>:<key>`) and don't
 *    collide.
 *  - A plugin error in `handleRelay` doesn't crash the runtime — the
 *    next plugin still receives the envelope.
 *  - `register` throws on duplicate id.
 */

import type { D1Database, DurableObjectStorage } from '@cloudflare/workers-types';
import type { RelayEnvelope } from '@coordination-games/engine';
import { describe, expect, it, vi } from 'vitest';
import {
  type Capabilities,
  type CapName,
  NamespacedStorage,
  type RelayClient,
  type SpectatorViewer,
} from '../plugins/capabilities.js';
import { type ServerPlugin, ServerPluginRuntime } from '../plugins/runtime.js';

// ---------------------------------------------------------------------------
// In-memory DurableObjectStorage stand-in. We only need the four methods
// NamespacedStorage uses (get / put / delete / list).
// ---------------------------------------------------------------------------

function makeMemoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the subset NamespacedStorage uses
  const stub: any = {
    async get(key: string): Promise<unknown> {
      return map.get(key);
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value);
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
    /** Test helper — not part of the DurableObjectStorage surface. */
    _raw: map,
  };
  return stub as DurableObjectStorage;
}

function buildCaps(storage: DurableObjectStorage): Capabilities {
  const fakeRelay: RelayClient = {
    publish: vi.fn(async () => {}),
    visibleTo: vi.fn(async (_v: SpectatorViewer) => [] as RelayEnvelope[]),
    since: vi.fn(async (_i: number, _v: SpectatorViewer) => [] as RelayEnvelope[]),
    getTip: vi.fn(async () => 0),
  };
  return {
    storage: new NamespacedStorage(storage, '__unused__'),
    relay: fakeRelay,
    alarms: {
      scheduleAt: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    },
    d1: {} as D1Database,
    // biome-ignore lint/suspicious/noExplicitAny: chain capability stub for tests; SettlementStateMachine is tested separately
    chain: {} as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ServerPluginRuntime — capability injection', () => {
  it('hands the plugin only the capabilities it requires', async () => {
    const storage = makeMemoryStorage();
    const caps = buildCaps(storage);
    // Override storage with a per-plugin namespaced view inside the test
    const runtime = new ServerPluginRuntime(caps, { gameId: 'g1' });

    // biome-ignore lint/suspicious/noExplicitAny: we inspect cap shape at runtime
    let receivedCaps: any = null;
    const plugin: ServerPlugin<'storage'> = {
      id: 'storage-only',
      requires: ['storage'] as const,
      async init(c) {
        receivedCaps = c;
      },
    };

    await runtime.register(plugin);
    expect(receivedCaps).not.toBeNull();
    expect(Object.keys(receivedCaps)).toEqual(['storage']);
    expect('relay' in receivedCaps).toBe(false);
    expect('chain' in receivedCaps).toBe(false);
    expect('alarms' in receivedCaps).toBe(false);
    expect('d1' in receivedCaps).toBe(false);
  });

  it('hands a multi-cap plugin exactly the requested set', async () => {
    const storage = makeMemoryStorage();
    const caps = buildCaps(storage);
    const runtime = new ServerPluginRuntime(caps, { gameId: 'g1' });

    // biome-ignore lint/suspicious/noExplicitAny: inspect cap shape at runtime
    let receivedCaps: any = null;
    const plugin: ServerPlugin<'storage' | 'd1'> = {
      id: 'storage-and-d1',
      requires: ['storage', 'd1'] as const,
      async init(c) {
        receivedCaps = c;
      },
    };

    await runtime.register(plugin);
    expect(Object.keys(receivedCaps).sort()).toEqual(['d1', 'storage']);
    expect('relay' in receivedCaps).toBe(false);
  });

  it('namespaces storage keys per pluginId — two plugins do not collide', async () => {
    const rawStorage = makeMemoryStorage();
    // biome-ignore lint/suspicious/noExplicitAny: pull the test-only handle off our stub
    const rawMap: Map<string, unknown> = (rawStorage as any)._raw;

    // Each plugin sees its own namespaced view via NamespacedStorage(rawStorage, id).
    const capsForA: Capabilities = {
      storage: new NamespacedStorage(rawStorage, 'a'),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stubs for caps not used by the test plugins
      relay: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stubs for caps not used by the test plugins
      alarms: {} as any,
      d1: {} as D1Database,
      // biome-ignore lint/suspicious/noExplicitAny: chain capability stub for tests; SettlementStateMachine is tested separately
      chain: {} as any,
    };
    const capsForB: Capabilities = {
      storage: new NamespacedStorage(rawStorage, 'b'),
      // biome-ignore lint/suspicious/noExplicitAny: minimal stubs for caps not used by the test plugins
      relay: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stubs for caps not used by the test plugins
      alarms: {} as any,
      d1: {} as D1Database,
      // biome-ignore lint/suspicious/noExplicitAny: chain capability stub for tests; SettlementStateMachine is tested separately
      chain: {} as any,
    };

    const runtimeA = new ServerPluginRuntime(capsForA, { gameId: 'g1' });
    const runtimeB = new ServerPluginRuntime(capsForB, { gameId: 'g1' });

    const pluginA: ServerPlugin<'storage'> = {
      id: 'a',
      requires: ['storage'] as const,
      async init(c) {
        await c.storage.put('counter', 1);
      },
    };
    const pluginB: ServerPlugin<'storage'> = {
      id: 'b',
      requires: ['storage'] as const,
      async init(c) {
        await c.storage.put('counter', 99);
      },
    };

    await runtimeA.register(pluginA);
    await runtimeB.register(pluginB);

    // Underlying map sees both keys distinctly
    expect(rawMap.get('plugin:a:counter')).toBe(1);
    expect(rawMap.get('plugin:b:counter')).toBe(99);

    // And the namespaced views read their own value back, not each other's
    const a = await capsForA.storage.get<number>('counter');
    const b = await capsForB.storage.get<number>('counter');
    expect(a).toBe(1);
    expect(b).toBe(99);
  });

  it('list() strips the namespace prefix from returned keys', async () => {
    const storage = makeMemoryStorage();
    const ns = new NamespacedStorage(storage, 'mine');
    await ns.put('alpha', 1);
    await ns.put('beta', 2);
    await ns.put('alpha-2', 3);

    const all = await ns.list<number>();
    expect([...all.keys()].sort()).toEqual(['alpha', 'alpha-2', 'beta']);

    const prefixed = await ns.list<number>({ prefix: 'alpha' });
    expect([...prefixed.keys()].sort()).toEqual(['alpha', 'alpha-2']);
  });

  it('a handleRelay error in one plugin does not stop the next plugin', async () => {
    const storage = makeMemoryStorage();
    const caps = buildCaps(storage);
    const runtime = new ServerPluginRuntime(caps, { gameId: 'g1' });

    const seenByB: RelayEnvelope[] = [];
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const pluginA: ServerPlugin<never> = {
      id: 'crashy-a',
      requires: [] as const,
      async init() {},
      async handleRelay(_env) {
        throw new Error('boom');
      },
    };
    const pluginB: ServerPlugin<never> = {
      id: 'observer-b',
      requires: [] as const,
      async init() {},
      async handleRelay(env) {
        seenByB.push(env);
        return undefined;
      },
    };

    await runtime.register(pluginA);
    await runtime.register(pluginB);

    const env: RelayEnvelope = {
      index: 0,
      type: 'messaging',
      pluginId: 'test',
      sender: 'p1',
      scope: { kind: 'all' },
      turn: null,
      timestamp: 0,
      data: { body: 'hi' },
    };
    await runtime.handleRelay(env);

    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]).toBe(env);
    expect(errLog).toHaveBeenCalled();
    errLog.mockRestore();
  });

  it('register() throws on duplicate id', async () => {
    const storage = makeMemoryStorage();
    const caps = buildCaps(storage);
    const runtime = new ServerPluginRuntime(caps, { gameId: 'g1' });

    const make = (id: string): ServerPlugin<never> => ({
      id,
      requires: [] as const,
      async init() {},
    });
    await runtime.register(make('dup'));
    await expect(runtime.register(make('dup'))).rejects.toThrow(/already registered/);
  });

  it('CapName covers the full Capabilities key set', () => {
    // Compile-time guard. If a future cap is added to Capabilities and
    // CapName falls out of sync, this assignment will fail to compile.
    const caps: Record<CapName, true> = {
      storage: true,
      relay: true,
      alarms: true,
      d1: true,
      chain: true,
    };
    expect(Object.keys(caps).sort()).toEqual(['alarms', 'chain', 'd1', 'relay', 'storage']);
  });
});
