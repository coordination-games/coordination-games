import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../config.js';
import { parseTournamentState, type TournamentState } from './parse.js';

export type TournamentPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly state: TournamentState };

/** Poll cadence: brisk while a tournament is live, idle once it settles. */
const RUNNING_INTERVAL_MS = 4000;
const TERMINAL_INTERVAL_MS = 30000;

function nextIntervalMs(state: TournamentState): number {
  return state.status === 'running' ? RUNNING_INTERVAL_MS : TERMINAL_INTERVAL_MS;
}

/**
 * Poll `/api/tournaments/:id/state`, parsing each payload at the boundary.
 * Cancels the in-flight fetch and clears the timer on unmount or id change.
 * Slows to an idle cadence once the tournament is no longer running rather
 * than stopping outright, so a completed → (re-created) transition is still
 * observed without hammering the worker.
 */
export function useTournamentState(id: string): TournamentPhase {
  const [phase, setPhase] = useState<TournamentPhase>({ kind: 'loading' });

  // Keep the latest phase readable inside the polling closure without making
  // it a dependency (which would tear down and rebuild the loop every tick).
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    setPhase({ kind: 'loading' });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const url = `${API_BASE}/tournaments/${encodeURIComponent(id)}/state`;

    async function tick(): Promise<void> {
      try {
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
        const state = parseTournamentState(await res.json());
        if (cancelled) return;
        setPhase({ kind: 'ready', state });
        timer = setTimeout(tick, nextIntervalMs(state));
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Failed to load tournament';
        // Preserve the last good state on transient failure; only surface a
        // hard error when we have nothing to show.
        const prev = phaseRef.current;
        if (prev.kind === 'ready') {
          timer = setTimeout(tick, TERMINAL_INTERVAL_MS);
        } else {
          setPhase({ kind: 'error', message });
          timer = setTimeout(tick, TERMINAL_INTERVAL_MS);
        }
      }
    }

    tick();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [id]);

  return phase;
}
