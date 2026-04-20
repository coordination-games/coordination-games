/**
 * Phase 7.1 — useSpectatorStream.
 *
 * The single client-side surface for the unified spectator payload
 * (HTTP + WS share one builder server-side; this hook is the matching
 * thin client). Replaces the per-page WS lifecycle (open/close/parse/
 * reconnect/poll) that used to live in GamePage, LobbyPage, and each
 * SpectatorView.
 *
 * Behavior matrix:
 *
 *   live mode (default):
 *     1. Paint from `initialSnapshot` if provided (no flash).
 *     2. Open one WS to `wsPath`. The WS server emits a full snapshot on
 *        connect, then deltas on each broadcast. Each delta carries
 *        `meta.sinceIdx` — we forward it on the next reconnect attempt.
 *     3. On WS error/close, fall back to HTTP polling at `httpPath`
 *        every `pollMs` (default 2000). `isLive` flips to false.
 *     4. On the next connect attempt the polling loop is torn down and
 *        the WS resumes from the last `sinceIdx` we stored.
 *
 *   replay mode:
 *     - No WS. If `initialSnapshot` is provided we use it verbatim.
 *       Otherwise a single HTTP fetch hydrates the snapshot. `isLive`
 *       is always false.
 *
 * StrictMode-safe: a ref-tracked `mounted` flag short-circuits the
 * second cleanup pass that React 18 fires for an effect whose deps
 * haven't changed. `gameId` change tears down and rebuilds.
 *
 * NOTE: this hook does NOT subsume the rewind state machine in CtL's
 * SpectatorView (C1–C7 commits). That state needs the snapshot cache
 * AND game-specific `mapServerState` machinery, which this hook can't
 * own without leaking game-specific concerns. Pass 3 leaves rewind in
 * place and only refactors the WS lifecycle out into this hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, getWsUrl } from '../config.js';

// ---------------------------------------------------------------------------
// Wire types — mirror SpectatorPayload from
// packages/workers-server/src/plugins/spectator-payload.ts. Kept as a local
// duplicate (not imported) so the web package doesn't take a build-time
// dependency on the server package.
// ---------------------------------------------------------------------------

export interface RelayEnvelopeWire {
  index: number;
  type: string;
  pluginId: string;
  sender: string;
  scope:
    | { kind: 'all' }
    | { kind: 'team'; teamId: string }
    | { kind: 'dm'; recipientHandle: string };
  turn: number | null;
  timestamp: number;
  /** Per-type relay body shape is owned by the producing plugin; narrow on consume. */
  data: unknown;
}

export interface SpectatorPayloadMeta {
  gameId: string;
  gameType: string;
  handles: Record<string, string>;
  progressCounter: number | null;
  finished: boolean;
  sinceIdx: number;
  lastUpdate: number;
}

export interface SpectatorStateUpdatePayload {
  type: 'state_update';
  meta: SpectatorPayloadMeta;
  state: unknown;
  relay: RelayEnvelopeWire[];
}

export interface SpectatorPendingPayload {
  type: 'spectator_pending';
  meta: SpectatorPayloadMeta;
}

export type SpectatorPayload = SpectatorStateUpdatePayload | SpectatorPendingPayload;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type SpectatorStreamMode = 'live' | 'replay';

export interface UseSpectatorStreamOptions {
  /** 'live' (default) opens a WS; 'replay' is HTTP-only. */
  mode?: SpectatorStreamMode;
  /** Pre-seeded payload for SSR / replay / instant first paint. */
  initialSnapshot?: SpectatorPayload | undefined;
  /**
   * Override the routes. Defaults work for game spectator streams:
   *   ws  : `/ws/game/:id` → `/ws/game/${gameId}`
   *   http: `/games/:id`   → `${API_BASE}/games/${gameId}`
   * Lobbies override these to `/ws/lobby/${id}` and `${API_BASE}/lobbies/${id}`.
   */
  wsPath?: (gameId: string) => string;
  httpPath?: (gameId: string) => string;
  /** Polling cadence during HTTP fallback. Default 2000 ms. */
  pollMs?: number;
}

export interface UseSpectatorStreamResult {
  snapshot: SpectatorPayload | undefined;
  /** True while a WS is OPEN. False during HTTP-only fallback or pre-connect. */
  isLive: boolean;
  /** Last server-authoritative `meta.sinceIdx` we observed. */
  sinceIdx: number;
  error: Error | null;
}

const DEFAULT_WS_PATH = (id: string) => `/ws/game/${id}`;
const DEFAULT_HTTP_PATH = (id: string) => `${API_BASE}/games/${id}`;

export function useSpectatorStream(
  gameId: string,
  opts: UseSpectatorStreamOptions = {},
): UseSpectatorStreamResult {
  const mode: SpectatorStreamMode = opts.mode ?? 'live';
  const initialSnapshot = opts.initialSnapshot;
  const wsPath = opts.wsPath ?? DEFAULT_WS_PATH;
  const httpPath = opts.httpPath ?? DEFAULT_HTTP_PATH;
  const pollMs = opts.pollMs ?? 2000;

  const [snapshot, setSnapshot] = useState<SpectatorPayload | undefined>(initialSnapshot);
  const [isLive, setIsLive] = useState(false);
  const [sinceIdx, setSinceIdx] = useState<number>(initialSnapshot?.meta.sinceIdx ?? 0);
  const [error, setError] = useState<Error | null>(null);

  // Refs that must survive re-renders without re-firing the effect.
  const wsRef = useRef<WebSocket | null>(null);
  const sinceIdxRef = useRef<number>(initialSnapshot?.meta.sinceIdx ?? 0);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Generation counter — bumps every time `gameId`/`mode` flips. Stale
  // async resolutions (HTTP fetches, WS messages from a closing socket)
  // check this before applying state.
  const genRef = useRef(0);

  // Apply a payload uniformly from any transport.
  const applyPayload = useCallback((payload: SpectatorPayload, gen: number) => {
    if (gen !== genRef.current) return;
    setSnapshot(payload);
    sinceIdxRef.current = payload.meta.sinceIdx;
    setSinceIdx(payload.meta.sinceIdx);
  }, []);

  // ─────────────────────────────────────────────────────────────────────
  // Replay mode: no WS. Single HTTP hydrate (skipped if initialSnapshot).
  // ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'replay' || !gameId) return;
    genRef.current += 1;
    const gen = genRef.current;
    setIsLive(false);
    if (initialSnapshot) {
      // Honor the caller-provided snapshot verbatim — replay state is
      // typically static so a single fetch is wasted bandwidth.
      return;
    }
    let cancelled = false;
    fetch(httpPath(gameId), { cache: 'no-store' })
      .then((r) => r.json() as Promise<SpectatorPayload>)
      .then((p) => {
        if (cancelled) return;
        applyPayload(p, gen);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      cancelled = true;
    };
    // `initialSnapshot` is intentionally referenced by closure. We don't
    // include it in deps because mid-stream identity changes from a
    // parent re-render must NOT re-fetch — the caller controls re-mount
    // via React key when they want a fresh hydrate.
  }, [gameId, mode, httpPath, applyPayload, initialSnapshot]);

  // ─────────────────────────────────────────────────────────────────────
  // Live mode: initial HTTP paint (when no initialSnapshot) + WS connect.
  // ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'live' || !gameId) return;

    genRef.current += 1;
    const gen = genRef.current;

    // Reset cursor whenever the gameId changes — `sinceIdx` from a
    // previous game is meaningless in the new game's index space.
    sinceIdxRef.current = initialSnapshot?.meta.sinceIdx ?? 0;
    setSinceIdx(sinceIdxRef.current);
    setError(null);

    // Helper: start HTTP polling loop. Used as a fallback when WS dies.
    const startPolling = () => {
      stopPolling();
      const tick = () => {
        const url = `${httpPath(gameId)}?sinceIdx=${sinceIdxRef.current}`;
        fetch(url, { cache: 'no-store' })
          .then((r) => r.json() as Promise<SpectatorPayload>)
          .then((p) => applyPayload(p, gen))
          .catch(() => {
            // Swallow individual poll failures; the next tick will retry.
          });
      };
      tick();
      pollTimerRef.current = setInterval(tick, pollMs);
    };
    const stopPolling = () => {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    // Initial paint:
    //   - If caller provided initialSnapshot: trust it; skip the HTTP hit.
    //   - Otherwise: one HTTP fetch BEFORE the WS opens to avoid the blank
    //     frame between mount and the WS's first message.
    let cancelledInitial = false;
    if (!initialSnapshot) {
      fetch(httpPath(gameId), { cache: 'no-store' })
        .then((r) => r.json() as Promise<SpectatorPayload>)
        .then((p) => {
          if (cancelledInitial) return;
          applyPayload(p, gen);
        })
        .catch(() => {
          // If the initial HTTP fetch fails the WS connect below will
          // either succeed (and overwrite) or fail (and trigger polling).
        });
    }

    // Open the WS. Defer slightly so React StrictMode's first cleanup
    // (which runs immediately in dev) doesn't tear down the socket
    // before we even acknowledge it. The `gen` check inside handlers
    // also protects against late deliveries from a torn-down socket.
    const url = getWsUrl(wsPath(gameId));
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      startPolling();
      return () => {
        cancelledInitial = true;
        stopPolling();
      };
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (gen !== genRef.current) return;
      setIsLive(true);
      setError(null);
      stopPolling();
    };
    ws.onmessage = (event) => {
      if (gen !== genRef.current) return;
      try {
        const payload = JSON.parse(event.data) as SpectatorPayload;
        applyPayload(payload, gen);
      } catch {
        // Malformed frame — ignore. The next valid frame will land us back
        // on a consistent payload.
      }
    };
    ws.onerror = () => {
      if (gen !== genRef.current) return;
      setError(new Error('WebSocket error'));
    };
    ws.onclose = () => {
      if (gen !== genRef.current) return;
      setIsLive(false);
      // Fall back to HTTP polling so the UI keeps refreshing while we
      // can't reach the WS. We deliberately don't auto-reconnect the WS
      // here — a fresh mount (e.g. the user navigates back) re-runs the
      // effect and gets a clean WS. Continuous reconnect loops are a
      // separate concern; the polling fallback covers transient drops.
      startPolling();
    };

    return () => {
      cancelledInitial = true;
      // Bump the generation so any in-flight async work bails before
      // touching state.
      genRef.current += 1;
      stopPolling();
      try {
        ws.close();
      } catch {}
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [gameId, mode, wsPath, httpPath, pollMs, applyPayload, initialSnapshot]);

  return { snapshot, isLive, sinceIdx, error };
}

// ---------------------------------------------------------------------------
// Path helpers — exported so callers can reuse the standard URLs.
// ---------------------------------------------------------------------------

export const lobbyWsPath = (id: string): string => `/ws/lobby/${id}`;
export const lobbyHttpPath = (id: string): string => `${API_BASE}/lobbies/${id}`;
export const gameWsPath = (id: string): string => `/ws/game/${id}`;
export const gameHttpPath = (id: string): string => `${API_BASE}/games/${id}`;
