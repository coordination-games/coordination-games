/**
 * Capabilities — the surface a server-side plugin can request from the
 * runtime. Each plugin declares which capabilities it `requires`; the
 * runtime hands it a `Pick<Capabilities, R>` containing only the requested
 * ones at `init()` time.
 *
 * Concrete implementations of `RelayClient`, `AlarmScheduler`, and
 * `PluginScopedStorage` land in Phase 4.4 (RelayClient) and Phase 5.1+
 * (alarms). For now, the runtime is happy to construct without `relay` or
 * `alarms` because no plugin uses them yet.
 *
 * `OnChainRelay` is a forward-declared marker for Phase 5.3 settlement
 * plugins — today's `settleOnChain` in GameRoomDO continues to call the
 * concrete chain code directly.
 */

import type { D1Database, DurableObjectStorage } from '@cloudflare/workers-types';
import type { RelayEnvelope } from '@coordination-games/engine';

export type SpectatorViewer =
  | { kind: 'spectator' }
  | { kind: 'replay' }
  | { kind: 'admin' }
  | { kind: 'bot'; playerId: string }
  | { kind: 'player'; playerId: string };

/**
 * Read/write surface for the per-game/per-lobby relay log.
 * `publish` accepts an envelope without `index` or `timestamp`; the
 * implementation assigns those.
 */
export interface RelayClient {
  publish(
    env: Omit<RelayEnvelope, 'index' | 'timestamp'>,
    opts?: { dedupeKey?: string },
  ): Promise<void>;
  visibleTo(viewer: SpectatorViewer): Promise<RelayEnvelope[]>;
  since(index: number, viewer: SpectatorViewer): Promise<RelayEnvelope[]>;
}

/**
 * Plugin-private key/value storage. Keys are namespaced by pluginId so
 * two plugins can use the same key string without colliding.
 */
export interface PluginScopedStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts?: { prefix?: string }): Promise<Map<string, T>>;
}

/**
 * Schedule plugin-owned alarms. `kind` is plugin-defined; the runtime
 * routes the firing to `plugin.handleAlarm(kind)`.
 */
export interface AlarmScheduler {
  scheduleAt(when: number, kind: string, payload: unknown): Promise<void>;
  cancel(kind: string): Promise<void>;
}

/**
 * Forward-declared marker interface for Phase 5.3 settlement plugins.
 * Intentionally empty today — minimum surface to compile.
 */
// biome-ignore lint/suspicious/noEmptyInterface: intentional forward-declared marker for Phase 5.3
export interface OnChainRelay {}

/**
 * The full set of capabilities the runtime can offer. A plugin's
 * `requires: readonly R[]` constrains its `init()` cap subset to
 * `Pick<Capabilities, R>`, so it can never reach for capabilities it
 * didn't declare.
 */
export interface Capabilities {
  storage: PluginScopedStorage;
  relay: RelayClient;
  alarms: AlarmScheduler;
  d1: D1Database;
  chain: OnChainRelay;
}

export type CapName = keyof Capabilities;

/**
 * Build a fresh `PluginScopedStorage` view backed by a real DO
 * `DurableObjectStorage`, namespacing every key under `plugin:<pluginId>:`
 * so two plugins can use overlapping key names without collision.
 *
 * Kept as a value export here (rather than a separate file) so callers
 * grab one import for the full capabilities surface.
 */
export class NamespacedStorage implements PluginScopedStorage {
  private readonly prefix: string;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly pluginId: string,
  ) {
    this.prefix = `plugin:${this.pluginId}:`;
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(this.k(key));
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.storage.put(this.k(key), value);
  }

  async delete(key: string): Promise<boolean> {
    return this.storage.delete(this.k(key));
  }

  async list<T>(opts?: { prefix?: string }): Promise<Map<string, T>> {
    const fullPrefix = this.k(opts?.prefix ?? '');
    const result = await this.storage.list<T>({ prefix: fullPrefix });
    // Strip the namespace from returned keys
    const stripped = new Map<string, T>();
    const stripLen = this.prefix.length;
    for (const [k, v] of result) {
      stripped.set(k.slice(stripLen), v);
    }
    return stripped;
  }
}
