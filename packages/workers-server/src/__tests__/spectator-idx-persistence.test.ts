/**
 * Phase 7.3 — `_lastSpectatorIdx` persistence.
 *
 * Pre-Phase-7.3 behaviour: `_lastSpectatorIdx` lived only in DO RAM.
 * After eviction the DO would wake up with `_lastSpectatorIdx=null`,
 * so the next `broadcastUpdates` call would always re-emit the
 * latest spectator snapshot — even to spectators who already had it
 * — producing duplicate frames on reconnect/wake.
 *
 * Post-fix: the DO writes `lastSpectatorIdx` to storage on every
 * bump, and reads it back inside `ensureLoaded`. A new DO instance
 * sharing the same storage must therefore see the persisted value
 * and skip the duplicate broadcast.
 *
 * This test exercises the read/write helpers directly against the
 * real DO prototype using an in-memory storage stub. Full DO
 * reconstruction (alarms, plugin registry, websocket pair) is not
 * needed to assert the persistence invariant.
 */

import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { CTL_GAME_ID } from '@coordination-games/game-ctl';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

// biome-ignore lint/suspicious/noExplicitAny: test rigging pokes private DO internals (Object.create(prototype), _state, _meta) to exercise hibernation/load paths.
let GameRoomDO: any;
const TAG_SPECTATOR = '__spectator__';

beforeAll(async () => {
  ({ GameRoomDO } = await import('../do/GameRoomDO.js'));
});

/** Minimal in-memory DurableObjectStorage matching the surface
 *  GameRoomDO's spectator-broadcast / ensureLoaded path uses. */
function makeMemoryStorage(): DurableObjectStorage {
  const map = new Map<string, unknown>();
  // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the subset under test
  const stub: any = {
    async get(keyOrKeys: string | string[]): Promise<unknown> {
      if (Array.isArray(keyOrKeys)) {
        const out = new Map<string, unknown>();
        for (const k of keyOrKeys) if (map.has(k)) out.set(k, map.get(k));
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
    async list(opts?: { prefix?: string; start?: string }): Promise<Map<string, unknown>> {
      const prefix = opts?.prefix ?? '';
      const start = opts?.start;
      const keys = [...map.keys()].sort();
      const out = new Map<string, unknown>();
      for (const k of keys) {
        if (prefix && !k.startsWith(prefix)) continue;
        if (start && k < start) continue;
        out.set(k, map.get(k));
      }
      return out;
    },
  };
  return stub as DurableObjectStorage;
}

/** Build a barely-functional DO instance: enough for broadcastUpdates
 *  and ensureLoaded to work, with no plugin registry / alarms. */
function buildGameRoom(storage: DurableObjectStorage) {
  // biome-ignore lint/suspicious/noExplicitAny: test rigging
  const sentMessages: any[] = [];
  // Stub WebSocket-shaped object so broadcastUpdates' send() loop
  // doesn't blow up.
  const fakeWs = {
    send(msg: string) {
      sentMessages.push(JSON.parse(msg));
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: test rigging pokes private DO internals (Object.create(prototype), _state, _meta) to exercise hibernation/load paths.
  const room: any = Object.create(GameRoomDO.prototype);
  room._loaded = true;
  room.ctx = {
    storage,
    getWebSockets: (tag: string) => (tag === TAG_SPECTATOR ? [fakeWs] : []),
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    waitUntil: () => {},
  };

  // Minimal _meta — broadcastUpdates needs gameType/handleMap/playerIds
  // and the publicSnapshotIndex helper needs spectatorDelay + finished.
  room._meta = {
    gameId: 'g-test-1',
    gameType: CTL_GAME_ID,
    playerIds: ['p1'],
    handleMap: { p1: 'alice' },
    teamMap: {},
    createdAt: '2026-04-20T00:00:00Z',
    finished: false,
    spectatorDelay: 0,
  };
  // Two spectator snapshots present → publicSnapshotIndex returns 1.
  room._spectatorSnapshots = [{ turn: 0 }, { turn: 1 }];
  // Stub _plugin truthy so broadcastUpdates' `if (!this._meta || !this._plugin) return`
  // guard doesn't bail. The spectator path doesn't actually invoke plugin methods.
  room._plugin = {};

  return { room, sentMessages };
}

describe('GameRoomDO — _lastSpectatorIdx persistence (Phase 7.3)', () => {
  it('writes lastSpectatorIdx to storage after a spectator broadcast', async () => {
    const storage = makeMemoryStorage();
    const { room } = buildGameRoom(storage);

    expect(await storage.get('lastSpectatorIdx')).toBeUndefined();
    // The class field initialiser doesn't run via `Object.create(prototype)`,
    // so just confirm it's nullish (the production initialiser is `null`,
    // and ensureLoaded normalises any undefined/null into `null`).
    expect(room._lastSpectatorIdx ?? null).toBeNull();

    await room.broadcastUpdates();

    // publicSnapshotIndex with delay=0, 2 snapshots, unfinished → 1.
    expect(room._lastSpectatorIdx).toBe(1);
    expect(await storage.get('lastSpectatorIdx')).toBe(1);
  });

  it('does not re-write lastSpectatorIdx when the index has not advanced', async () => {
    const storage = makeMemoryStorage();
    const { room } = buildGameRoom(storage);

    await room.broadcastUpdates();
    expect(await storage.get('lastSpectatorIdx')).toBe(1);

    // Drop the persisted value to detect any redundant put.
    await storage.delete('lastSpectatorIdx');

    // Index is unchanged; broadcastUpdates must skip the put entirely.
    await room.broadcastUpdates();
    expect(await storage.get('lastSpectatorIdx')).toBeUndefined();
  });

  it('a fresh DO instance restores _lastSpectatorIdx from storage on ensureLoaded', async () => {
    const storage = makeMemoryStorage();

    // Seed the storage as if a previous (now-evicted) DO instance had
    // already broadcast snapshot index 1.
    await storage.put('meta', {
      gameId: 'g-test-1',
      gameType: CTL_GAME_ID,
      playerIds: ['p1'],
      handleMap: { p1: 'alice' },
      teamMap: {},
      createdAt: '2026-04-20T00:00:00Z',
      finished: false,
      spectatorDelay: 0,
    });
    await storage.put('actionLog', []);
    await storage.put('progress', { counter: 1 });
    await storage.put('snapshotCount', 2);
    await storage.put('snapshot:0', { turn: 0 });
    await storage.put('snapshot:1', { turn: 1 });
    await storage.put('lastSpectatorIdx', 1);

    // Build a fresh DO instance against that same storage.
    // biome-ignore lint/suspicious/noExplicitAny: test rigging pokes private DO internals (Object.create(prototype), _state, _meta) to exercise hibernation/load paths.
    const fresh: any = Object.create(GameRoomDO.prototype);
    fresh._loaded = false;
    fresh._spectatorSnapshots = [];
    fresh._lastSpectatorIdx = null;
    fresh.ctx = {
      storage,
      getWebSockets: () => [],
      blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      waitUntil: () => {},
    };

    // Trigger ensureLoaded directly (private method — tests use [] syntax).
    await fresh.ensureLoaded();

    expect(fresh._lastSpectatorIdx).toBe(1);
  });

  it('after eviction-equivalent reload, broadcastUpdates does NOT re-emit a duplicate', async () => {
    const storage = makeMemoryStorage();

    // Pretend a prior DO ran broadcastUpdates and persisted idx=1.
    const { room: first } = buildGameRoom(storage);
    await first.broadcastUpdates();
    expect(await storage.get('lastSpectatorIdx')).toBe(1);

    // New DO instance pointing at the same storage. Mirror what
    // ensureLoaded would do for the persistence value alone — the
    // full reload path is exercised in the previous test.
    const { room: second, sentMessages } = buildGameRoom(storage);
    second._lastSpectatorIdx = (await storage.get('lastSpectatorIdx')) ?? null;

    expect(second._lastSpectatorIdx).toBe(1);

    await second.broadcastUpdates();

    // No new spectator frame should have gone out — the index is
    // unchanged, persisted state told us so.
    expect(sentMessages).toEqual([]);
  });
});
