import { useEffect, useState } from 'react';
import { useMatch } from 'react-router-dom';
import { fetchGame, fetchLobby, fetchReplay } from '../api';
import { getDefaultPlugin, getSpectatorPlugin, type SpectatorPlugin } from '../games';

function extractLobbyGameType(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const direct = (payload as { gameType?: unknown }).gameType;
  if (typeof direct === 'string') return direct;
  const state = (payload as { state?: unknown }).state;
  if (!state || typeof state !== 'object') return undefined;
  const nested = (state as { gameType?: unknown }).gameType;
  return typeof nested === 'string' ? nested : undefined;
}

/**
 * Resolve the active game's `SpectatorPlugin` from the current URL so the
 * shell (Layout, etc.) can render branding without hardcoding a game type.
 *
 * Routes that identify a specific game:
 *   /lobby/:id  → fetchLobby → gameType
 *   /game/:id   → fetchGame  → gameType
 *   /replay/:id → fetchReplay → gameType
 *
 * On routes with no game context (e.g. `/`, `/lobbies`, `/leaderboard`),
 * we fall back to `getDefaultPlugin()` (the first registered plugin).
 *
 * The fetch is cached per `:id` for the lifetime of the page — if the user
 * navigates between games the hook re-resolves on the next render.
 */
export function useActiveGame(): SpectatorPlugin {
  const lobbyMatch = useMatch('/lobby/:id');
  const gameMatch = useMatch('/game/:id');
  const replayMatch = useMatch('/replay/:id');

  const [resolvedGameType, setResolvedGameType] = useState<string | null>(null);

  // Determine which scope+id is in the URL right now (if any).
  const scope = lobbyMatch ? 'lobby' : gameMatch ? 'game' : replayMatch ? 'replay' : null;
  const id = lobbyMatch?.params.id ?? gameMatch?.params.id ?? replayMatch?.params.id ?? null;

  useEffect(() => {
    if (!scope || !id) {
      setResolvedGameType(null);
      return;
    }
    let cancelled = false;
    const fetcher =
      scope === 'lobby'
        ? fetchLobby(id).then(extractLobbyGameType)
        : scope === 'game'
          ? fetchGame(id).then((d) => (d as { gameType?: string } | null)?.gameType)
          : fetchReplay(id).then((d) => d.gameType);
    fetcher
      .then((gt) => {
        if (!cancelled && typeof gt === 'string') setResolvedGameType(gt);
      })
      .catch(() => {
        // On failure we just fall through to the default plugin.
      });
    return () => {
      cancelled = true;
    };
  }, [scope, id]);

  if (resolvedGameType) {
    const p = getSpectatorPlugin(resolvedGameType);
    if (p) return p;
  }
  return getDefaultPlugin();
}
