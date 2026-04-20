/**
 * Frontend helper for the unified plugin-call endpoint
 * (`POST /api/plugin/:pluginId/call`, Phase 5.2).
 *
 * Every server-plugin call from the web shell goes through here — there
 * are no per-plugin bespoke REST endpoints. Identity is supplied via the
 * `Authorization: Bearer <token>` header when present; the worker maps
 * the bearer to a `playerId` and the plugin sees a `{ kind: 'player' }`
 * viewer. With no bearer the plugin sees `{ kind: 'spectator' }`.
 */

import { API_BASE } from '../config.js';

/** Optional bearer token from the wallet-auth flow. Returns null in spectator mode. */
function getAuthHeader(): string | null {
  if (typeof window === 'undefined') return null;
  const token = window.localStorage?.getItem('ctl_session_token');
  return token ? `Bearer ${token}` : null;
}

/** Server's structured `{ error: string }` payload. */
export class PluginCallError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'PluginCallError';
    this.status = status;
  }
}

export async function callPlugin<T>(pluginId: string, name: string, args: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = getAuthHeader();
  if (auth) headers.Authorization = auth;

  const r = await fetch(`${API_BASE}/plugin/${pluginId}/call`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, args }),
  });

  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const body = (await r.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      // body wasn't JSON; surface the status text
      msg = r.statusText || msg;
    }
    throw new PluginCallError(`plugin call failed: ${msg}`, r.status);
  }

  return (await r.json()) as T;
}
