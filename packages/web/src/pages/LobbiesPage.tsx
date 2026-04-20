import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchGames, type GameSummary } from '../api';
import { API_BASE } from '../config.js';

interface Game {
  id: string;
  gameType?: string;
  turn: number;
  maxTurns: number;
  phase: 'in_progress' | 'finished';
  winner?: string;
  teamsA: number;
  teamsB: number;
  // OATHBREAKER fields
  round?: number;
  maxRounds?: number;
  playerCount?: number;
}

interface Lobby {
  lobbyId: string;
  gameType?: string;
  // Unified GamePhaseKind from the engine — 'lobby' (still accepting joins),
  // 'in_progress' (game spawned), 'finished' (terminal — game done OR lobby
  // errored; presence of `error` on the lobby state distinguishes).
  phase: 'lobby' | 'in_progress' | 'finished';
  teamSize?: number;
  playerCount?: number;
  createdAt?: string;
  gameId?: string | null;
}

function phaseBadge(phase: string) {
  switch (phase) {
    case 'in_progress':
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
          style={{
            background: 'rgba(58, 90, 42, 0.1)',
            color: 'var(--color-forest)',
            border: '1px solid rgba(58, 90, 42, 0.2)',
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--color-forest-light)' }}
          />
          Live
        </span>
      );
    case 'finished':
      return (
        <span
          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
          style={{
            background: 'rgba(42, 31, 14, 0.06)',
            color: 'var(--color-ink-faint)',
            border: '1px solid rgba(42, 31, 14, 0.1)',
          }}
        >
          Finished
        </span>
      );
    case 'lobby':
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
          style={{
            background: 'rgba(184, 134, 11, 0.08)',
            color: 'var(--color-amber)',
            border: '1px solid rgba(184, 134, 11, 0.2)',
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--color-amber)' }}
          />
          Forming
        </span>
      );
    default:
      return null;
  }
}

export default function LobbiesPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
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
          const mapped = gamesData.map((g: GameSummary) => ({
            id: g.gameId,
            gameType: g.gameType,
            turn: g.turn ?? 0,
            maxTurns: g.maxTurns ?? 30,
            phase: g.finished
              ? ('finished' as const)
              : g.phase === 'playing'
                ? ('in_progress' as const)
                : ('in_progress' as const),
            winner: g.winner,
            teamsA: g.teams?.A?.length ?? 0,
            teamsB: g.teams?.B?.length ?? 0,
            round: g.round,
            maxRounds: g.maxRounds,
            playerCount: g.playerCount,
          }));
          // @ts-expect-error TS2345: Argument of type '{ id: string; gameType: string; turn: number; maxTurns: number — TODO(2.3-followup)
          setGames(mapped);
          setLobbies((lobbiesData as Lobby[]).filter((l) => l.phase === 'lobby'));
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
            {filteredLobbies.map((lobby, i) => (
              <motion.div
                key={lobby.lobbyId}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.4 }}
              >
                <LobbyCard lobby={lobby} onClick={() => navigate(`/lobby/${lobby.lobbyId}`)} />
              </motion.div>
            ))}
          </div>
        </motion.section>
      )}

      <motion.section
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.5 }}
      >
        {/* @ts-expect-error TS2375: Type '{ title: string; count: number | undefined; }' is not assignable to type ' — TODO(2.3-followup) */}
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
            {activeGames.map((game, i) => (
              <motion.div
                key={game.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.4 }}
              >
                <GameCard game={game} onClick={() => navigate(`/game/${game.id}`)} />
              </motion.div>
            ))}
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
            {finishedGames.map((game, i) => (
              <motion.div
                key={game.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.4 }}
              >
                <GameCard game={game} onClick={() => navigate(`/replay/${game.id}`)} />
              </motion.div>
            ))}
          </div>
        </motion.section>
      )}
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
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

function lobbyPhaseBadge(lobby: Lobby) {
  const phase = lobby.phase;

  switch (phase) {
    case 'lobby':
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
          style={{
            background: 'rgba(184, 134, 11, 0.08)',
            color: 'var(--color-amber)',
            border: '1px solid rgba(184, 134, 11, 0.2)',
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--color-amber)' }}
          />
          Open
        </span>
      );
    default:
      return (
        <span
          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-heading font-medium"
          style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-ink-faint)' }}
        >
          {phase}
        </span>
      );
  }
}

function LobbyCard({ lobby, onClick }: { lobby: Lobby; onClick: () => void }) {
  const playerCount = lobby.playerCount ?? 0;
  const gameType = lobby.gameType ?? 'capture-the-lobster';
  const teamSize = lobby.teamSize;
  const capacity =
    teamSize != null ? (gameType === 'oathbreaker' ? teamSize : teamSize * 2) : undefined;

  return (
    // biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup)
    <button
      onClick={onClick}
      className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {lobby.lobbyId}
        </span>
        {lobbyPhaseBadge(lobby)}
      </div>
      <div className="mb-2 text-sm" style={{ color: 'var(--color-ink-light)' }}>
        <span className="font-semibold" style={{ color: 'var(--color-amber)' }}>
          {playerCount}
        </span>
        {capacity != null ? <span>/{capacity}</span> : null} players
        {teamSize != null && gameType !== 'oathbreaker' && (
          <span className="ml-2 text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            · {teamSize}v{teamSize}
          </span>
        )}
      </div>
      <div className="flex items-center justify-end">
        {gameType === 'oathbreaker' && (
          <span
            className="font-heading text-xs font-medium"
            style={{ color: 'var(--color-blood)' }}
          >
            OATHBREAKER
          </span>
        )}
      </div>
    </button>
  );
}

function GameCard({ game, onClick }: { game: Game; onClick: () => void }) {
  // OATHBREAKER game card
  if (game.gameType === 'oathbreaker') {
    const round = game.round ?? game.turn ?? 0;
    const maxRounds = game.maxRounds ?? game.maxTurns ?? 12;
    const progress = maxRounds > 0 ? Math.round((round / maxRounds) * 100) : 0;
    const isLive = game.phase === 'in_progress';
    return (
      // biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup)
      <button
        onClick={onClick}
        className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            {game.id}
          </span>
          {phaseBadge(isLive ? 'in_progress' : 'finished')}
        </div>
        <div className="mb-3">
          <div
            className="mb-1.5 flex justify-between text-xs font-mono"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            <span>
              Round {round}/{maxRounds}
            </span>
            <span>{progress}%</span>
          </div>
          <div
            className="h-1.5 w-full rounded-full"
            style={{ background: 'rgba(42, 31, 14, 0.08)' }}
          >
            <motion.div
              className="h-1.5 rounded-full"
              style={{
                width: `${progress}%`,
                background: isLive
                  ? 'linear-gradient(90deg, var(--color-blood), #c55)'
                  : 'linear-gradient(90deg, var(--color-ink-faint), var(--color-wood-light))',
              }}
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span
            className="font-heading text-xs font-medium"
            style={{ color: 'var(--color-blood)' }}
          >
            OATHBREAKER
          </span>
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            {game.playerCount ?? '?'} players
          </span>
        </div>
      </button>
    );
  }

  // CtL game card (original)
  const progress = Math.round((game.turn / game.maxTurns) * 100);
  const isLive = game.phase === 'in_progress';

  return (
    // biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup)
    <button
      onClick={onClick}
      className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
          {game.id}
        </span>
        {phaseBadge(game.phase)}
      </div>
      <div className="mb-3">
        <div
          className="mb-1.5 flex justify-between text-xs font-mono"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          <span>
            Turn {game.turn}/{game.maxTurns}
          </span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full" style={{ background: 'rgba(42, 31, 14, 0.08)' }}>
          <motion.div
            className="h-1.5 rounded-full"
            style={{
              width: `${progress}%`,
              background: isLive
                ? 'linear-gradient(90deg, var(--color-forest), var(--color-forest-light))'
                : 'linear-gradient(90deg, var(--color-ink-faint), var(--color-wood-light))',
            }}
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: '#3a6aaa', boxShadow: '0 0 4px rgba(58, 106, 170, 0.4)' }}
          />
          <span className="font-heading text-xs font-medium" style={{ color: '#3a6aaa' }}>
            Team A
          </span>
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            {game.teamsA}
          </span>
        </div>
        <span
          className="text-xs font-heading font-medium"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          vs
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>
            {game.teamsB}
          </span>
          <span
            className="font-heading text-xs font-medium"
            style={{ color: 'var(--color-blood)' }}
          >
            Team B
          </span>
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{
              background: 'var(--color-blood)',
              boxShadow: '0 0 4px rgba(139, 32, 32, 0.4)',
            }}
          />
        </div>
      </div>
      {game.phase === 'finished' && game.winner && (
        <div
          className="mt-3 pt-3 text-center"
          style={{ borderTop: '1px solid rgba(42, 31, 14, 0.1)' }}
        >
          <span
            className="font-heading text-xs font-bold uppercase tracking-wider"
            style={{ color: 'var(--color-amber)' }}
          >
            Winner: Team {game.winner}
          </span>
        </div>
      )}
    </button>
  );
}
