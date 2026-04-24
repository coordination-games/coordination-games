/**
 * Worker-level plugin runtime + `/api/plugin/:pluginId/call` dispatcher.
 *
 * Phase 5.2 introduces the global plugin endpoint. ELO is the first
 * plugin (`leaderboard`, `my-stats`); settlement and others migrate to
 * the same shape later.
 *
 * Why this lives at the worker level (NOT inside a Durable Object): ELO
 * is cross-game / cross-DO. Per-DO `ServerPluginRuntime` instances
 * (Phase 5.3 settlement, future per-game plugins) coexist as separate
 * runtime instances. The two scopes don't share registrations.
 *
 * The runtime itself is constructed lazily on first call so cold starts
 * pay nothing for unused plugins. Re-construction across requests is
 * cheap (a Map + `init` calls — D1 binding is the only cap).
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from './env.js';
import type { Capabilities, SpectatorViewer } from './plugins/capabilities.js';
import {
  createEloServerPlugin,
  EloAuthRequiredError,
  EloUnknownCallError,
} from './plugins/elo/index.js';
import {
  PluginCallUnsupportedError,
  PluginNotFoundError,
  ServerPluginRuntime,
} from './plugins/runtime.js';

// ---------------------------------------------------------------------------
// Endpoint-side errors — the route handler maps these to HTTP status codes.
// ---------------------------------------------------------------------------

export class PluginEndpointNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginEndpointNotFoundError';
  }
}

export class PluginEndpointBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginEndpointBadRequestError';
  }
}

export class PluginEndpointUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginEndpointUnauthorizedError';
  }
}

// ---------------------------------------------------------------------------
// Worker-level runtime singleton
// ---------------------------------------------------------------------------

let _runtime: ServerPluginRuntime | null = null;
let _runtimeReady: Promise<ServerPluginRuntime> | null = null;

/**
 * Build the worker-level plugin runtime. Idempotent — concurrent calls
 * during a cold start share the same in-flight init promise.
 *
 * The worker-level runtime ONLY exposes capabilities that make sense
 * outside a DO. `relay`, `alarms`, `storage` are per-DO; here they're
 * stubbed (any plugin that requires them must be registered in a DO
 * runtime instead, not here).
 */
export function getWorkerPluginRuntime(env: Env): Promise<ServerPluginRuntime> {
  if (_runtime) return Promise.resolve(_runtime);
  if (_runtimeReady) return _runtimeReady;

  _runtimeReady = (async () => {
    const caps = buildWorkerCapabilities(env.DB);
    const runtime = new ServerPluginRuntime(caps, { gameId: '__worker__' });
    await runtime.register(createEloServerPlugin());
    _runtime = runtime;
    return runtime;
  })();

  return _runtimeReady;
}

/** Test hook — drop the cached runtime so each test boots fresh. */
export function _resetWorkerPluginRuntimeForTests(): void {
  _runtime = null;
  _runtimeReady = null;
}

// ---------------------------------------------------------------------------
// Capabilities — worker scope (no DO storage / no per-game relay).
// ---------------------------------------------------------------------------

/**
 * Stubs for caps that don't make sense outside a DO. Throw on use so a
 * misconfigured plugin (one requiring `relay` registered at worker scope)
 * fails loudly at the first call rather than silently no-op'ing.
 */
function buildWorkerCapabilities(d1: D1Database): Capabilities {
  const reject = (cap: string) => {
    throw new Error(
      `Capability '${cap}' is not available at worker scope — register this plugin in a Durable Object runtime instead.`,
    );
  };
  return {
    d1,
    storage: {
      async get() {
        return reject('storage');
      },
      async put() {
        reject('storage');
      },
      async delete() {
        return reject('storage');
      },
      async list() {
        return reject('storage');
      },
    },
    relay: {
      async publish() {
        reject('relay');
      },
      async visibleTo() {
        return reject('relay');
      },
      async since() {
        return reject('relay');
      },
      async getTip() {
        return reject('relay');
      },
    },
    alarms: {
      async scheduleAt() {
        reject('alarms');
      },
      async cancel() {
        reject('alarms');
      },
    },
    chain: {
      async submit() {
        return reject('chain');
      },
      async pollReceipt() {
        return reject('chain');
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a `POST /api/plugin/:pluginId/call` to the worker runtime.
 *
 * `playerId` is the result of `validateBearerToken(request, env)` — a
 * non-null playerId means an authenticated viewer; null means the caller
 * is treated as an anonymous spectator.
 *
 * Throws one of the `PluginEndpoint*Error` subclasses; the route handler
 * maps each to its HTTP status code.
 */
export async function handlePluginCall(
  env: Env,
  pluginId: string,
  name: string,
  args: unknown,
  playerId: string | null,
): Promise<unknown> {
  const runtime = await getWorkerPluginRuntime(env);
  if (!runtime.has(pluginId)) {
    throw new PluginEndpointNotFoundError(`Unknown plugin: ${pluginId}`);
  }

  const viewer: SpectatorViewer = playerId ? { kind: 'player', playerId } : { kind: 'spectator' };

  try {
    return await runtime.handleCall(pluginId, name, args, viewer);
  } catch (err) {
    if (err instanceof PluginNotFoundError) {
      throw new PluginEndpointNotFoundError(err.message);
    }
    if (err instanceof PluginCallUnsupportedError) {
      throw new PluginEndpointBadRequestError(err.message);
    }
    if (err instanceof EloUnknownCallError) {
      throw new PluginEndpointBadRequestError(err.message);
    }
    if (err instanceof EloAuthRequiredError) {
      throw new PluginEndpointUnauthorizedError(err.message);
    }
    throw err;
  }
}
