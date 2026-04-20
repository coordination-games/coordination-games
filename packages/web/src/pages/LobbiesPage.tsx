import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchGames, type GameSummary } from '../api';
import { API_BASE } from '../config.js';
import { getRegisteredWebPlugins, SlotHost } from '../plugins';
import type { GameSummaryView, LobbySummaryView } from '../plugins/types';

function FallbackCard({
  id,
  gameType,
  onClick,
}: {
  id: string;
  gameType?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  return (
    // biome-ignore lint/a11y/useButtonType: matches sibling LobbiesPage button styling
    <button
      onClick={onClick}
      className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md"
      style={{
        // Loud-but-not-broken: amber border so a missing plugin is visible
        // during dev without crashing the page for users.
        border: '1px dashed var(--color-amber)',
      }}
    >
      <div className="mb-2 font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
        {id}
      </div>
      <div className="text-sm" style={{ color: 'var(--color-ink-light)' }}>
        Unknown game type:{' '}
        <span className="font-mono" style={{ color: 'var(--color-amber)' }}>
          {gameType ?? '(none)'}
        </span>
      </div>
      <div className="mt-1 text-xs" style={{ color: 'var(--color-ink-faint)', opacity: 0.7 }}>
        No `lobby:card` plugin registered for this game.
      </div>
    </button>
  );
}

export default function LobbiesPage() {
  const [games, setGames] = useState<GameSummaryView[]>([]);
  const [lobbies, setLobbies] = useState<LobbySummaryView[]>([]);
  const [creating, setCreating] = useState(false);
  const [teamSize, setTeamSize] = useState(2);
  const [gameTab, setGameTab] = useState<'capture-the-lobster' | 'oathbreaker'>(
    'capture-the-lobster',
  );
  const [oathPlayerCount, setOathPlayerCount] = useState(4);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [gamesData, lobbiesData] = await Promise.all([
          fetchGames(),
          fetch(`${API_BASE}/lobbies`)
            .then((r) => r.json())
            .catch(() => []),
        ]);
        if (!cancelled) {
          const mapped: GameSummaryView[] = gamesData.map((g: GameSummary) => ({
            id: g.gameId,
            gameType: g.gameType,
            turn: g.turn ?? 0,
            maxTurns: g.maxTurns ?? 30,
            phase: g.finished ? ('finished' as const) : ('in_progress' as const),
            winner: g.winner,
            teamsA: g.teams?.A?.length ?? 0,
            teamsB: g.teams?.B?.length ?? 0,
            round: g.round,
            maxRounds: g.maxRounds,
            playerCount: g.playerCount,
          }));
          setGames(mapped);
          setLobbies((lobbiesData as LobbySummaryView[]).filter((l) => l.phase === 'lobby'));
        }
      } catch {}
    }
    load();
    const interval = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleCreateLobby() {
    setCreating(true);
    try {
      if (gameTab === 'oathbreaker') {
        const res = await fetch(`${API_BASE}/lobbies/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gameType: 'oathbreaker', playerCount: oathPlayerCount }),
        });
        if (res.ok) {
          const data = await res.json();
          navigate(`/lobby/${data.lobbyId}`);
          return;
        }
      } else {
        const res = await fetch(`${API_BASE}/lobbies/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamSize }),
        });
        if (res.ok) {
          const data = await res.json();
          navigate(`/lobby/${data.lobbyId}`);
          return;
        }
      }
    } catch {}
    setCreating(false);
  }

  const filteredGames = games.filter((g) => (g.gameType ?? 'capture-the-lobster') === gameTab);
  const filteredLobbies = lobbies.filter((l) => (l.gameType ?? 'capture-the-lobster') === gameTab);
  const activeGames = filteredGames.filter((g) => g.phase !== 'finished');
  const finishedGames = filteredGames.filter((g) => g.phase === 'finished');

  return (
    <div className="space-y-12">
      {/* Game type tabs + create controls */}
      <div className="flex flex-col gap-3">
        {/* Tab selector */}
        <div className="flex items-center gap-2">
          {/* biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup) */}
          <button
            onClick={() => setGameTab('capture-the-lobster')}
            className="cursor-pointer rounded-lg px-4 py-2 text-sm font-heading font-semibold tracking-wide transition-all"
            style={
              gameTab === 'capture-the-lobster'
                ? {
                    background: 'rgba(58, 90, 42, 0.15)',
                    color: 'var(--color-forest)',
                    border: '1px solid rgba(58, 90, 42, 0.3)',
                  }
                : {
                    background: 'transparent',
                    color: 'var(--color-ink-faint)',
                    border: '1px solid rgba(42, 31, 14, 0.15)',
                  }
            }
          >
            Capture the Lobster
          </button>
          {/* biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup) */}
          <button
            onClick={() => setGameTab('oathbreaker')}
            className="cursor-pointer rounded-lg px-4 py-2 text-sm font-heading font-semibold tracking-wide transition-all"
            style={
              gameTab === 'oathbreaker'
                ? {
                    background: 'rgba(139, 32, 32, 0.12)',
                    color: 'var(--color-blood)',
                    border: '1px solid rgba(139, 32, 32, 0.3)',
                  }
                : {
                    background: 'transparent',
                    color: 'var(--color-ink-faint)',
                    border: '1px solid rgba(42, 31, 14, 0.15)',
                  }
            }
          >
            OATHBREAKER
          </button>
        </div>

        {/* Create controls */}
        <div className="flex items-center justify-end gap-3">
          {gameTab === 'capture-the-lobster' ? (
            <div className="flex items-center gap-2">
              {[2, 3, 4, 5, 6].map((size) => (
                // biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup)
                <button
                  key={size}
                  onClick={() => setTeamSize(size)}
                  className={`cursor-pointer rounded-md px-2.5 py-1 text-xs font-mono font-medium transition-colors`}
                  style={
                    teamSize === size
                      ? {
                          background: 'rgba(212, 162, 78, 0.15)',
                          color: 'var(--color-amber-glow)',
                          border: '1px solid rgba(212, 162, 78, 0.4)',
                        }
                      : {
                          color: 'var(--color-ink-faint)',
                          border: '1px solid rgba(42, 31, 14, 0.15)',
                        }
                  }
                >
                  {size}v{size}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono" style={{ color: 'var(--color-ink-faint)' }}>
                Players:
              </span>
              {[4, 6, 8, 10, 12, 16, 20].map((count) => (
                // biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup)
                <button
                  key={count}
                  onClick={() => setOathPlayerCount(count)}
                  className={`cursor-pointer rounded-md px-2.5 py-1 text-xs font-mono font-medium transition-colors`}
                  style={
                    oathPlayerCount === count
                      ? {
                          background: 'rgba(139, 32, 32, 0.15)',
                          color: 'var(--color-blood-light, #c55)',
                          border: '1px solid rgba(139, 32, 32, 0.4)',
                        }
                      : {
                          color: 'var(--color-ink-faint)',
                          border: '1px solid rgba(42, 31, 14, 0.15)',
                        }
                  }
                >
                  {count}
                </button>
              ))}
            </div>
          )}
          <motion.button
            onClick={handleCreateLobby}
            disabled={creating}
            className="cursor-pointer font-heading rounded-lg px-5 py-2 text-sm font-semibold tracking-wider uppercase disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:brightness-110"
            style={{
              border: '1px solid rgba(184, 134, 11, 0.3)',
              background: 'rgba(184, 134, 11, 0.08)',
              color: 'var(--color-amber)',
            }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            {creating ? 'Creating...' : 'Create Lobby'}
          </motion.button>
        </div>
      </div>

      {filteredLobbies.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <SectionHeader title="Active Lobbies" count={filteredLobbies.length} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredLobbies.map((lobby, i) => {
              const gt = lobby.gameType ?? 'capture-the-lobster';
              return (
                <motion.div
                  key={lobby.lobbyId}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.4 }}
                >
                  <SlotHostOrFallback
                    fallbackId={lobby.lobbyId}
                    gameType={gt}
                    lobby={lobby}
                    onClick={() => navigate(`/lobby/${lobby.lobbyId}`)}
                  />
                </motion.div>
              );
            })}
          </div>
        </motion.section>
      )}

      <motion.section
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.5 }}
      >
        <SectionHeader
          title="Active Games"
          count={activeGames.length > 0 ? activeGames.length : undefined}
        />
        {activeGames.length === 0 ? (
          <div className="rounded-xl py-12 text-center parchment" style={{ borderStyle: 'dashed' }}>
            <p className="text-sm" style={{ color: 'var(--color-ink-faint)' }}>
              No active games right now.
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--color-ink-faint)', opacity: 0.6 }}>
              Create a lobby to begin.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activeGames.map((game, i) => {
              const gt = game.gameType ?? 'capture-the-lobster';
              return (
                <motion.div
                  key={game.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.4 }}
                >
                  <SlotHostOrFallback
                    fallbackId={game.id}
                    gameType={gt}
                    gameSummary={game}
                    onClick={() => navigate(`/game/${game.id}`)}
                  />
                </motion.div>
              );
            })}
          </div>
        )}
      </motion.section>

      {finishedGames.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.5 }}
        >
          <SectionHeader title="Recent Games" count={finishedGames.length} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {finishedGames.map((game, i) => {
              const gt = game.gameType ?? 'capture-the-lobster';
              return (
                <motion.div
                  key={game.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.4 }}
                >
                  <SlotHostOrFallback
                    fallbackId={game.id}
                    gameType={gt}
                    gameSummary={game}
                    onClick={() => navigate(`/replay/${game.id}`)}
                  />
                </motion.div>
              );
            })}
          </div>
        </motion.section>
      )}
    </div>
  );
}

/**
 * Wraps `<SlotHost name="lobby:card">` with a fallback render path for game
 * types that don't have a registered `lobby:card` plugin. Detection works
 * by sniffing the registered plugin set: if no plugin claims this gameType,
 * we render `FallbackCard` instead. Loud-but-not-broken (amber dashed
 * border) makes a missing plugin obvious during dev without breaking users.
 */
function SlotHostOrFallback(props: {
  fallbackId: string;
  gameType: string;
  lobby?: LobbySummaryView | undefined;
  gameSummary?: GameSummaryView | undefined;
  onClick: () => void;
}) {
  const hasPlugin = getRegisteredWebPlugins().some(
    (p) => p.gameType === props.gameType && p.slots['lobby:card'],
  );
  if (!hasPlugin) {
    return <FallbackCard id={props.fallbackId} gameType={props.gameType} onClick={props.onClick} />;
  }
  return (
    <SlotHost
      name="lobby:card"
      gameType={props.gameType}
      lobby={props.lobby}
      gameSummary={props.gameSummary}
      onClick={props.onClick}
    />
  );
}

function SectionHeader({ title, count }: { title: string; count?: number | undefined }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <h2
        className="font-heading text-lg font-bold tracking-wide"
        style={{ color: 'var(--color-ink)' }}
      >
        {title}
      </h2>
      {count !== undefined && (
        <span
          className="text-xs font-mono font-medium rounded-full px-2.5 py-0.5"
          style={{
            background: 'rgba(184, 134, 11, 0.1)',
            color: 'var(--color-amber)',
            border: '1px solid rgba(184, 134, 11, 0.2)',
          }}
        >
          {count}
        </span>
      )}
      <div
        className="flex-1 h-px"
        style={{ background: 'linear-gradient(to right, rgba(42, 31, 14, 0.15), transparent)' }}
      />
    </div>
  );
}
