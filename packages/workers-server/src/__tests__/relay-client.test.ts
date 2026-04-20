/**
 * Tests for DOStorageRelayClient — the canonical RelayClient that
 * replaced the per-DO inline relay arrays in LobbyDO + GameRoomDO
 * (Phase 4.4).
 *
 * Coverage:
 *  - publish + visibleTo for each viewer kind (admin, spectator, player
 *    on team A, player on team B).
 *  - dedupe: re-publishing with the same dedupeKey is a no-op.
 *  - since(N, viewer) returns only envelopes with index >= N (and only
 *    those visible to the viewer).
 *  - WRITE-AMP REGRESSION: publishing 1000 envelopes produces exactly
 *    1001 storage entries (1000 envelopes + 1 tip key) and zero entries
 *    under the legacy 'relay' key.
 */

import type { DurableObjectStorage } from '@cloudflare/workers-types';
import {
  clearRelayRegistry,
  type RelayEnvelope,
  registerRelayType,
} from '@coordination-games/engine';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DOStorageRelayClient } from '../plugins/relay-client.js';

// Phase 4.2: publish() validates envelopes against the relay registry.
// Register a permissive schema for the test 'messaging' fixture so the
// existing publish-then-read assertions still exercise the visibility rules
// (the validation path itself is covered by relay-client-validation.test.ts).
beforeEach(() => {
  clearRelayRegistry();
  registerRelayType(
    'messaging',
    z.object({ msg: z.string().optional(), body: z.string().optional() }).passthrough(),
  );
});

// ---------------------------------------------------------------------------
// In-memory DurableObjectStorage stand-in. Implements the get/put/delete/list
// surface DOStorageRelayClient exercises — including DurableObjectListOptions
// (`prefix`, `start`).
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
      // Sort lexicographically for determinism (matches DO behavior).
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Partial = Omit<RelayEnvelope, 'index' | 'timestamp'>;

function pub(scope: RelayEnvelope['scope'], sender: string, body = 'hi'): Partial {
  return {
    type: 'messaging',
    pluginId: 'chat',
    sender,
    scope,
    turn: null,
    data: { msg: body },
  };
}

// p1, p2 on team A; p3, p4 on team B.
const HANDLES: Record<string, string> = { p1: 'alice', p2: 'bob', p3: 'carol', p4: 'dave' };
const TEAMS: Record<string, string> = { p1: 'A', p2: 'A', p3: 'B', p4: 'B' };

function buildClient(storage: DurableObjectStorage): DOStorageRelayClient {
  return new DOStorageRelayClient(storage, {
    getTeamForPlayer: (pid) => TEAMS[pid] ?? null,
    getHandleForPlayer: (pid) => HANDLES[pid] ?? null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DOStorageRelayClient — publish + visibleTo', () => {
  it('admin viewer sees a freshly published envelope', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'all' }, 'p1', 'hello'));

    const seen = await client.visibleTo({ kind: 'admin' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data).toEqual({ msg: 'hello' });
    expect(seen[0]?.index).toBe(0);
    expect(typeof seen[0]?.timestamp).toBe('number');
  });

  it('spectator viewer sees only scope.kind === "all" envelopes', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'all' }, 'p1', 'public'));
    await client.publish(pub({ kind: 'team', teamId: 'A' }, 'p1', 'team-A'));
    await client.publish(pub({ kind: 'team', teamId: 'B' }, 'p3', 'team-B'));
    await client.publish(pub({ kind: 'dm', recipientHandle: 'bob' }, 'p1', 'dm-to-bob'));

    const seen = await client.visibleTo({ kind: 'spectator' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.scope.kind).toBe('all');
  });

  it('replay viewer behaves like spectator (only "all")', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'all' }, 'p1'));
    await client.publish(pub({ kind: 'team', teamId: 'A' }, 'p1'));
    await client.publish(pub({ kind: 'dm', recipientHandle: 'bob' }, 'p1'));

    const seen = await client.visibleTo({ kind: 'replay' });
    expect(seen.map((e) => e.scope.kind)).toEqual(['all']);
  });

  it('player on team A sees: all + own DMs + team-A; hides team-B', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'all' }, 'p1', 'public'));
    await client.publish(pub({ kind: 'team', teamId: 'A' }, 'p2', 'team-A'));
    await client.publish(pub({ kind: 'team', teamId: 'B' }, 'p3', 'team-B'));
    await client.publish(pub({ kind: 'dm', recipientHandle: 'alice' }, 'p3', 'dm-to-alice'));
    await client.publish(pub({ kind: 'dm', recipientHandle: 'carol' }, 'p1', 'dm-from-alice'));

    const seen = await client.visibleTo({ kind: 'player', playerId: 'p1' });
    const bodies = seen.map((e) => (e.data as { msg: string }).msg).sort();
    expect(bodies).toEqual(['dm-from-alice', 'dm-to-alice', 'public', 'team-A']);
  });

  it('player on team B is symmetric — sees team-B but not team-A', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'all' }, 'p1', 'public'));
    await client.publish(pub({ kind: 'team', teamId: 'A' }, 'p1', 'team-A'));
    await client.publish(pub({ kind: 'team', teamId: 'B' }, 'p4', 'team-B'));

    const seen = await client.visibleTo({ kind: 'player', playerId: 'p3' });
    const bodies = seen.map((e) => (e.data as { msg: string }).msg).sort();
    expect(bodies).toEqual(['public', 'team-B']);
  });

  it('bot viewer behaves like a player', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'team', teamId: 'A' }, 'p2', 'team-A'));
    await client.publish(pub({ kind: 'team', teamId: 'B' }, 'p3', 'team-B'));

    const seen = await client.visibleTo({ kind: 'bot', playerId: 'p1' });
    expect(seen).toHaveLength(1);
    expect((seen[0]?.data as { msg: string }).msg).toBe('team-A');
  });

  it('DM addressed by playerId is visible to that player (not just by handle)', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'dm', recipientHandle: 'p1' }, 'p2', 'by-id'));
    const seen = await client.visibleTo({ kind: 'player', playerId: 'p1' });
    expect(seen).toHaveLength(1);
    expect((seen[0]?.data as { msg: string }).msg).toBe('by-id');
  });
});

describe('DOStorageRelayClient — dedupe', () => {
  it('publishing twice with the same dedupeKey appends only once', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'all' }, 'p1', 'first'), { dedupeKey: 'k1' });
    await client.publish(pub({ kind: 'all' }, 'p1', 'second-dup'), { dedupeKey: 'k1' });
    await client.publish(pub({ kind: 'all' }, 'p1', 'third'), { dedupeKey: 'k2' });

    const seen = await client.visibleTo({ kind: 'admin' });
    expect(seen).toHaveLength(2);
    expect(seen.map((e) => (e.data as { msg: string }).msg)).toEqual(['first', 'third']);
  });
});

describe('DOStorageRelayClient — since', () => {
  it('returns only envelopes with index >= N matching the viewer', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);
    await client.publish(pub({ kind: 'all' }, 'p1', 'm0')); // index 0
    await client.publish(pub({ kind: 'team', teamId: 'A' }, 'p1', 'm1')); // index 1
    await client.publish(pub({ kind: 'all' }, 'p2', 'm2')); // index 2
    await client.publish(pub({ kind: 'team', teamId: 'B' }, 'p3', 'm3')); // index 3

    const adminSince1 = await client.since(1, { kind: 'admin' });
    expect(adminSince1.map((e) => e.index)).toEqual([1, 2, 3]);

    const spectatorSince1 = await client.since(1, { kind: 'spectator' });
    expect(spectatorSince1.map((e) => e.index)).toEqual([2]);

    const teamASince0 = await client.since(0, { kind: 'player', playerId: 'p1' });
    // p1 sees: m0 (all), m1 (team-A); not m2 (yes, all), wait — m2 is also 'all'.
    // p1 sees: m0, m1, m2. NOT m3 (team-B).
    expect(teamASince0.map((e) => e.index)).toEqual([0, 1, 2]);
  });
});

describe('DOStorageRelayClient — write-amplification regression', () => {
  it('1000 publishes produce exactly 1001 storage entries (1000 envelopes + tip), no legacy "relay" key', async () => {
    const storage = makeMemoryStorage();
    const client = buildClient(storage);

    const N = 1000;
    for (let i = 0; i < N; i++) {
      await client.publish(pub({ kind: 'all' }, 'p1', `m${i}`));
    }

    // Legacy single-array key MUST NOT be written by the new client.
    expect(storage._raw.has('relay')).toBe(false);

    // relay:tip + N envelopes under relay:<paddedIndex>
    const allKeys = [...storage._raw.keys()];
    const relayKeys = allKeys.filter((k) => k.startsWith('relay:'));
    expect(relayKeys.length).toBe(N + 1);

    const tip = await storage.get<number>('relay:tip');
    expect(tip).toBe(N);

    // Sanity check: visibleTo returns all of them in order.
    const seen = await client.visibleTo({ kind: 'admin' });
    expect(seen).toHaveLength(N);
    expect(seen[0]?.index).toBe(0);
    expect(seen[N - 1]?.index).toBe(N - 1);
  });
});
