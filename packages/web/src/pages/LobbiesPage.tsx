import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../config.js';
import { motion } from 'framer-motion';
import { fetchGames, type GameSummary } from '../api';
import { formatLobbyOption, getGameManifest, getLobbyEnabledGames } from '../games/manifest';

interface Game {
  id: string;
  gameType?: string;
  turn: number;
  maxTurns: number;
  phase: 'in_progress' | 'finished' | 'starting' | 'playing';
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
  phase: 'running' | 'starting' | 'game' | 'failed';
  currentPhase?: {
    id: string;
    name: string;
    view: any;
  } | null;
  agents: any[];
  deadlineMs?: number | null;
  gameId?: string | null;
  error?: string | null;
  noTimeout?: boolean;
}

function phaseBadge(phase: string) {
  switch (phase) {
    case 'in_progress':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide" style={{ background: 'rgba(58, 90, 42, 0.1)', color: 'var(--color-forest)', border: '1px solid rgba(58, 90, 42, 0.2)' }}>
          <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--color-forest-light)' }} />
          Live
        </span>
      );
    case 'finished':
      return (
        <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide" style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-ink-faint)', border: '1px solid rgba(42, 31, 14, 0.1)' }}>
          Finished
        </span>
      );
    case 'starting':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide" style={{ background: 'rgba(184, 134, 11, 0.08)', color: 'var(--color-amber)', border: '1px solid rgba(184, 134, 11, 0.2)' }}>
          <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--color-amber)' }} />
          Starting
        </span>
      );
    default:
      return null;
  }
}

export default function LobbiesPage() {
  const lobbyGames = getLobbyEnabledGames();
  const defaultGame = lobbyGames[0]?.gameType ?? 'capture-the-lobster';
  const [games, setGames] = useState<Game[]>([]);
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [creating, setCreating] = useState(false);
  const [gameTab, setGameTab] = useState<string>(defaultGame);
  const [createValue, setCreateValue] = useState<number>(getGameManifest(defaultGame)?.lobby?.options[0] ?? 2);
  const navigate = useNavigate();
  const selectedGame = getGameManifest(gameTab);

  useEffect(() => {
    setCreateValue(selectedGame?.lobby?.options[0] ?? 2);
  }, [selectedGame?.gameType]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [gamesData, lobbiesData] = await Promise.all([
          fetchGames(),
          fetch(`${API_BASE}/lobbies`).then(r => r.json()).catch(() => []),
        ]);
        if (!cancelled) {
          const mapped = gamesData.map((g: GameSummary) => ({
            id: g.gameId,
            gameType: g.gameType,
            turn: g.turn ?? 0,
            maxTurns: g.maxTurns ?? 30,
            phase: g.finished ? 'finished' as const : (g.phase === 'playing' ? 'in_progress' as const : 'in_progress' as const),
            winner: g.winner,
            teamsA: g.teams?.A?.length ?? 0,
            teamsB: g.teams?.B?.length ?? 0,
            round: g.round,
            maxRounds: g.maxRounds,
            playerCount: g.playerCount,
          }));
          setGames(mapped);
          setLobbies((lobbiesData as Lobby[]).filter(l => l.phase !== 'game' && l.phase !== 'failed'));
        }
      } catch {}
    }
    load();
    const interval = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  async function handleCreateLobby() {
    setCreating(true);
    try {
      const res = await fetch(`${API_BASE}/lobbies/create`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameType: gameTab, teamSize: createValue }),
      });
      if (res.ok) { const data = await res.json(); navigate(`/lobby/${data.lobbyId}`); return; }
    } catch {}
    setCreating(false);
  }

  const filteredGames = games.filter(g => (g.gameType ?? defaultGame) === gameTab);
  const filteredLobbies = lobbies.filter(l => (l.gameType ?? defaultGame) === gameTab);
  const activeGames = filteredGames.filter((g) => g.phase !== 'finished');
  const finishedGames = filteredGames.filter((g) => g.phase === 'finished');

  return (
    <div className="space-y-12">
      {/* Game type tabs + create controls */}
      <div className="flex flex-col gap-3">
        {/* Tab selector */}
        <div className="flex items-center gap-2">
          {lobbyGames.map((game) => {
            const isActive = gameTab === game.gameType;
            return (
              <button
                key={game.gameType}
                onClick={() => setGameTab(game.gameType)}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm font-heading font-semibold tracking-wide transition-all"
                style={isActive
                  ? { background: `${game.accentColor}20`, color: game.accentColor, border: `1px solid ${game.accentColor}55` }
                  : { background: 'transparent', color: 'var(--color-ink-faint)', border: '1px solid rgba(42, 31, 14, 0.15)' }
                }
              >
                {game.displayName}
              </button>
            );
          })}
        </div>

        {/* Create controls */}
        <div className="flex items-center justify-end gap-3">
          {selectedGame?.lobby && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono" style={{ color: 'var(--color-ink-faint)' }}>{selectedGame.lobby.metricLabel}:</span>
              {selectedGame.lobby.options.map((option) => (
                <button
                  key={option}
                  onClick={() => setCreateValue(option)}
                  className="cursor-pointer rounded-md px-2.5 py-1 text-xs font-mono font-medium transition-colors"
                  style={createValue === option
                    ? { background: `${selectedGame.accentColor}20`, color: selectedGame.accentColor, border: `1px solid ${selectedGame.accentColor}55` }
                    : { color: 'var(--color-ink-faint)', border: '1px solid rgba(42, 31, 14, 0.15)' }
                  }
                >
                  {formatLobbyOption(selectedGame, option)}
                </button>
              ))}
            </div>
          )}
          <motion.button
            onClick={handleCreateLobby}
            disabled={creating}
            className="cursor-pointer font-heading rounded-lg px-5 py-2 text-sm font-semibold tracking-wider uppercase disabled:opacity-40 disabled:cursor-not-allowed transition-all hover:brightness-110"
            style={{ border: '1px solid rgba(184, 134, 11, 0.3)', background: 'rgba(184, 134, 11, 0.08)', color: 'var(--color-amber)' }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            {creating ? 'Creating...' : (selectedGame?.lobby?.buttonLabel ?? 'Create Lobby')}
          </motion.button>
        </div>
      </div>

      {filteredLobbies.length > 0 && (
        <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <SectionHeader title="Active Lobbies" count={filteredLobbies.length} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredLobbies.map((lobby, i) => (
              <motion.div key={lobby.lobbyId} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.4 }}>
                <LobbyCard lobby={lobby} onClick={() => navigate(`/lobby/${lobby.lobbyId}`)} />
              </motion.div>
            ))}
          </div>
        </motion.section>
      )}

      <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5 }}>
        <SectionHeader title="Active Games" count={activeGames.length > 0 ? activeGames.length : undefined} />
        {activeGames.length === 0 ? (
          <div className="rounded-xl py-12 text-center parchment" style={{ borderStyle: 'dashed' }}>
            <p className="text-sm" style={{ color: 'var(--color-ink-faint)' }}>No active games right now.</p>
            <p className="text-xs mt-1" style={{ color: 'var(--color-ink-faint)', opacity: 0.6 }}>Create a lobby to begin.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activeGames.map((game, i) => (
              <motion.div key={game.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.4 }}>
                <GameCard game={game} onClick={() => navigate(`/game/${game.id}`)} />
              </motion.div>
            ))}
          </div>
        )}
      </motion.section>

      {finishedGames.length > 0 && (
        <motion.section initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.5 }}>
          <SectionHeader title="Recent Games" count={finishedGames.length} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {finishedGames.map((game, i) => (
              <motion.div key={game.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.4 }}>
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
      <h2 className="font-heading text-lg font-bold tracking-wide" style={{ color: 'var(--color-ink)' }}>{title}</h2>
      {count !== undefined && (
        <span className="text-xs font-mono font-medium rounded-full px-2.5 py-0.5" style={{ background: 'rgba(184, 134, 11, 0.1)', color: 'var(--color-amber)', border: '1px solid rgba(184, 134, 11, 0.2)' }}>
          {count}
        </span>
      )}
      <div className="flex-1 h-px" style={{ background: 'linear-gradient(to right, rgba(42, 31, 14, 0.15), transparent)' }} />
    </div>
  );
}

function lobbyPhaseBadge(lobby: Lobby) {
  const phase = lobby.phase;
  const phaseName = lobby.currentPhase?.name;

  switch (phase) {
    case 'running':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide" style={{ background: 'rgba(184, 134, 11, 0.08)', color: 'var(--color-amber)', border: '1px solid rgba(184, 134, 11, 0.2)' }}>
          <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--color-amber)' }} />
          {phaseName ?? 'In Progress'}
        </span>
      );
    case 'starting':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide" style={{ background: 'rgba(58, 90, 42, 0.08)', color: 'var(--color-forest)', border: '1px solid rgba(58, 90, 42, 0.2)' }}>
          <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--color-forest-light)' }} />
          Starting...
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-heading font-medium" style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-ink-faint)' }}>
          {phaseName ?? phase}
        </span>
      );
  }
}

function LobbyCard({ lobby, onClick }: { lobby: Lobby; onClick: () => void }) {
  const agentCount = lobby.agents.length;
  const gameType = lobby.gameType ?? 'capture-the-lobster';
  const manifest = getGameManifest(gameType);
  const phaseView = lobby.currentPhase?.view;

  // Extract team count from team-formation phase view if available
  const teams: any[] = phaseView?.teams ?? [];
  const teamCount = teams.length;

  return (
    <button onClick={onClick} className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>{lobby.lobbyId}</span>
        {lobbyPhaseBadge(lobby)}
      </div>
      <div className="mb-2 text-sm" style={{ color: 'var(--color-ink-light)' }}>
        <span className="font-semibold" style={{ color: 'var(--color-amber)' }}>{agentCount}</span> agents
        {teamCount > 0 && <span className="ml-2">· <span className="font-semibold" style={{ color: 'var(--color-amber)' }}>{teamCount}</span> teams formed</span>}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-1">
          {lobby.agents.slice(0, 8).map((agent: any) => (
            <span key={agent.id} className="inline-block rounded-md px-1.5 py-0.5 text-xs font-mono" style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-ink-faint)' }}>
              {agent.handle || agent.id}
            </span>
          ))}
        </div>
        {manifest && (
          <span className="font-heading text-xs font-medium" style={{ color: manifest.accentColor }}>{manifest.displayName}</span>
        )}
      </div>
    </button>
  );
}

function GameCard({ game, onClick }: { game: Game; onClick: () => void }) {
  const manifest = getGameManifest(game.gameType ?? 'capture-the-lobster');
  // OATHBREAKER game card
  if (game.gameType === 'oathbreaker') {
    const round = game.round ?? game.turn ?? 0;
    const maxRounds = game.maxRounds ?? game.maxTurns ?? 12;
    const progress = maxRounds > 0 ? Math.round((round / maxRounds) * 100) : 0;
    const isLive = game.phase === 'playing' || game.phase === 'in_progress';
    return (
      <button onClick={onClick} className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md">
        <div className="mb-3 flex items-center justify-between">
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>{game.id}</span>
          {phaseBadge(isLive ? 'in_progress' : game.phase === 'finished' ? 'finished' : 'starting')}
        </div>
        <div className="mb-3">
          <div className="mb-1.5 flex justify-between text-xs font-mono" style={{ color: 'var(--color-ink-faint)' }}>
            <span>Round {round}/{maxRounds}</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full" style={{ background: 'rgba(42, 31, 14, 0.08)' }}>
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
          <span className="font-heading text-xs font-medium" style={{ color: manifest?.accentColor ?? 'var(--color-blood)' }}>
            {manifest?.displayName ?? 'OATHBREAKER'}
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
    <button onClick={onClick} className="group cursor-pointer w-full rounded-xl parchment-strong p-5 text-left transition-all duration-200 hover:shadow-md">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>{game.id}</span>
        {phaseBadge(game.phase)}
      </div>
      <div className="mb-3">
        <div className="mb-1.5 flex justify-between text-xs font-mono" style={{ color: 'var(--color-ink-faint)' }}>
          <span>Turn {game.turn}/{game.maxTurns}</span>
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
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: '#3a6aaa', boxShadow: '0 0 4px rgba(58, 106, 170, 0.4)' }} />
          <span className="font-heading text-xs font-medium" style={{ color: '#3a6aaa' }}>Team A</span>
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>{game.teamsA}</span>
        </div>
        <span className="text-xs font-heading font-medium" style={{ color: 'var(--color-ink-faint)' }}>vs</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs" style={{ color: 'var(--color-ink-faint)' }}>{game.teamsB}</span>
          <span className="font-heading text-xs font-medium" style={{ color: 'var(--color-blood)' }}>Team B</span>
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--color-blood)', boxShadow: '0 0 4px rgba(139, 32, 32, 0.4)' }} />
        </div>
      </div>
      {game.phase === 'finished' && game.winner && (
        <div className="mt-3 pt-3 text-center" style={{ borderTop: '1px solid rgba(42, 31, 14, 0.1)' }}>
          <span className="font-heading text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-amber)' }}>
            Winner: Team {game.winner}
          </span>
        </div>
      )}
    </button>
  );
}
