/**
 * ServerPluginRuntime — capability-injection container for server-side
 * plugins.
 *
 * Each registered `ServerPlugin<R>` declares the capability names it
 * `requires`. At register time the runtime hands the plugin a
 * `Pick<Capabilities, R>` containing exactly those capabilities — no
 * more, no less — so a plugin that asked for only `['storage']` can
 * never reach `caps.relay` or `caps.chain`.
 *
 * Today no plugin uses `relay` or `alarms`; the runtime is happy to be
 * constructed with stubs for those. DOs do NOT use the runtime yet —
 * that lands in Phase 5.1.
 */

import type { RelayEnvelope } from '@coordination-games/engine';
import type { Capabilities, CapName, SpectatorViewer } from './capabilities.js';

export interface GameContext {
  gameId: string;
  // Extend as plugins need more (gameType, playerIds, etc.).
}

export interface ServerPlugin<R extends CapName = never> {
  id: string;
  requires: readonly R[];
  init(caps: Pick<Capabilities, R>, game: GameContext): Promise<void>;
  handleRelay?(env: RelayEnvelope): Promise<RelayEnvelope[] | undefined>;
  /**
   * Direct call into the plugin. `viewer` carries authentication context —
   * `{ kind: 'spectator' }` for unauthenticated callers, `{ kind: 'player',
   * playerId }` for authenticated ones, etc. Plugins decide what to allow
   * for which viewer kinds.
   */
  handleCall?(name: string, args: unknown, viewer: SpectatorViewer): Promise<unknown>;
  handleAlarm?(name: string): Promise<void>;
  dispose?(): Promise<void>;
}

interface RegisteredPlugin {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous plugin entries — each has its own R
  plugin: ServerPlugin<any>;
  initialized: boolean;
}

export class ServerPluginRuntime {
  private plugins = new Map<string, RegisteredPlugin>();

  constructor(
    private readonly caps: Capabilities,
    private readonly game: GameContext,
  ) {}

  /**
   * Register a plugin. Builds the cap subset from the plugin's `requires`
   * and calls `init`. Throws on duplicate id; rethrows init failures
   * after logging.
   */
  async register<R extends CapName>(plugin: ServerPlugin<R>): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    const subset = {} as Pick<Capabilities, R>;
    for (const cap of plugin.requires) {
      // biome-ignore lint/suspicious/noExplicitAny: index assignment over discriminated key set
      (subset as any)[cap] = this.caps[cap];
    }
    try {
      await plugin.init(subset, this.game);
      this.plugins.set(plugin.id, { plugin, initialized: true });
    } catch (err) {
      console.error(`[plugin-runtime] init failed for ${plugin.id}:`, err);
      throw err;
    }
  }

  /**
   * Fan an envelope out to every registered plugin's `handleRelay`. Errors
   * thrown by one plugin are logged and swallowed so the next plugin still
   * receives the envelope. Returns the concatenation of any envelopes the
   * plugins emitted in response.
   */
  async handleRelay(env: RelayEnvelope): Promise<RelayEnvelope[]> {
    const out: RelayEnvelope[] = [];
    for (const { plugin } of this.plugins.values()) {
      if (!plugin.handleRelay) continue;
      try {
        const result = await plugin.handleRelay(env);
        if (result) out.push(...result);
      } catch (err) {
        console.error(`[plugin-runtime] handleRelay error in ${plugin.id}:`, err);
        // Don't crash the DO. Errors logged + swallowed.
      }
    }
    return out;
  }

  /**
   * Direct call into a specific plugin. Throws if the plugin is not
   * registered, or if it does not expose `handleCall`.
   */
  async handleCall(
    pluginId: string,
    name: string,
    args: unknown,
    viewer: SpectatorViewer,
  ): Promise<unknown> {
    const entry = this.plugins.get(pluginId);
    if (!entry) throw new PluginNotFoundError(pluginId);
    if (!entry.plugin.handleCall) {
      throw new PluginCallUnsupportedError(pluginId);
    }
    return entry.plugin.handleCall(name, args, viewer);
  }

  /** Whether a plugin id is registered. */
  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /**
   * Dispatch an alarm by name to every plugin that wants alarms. Errors
   * are logged + swallowed.
   */
  async handleAlarm(name: string): Promise<void> {
    for (const { plugin } of this.plugins.values()) {
      if (!plugin.handleAlarm) continue;
      try {
        await plugin.handleAlarm(name);
      } catch (err) {
        console.error(`[plugin-runtime] handleAlarm error in ${plugin.id}:`, err);
      }
    }
  }

  /**
   * Tear-down hook. Errors are logged + swallowed.
   */
  async dispose(): Promise<void> {
    for (const { plugin } of this.plugins.values()) {
      if (!plugin.dispose) continue;
      try {
        await plugin.dispose();
      } catch (err) {
        console.error(`[plugin-runtime] dispose error in ${plugin.id}:`, err);
      }
    }
  }
}

/** Raised when `handleCall` targets a plugin that isn't registered. */
export class PluginNotFoundError extends Error {
  constructor(public readonly pluginId: string) {
    super(`Plugin not registered: ${pluginId}`);
    this.name = 'PluginNotFoundError';
  }
}

/** Raised when `handleCall` targets a plugin that has no `handleCall` impl. */
export class PluginCallUnsupportedError extends Error {
  constructor(public readonly pluginId: string) {
    super(`Plugin does not support handleCall: ${pluginId}`);
    this.name = 'PluginCallUnsupportedError';
  }
}
