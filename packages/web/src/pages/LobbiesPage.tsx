import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchGames, type GameSummary } from '../api';
import { API_BASE } from '../config.js';
import { CaptureTheLobsterSpectator } from '../games/capture-the-lobster';
import { OathbreakerSpectator } from '../games/oathbreaker';
import { getAllPlugins, getDefaultPlugin } from '../games/registry';
import { getRegisteredWebPlugins, SlotHost } from '../plugins';
import type { GameSummaryView, LobbySummaryView } from '../plugins/types';

// Per-game IDs sourced from the spectator plugins (their `gameType` fields
// are the SOURCE OF TRUTH for the web bundle — see games/registry.ts). The
// game-specific create-form widgets below switch on these IDs; once a
// `lobby:create-form` slot lands the form moves into each web plugin and
// these constants go away.
const CTL_ID = CaptureTheLobsterSpectator.gameType;
const OATH_ID = OathbreakerSpectator.gameType;

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
    <button
      type="button"
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
  const [gameTab, setGameTab] = useState<string>(getDefaultPlugin().gameType);
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
      // Each game's create payload is currently game-specific (CtL: `teamSize`,
      // OATH: `playerCount`). Once `lobby:create-form` becomes a slot the
      // payload move into the per-game web plugin and this branch goes away.
      const body =
        gameTab === OATH_ID
          ? { gameType: OATH_ID, playerCount: oathPlayerCount }
          : { gameType: gameTab, teamSize };
      const res = await fetch(`${API_BASE}/lobbies/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        navigate(`/lobby/${data.lobbyId}`);
        return;
      }
    } catch {}
    setCreating(false);
  }

  // Default unknown gameTypes onto the default plugin's id so legacy rows
  // (no `gameType` column populated) still render under a tab.
  const defaultId = getDefaultPlugin().gameType;
  const filteredGames = games.filter((g) => (g.gameType ?? defaultId) === gameTab);
  const filteredLobbies = lobbies.filter((l) => (l.gameType ?? defaultId) === gameTab);
  const activeGames = filteredGames.filter((g) => g.phase !== 'finished');
  const finishedGames = filteredGames.filter((g) => g.phase === 'finished');

  return (
    <div className="space-y-12">
      {/* Page eyebrow + headline */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-[11px] tracking-[0.22em] uppercase"
            style={{ color: 'var(--color-ash)' }}
          >
            01
          </span>
          <span
            className="font-mono text-[11px] tracking-[0.22em] uppercase"
            style={{ color: 'var(--color-warm-black)' }}
          >
            Lobbies
          </span>
          <div className="flex-1 hairline" />
        </div>
        <h1
          className="font-display text-4xl sm:text-5xl font-medium tracking-tight leading-tight"
          style={{ color: 'var(--color-warm-black)' }}
        >
          Find a team.
          <br />
          <span style={{ color: 'var(--color-mint-deep)' }}>Open a match.</span>
        </h1>
      </div>

      {/* Game type tabs + create controls */}
      <div className="flex flex-col gap-4">
        {/* Tab selector — one tab per registered spectator plugin. Each
            plugin contributes its own brand color for the active state. */}
        <div className="flex items-center gap-2">
          {getAllPlugins().map((plugin) => {
            const active = gameTab === plugin.gameType;
            return (
              <button
                type="button"
                key={plugin.gameType}
                onClick={() => setGameTab(plugin.gameType)}
                className="cursor-pointer px-4 h-10 font-mono text-[11px] tracking-[0.18em] uppercase font-medium transition-colors"
                style={
                  active
                    ? {
                        background: 'var(--color-warm-black)',
                        color: 'var(--color-mint)',
                        border: '1px solid var(--color-warm-black)',
                      }
                    : {
                        background: 'transparent',
                        color: 'var(--color-graphite)',
                        border: '1px solid var(--color-graphite)',
                      }
                }
              >
                {plugin.branding.longName}
              </button>
            );
          })}
        </div>

        {/* Create controls — per-game form still lives here (follow-up task
            promotes it to a `lobby:create-form` slot); the tab id governs
            which widget shows. */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 p-4"
          style={{ background: 'var(--color-bone)', border: '1px solid rgba(28,26,23,0.1)' }}
        >
          {gameTab === CTL_ID ? (
            <div className="flex items-center gap-1.5">
              <span
                className="font-mono text-[10px] tracking-[0.22em] uppercase mr-1"
                style={{ color: 'var(--color-ash)' }}
              >
                Size
              </span>
              {[2, 3, 4, 5, 6].map((size) => (
                <button
                  type="button"
                  key={size}
                  onClick={() => setTeamSize(size)}
                  className="cursor-pointer w-9 h-9 font-mono text-[11px] font-medium transition-colors"
                  style={
                    teamSize === size
                      ? {
                          background: 'var(--color-mint)',
                          color: 'var(--color-warm-black)',
                          border: '1px solid var(--color-mint-deep)',
                        }
                      : {
                          color: 'var(--color-graphite)',
                          border: '1px solid var(--color-stone)',
                          background: 'transparent',
                        }
                  }
                >
                  {size}v{size}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span
                className="font-mono text-[10px] tracking-[0.22em] uppercase mr-1"
                style={{ color: 'var(--color-ash)' }}
              >
                Players
              </span>
              {[4, 6, 8, 10, 12, 16, 20].map((count) => (
                <button
                  type="button"
                  key={count}
                  onClick={() => setOathPlayerCount(count)}
                  className="cursor-pointer w-9 h-9 font-mono text-[11px] font-medium transition-colors"
                  style={
                    oathPlayerCount === count
                      ? {
                          background: 'var(--color-hot)',
                          color: 'var(--color-warm-black)',
                          border: '1px solid var(--color-hot-deep)',
                        }
                      : {
                          color: 'var(--color-graphite)',
                          border: '1px solid var(--color-stone)',
                          background: 'transparent',
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
            className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
            whileTap={{ scale: 0.98 }}
          >
            {creating ? 'Creating…' : 'Open Lobby →'}
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
              const gt = lobby.gameType ?? defaultId;
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
          <div className="py-16 text-center" style={{ border: '1px dashed var(--color-stone)' }}>
            <p
              className="font-mono text-[11px] tracking-[0.22em] uppercase"
              style={{ color: 'var(--color-ash)' }}
            >
              <span style={{ color: 'var(--color-mint-deep)' }}>{'// '}</span>
              No active games
            </p>
            <p
              className="font-editorial italic text-sm mt-3"
              style={{ color: 'var(--color-graphite)' }}
            >
              Create a lobby to open the next match.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activeGames.map((game, i) => {
              const gt = game.gameType ?? defaultId;
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
              const gt = game.gameType ?? defaultId;
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
      <span
        className="font-mono text-[11px] tracking-[0.22em] uppercase"
        style={{ color: 'var(--color-warm-black)' }}
      >
        {title}
      </span>
      {count !== undefined && (
        <span
          className="font-mono text-[10px] tracking-[0.18em] uppercase px-1.5 py-0.5"
          style={{
            background: 'var(--color-warm-black)',
            color: 'var(--color-mint)',
          }}
        >
          {String(count).padStart(2, '0')}
        </span>
      )}
      <div className="flex-1 hairline" />
    </div>
  );
}
