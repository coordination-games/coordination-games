/**
 * Shared test rigging for workers-server unit tests.
 *
 * These helpers reach into private DO fields via `Object.create(Proto)` +
 * direct property assignment (same pattern the tests used inline). Centralizing
 * the subset-stub shapes lets each test cast once at construction and keeps
 * the test bodies free of per-access `any`.
 */

import type { D1Database, DurableObjectStorage } from '@cloudflare/workers-types';
import type { ChainRelay } from '../chain/types.js';
import type {
  AlarmScheduler,
  Capabilities,
  OnChainRelay,
  PluginScopedStorage,
  RelayClient,
} from '../plugins/capabilities.js';

// ---------------------------------------------------------------------------
// Opaque DO internals used across fixture builders
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a `LobbyDO` instance the tests touch via
 * `Object.create(LobbyDO.prototype)`. Only the fields we actually assign /
 * read live here — everything else stays unknown.
 */
export interface LobbyDOInternal {
  _loaded: boolean;
  ctx: {
    storage: DurableObjectStorage;
    getWebSockets?: () => WebSocket[];
    id?: { name: string };
  };
  env: {
    DB: D1Database;
    RPC_URL?: string;
    [k: string]: unknown;
  };
  _meta: {
    lobbyId: string;
    gameType: string;
    currentPhaseIndex: number;
    accumulatedMetadata: Record<string, unknown>;
    phase: string;
    deadlineMs: number | null;
    gameId: string | null;
    error: string | null;
    noTimeout: boolean;
    createdAt: number;
  };
  _agents: Array<{ id: string; handle: string; elo?: number; joinedAt?: number }>;
  _phaseState: unknown;
  _chainRelayPromise?: Promise<ChainRelay>;
  fetch: (req: Request) => Promise<Response>;
}

/**
 * Minimal shape of a `GameRoomDO` instance tests touch via
 * `Object.create(GameRoomDO.prototype)`.
 */
export interface GameRoomDOInternal {
  ctx: {
    storage: DurableObjectStorage;
    getWebSockets?: () => WebSocket[];
    id?: { name: string };
  };
  env: { DB: D1Database; [k: string]: unknown };
  _meta: Record<string, unknown>;
  _state: unknown;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Shared in-memory DurableObjectStorage
// ---------------------------------------------------------------------------

export interface MemoryStorage extends DurableObjectStorage {
  /** Test-only handle onto the underlying map, for direct assertions. */
  _raw: Map<string, unknown>;
}

/**
 * In-memory stand-in covering the DurableObjectStorage surface the DO code
 * actually touches (get / put / delete / list). Add more methods here as
 * tests need them — do NOT spread this definition across call sites again.
 */
export function makeMemoryStorage(): MemoryStorage {
  const map = new Map<string, unknown>();
  const stub = {
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
    async setAlarm(_when: number): Promise<void> {},
    async deleteAlarm(): Promise<void> {},
    _raw: map,
  };
  return stub as unknown as MemoryStorage;
}

// ---------------------------------------------------------------------------
// Capability-subset stubs
// ---------------------------------------------------------------------------

/**
 * Zero-behaviour caps struct. Each field is typed as the canonical capability
 * interface but carries no implementation — tests swap the field they're
 * exercising and leave the rest as stubs. The cast is narrow and shared.
 */
export function makeEmptyCaps(): Capabilities {
  const emptyStorage = {} as PluginScopedStorage;
  const emptyRelay = {} as RelayClient;
  const emptyAlarms = {} as AlarmScheduler;
  const emptyD1 = {} as D1Database;
  const emptyChain = {} as OnChainRelay;
  return {
    storage: emptyStorage,
    relay: emptyRelay,
    alarms: emptyAlarms,
    d1: emptyD1,
    chain: emptyChain,
  };
}

/**
 * Opaque D1Database handle for tests that don't exercise DB at all. Keeps
 * the cast out of every test fixture.
 */
export function emptyD1(): D1Database {
  return {} as D1Database;
}

/**
 * Helpers to JSON-parse a fetch Response body with a minimum-necessary shape.
 * Covers the common `{ error, ... }` / `{ ok, ... }` / `{ relay }` envelopes
 * spectator / lobby tests assert on.
 */
export interface JsonRelayEntry {
  scope: { kind: string; teamId?: string; recipientHandle?: string };
  sender: string;
  [k: string]: unknown;
}
export interface JsonBody {
  error?: string;
  ok?: boolean;
  relay?: JsonRelayEntry[];
  required?: string;
  available?: string;
  agentId?: string;
  playerId?: string;
  existing?: { lobbyId: string; gameId?: string; status: string };
  [k: string]: unknown;
}
export async function readJson(resp: Response): Promise<JsonBody> {
  return (await resp.json()) as JsonBody;
}
