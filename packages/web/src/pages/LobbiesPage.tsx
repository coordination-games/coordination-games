import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchGames } from '../api';

interface Game {
  id: string;
  turn: number;
  maxTurns: number;
  phase: 'in_progress' | 'finished' | 'starting';
  winner?: string;
  teamsA: number;
  teamsB: number;
}

const mockGames: Game[] = [];

function phaseBadge(phase: string) {
  switch (phase) {
    case 'in_progress':
      return (
        <span className="inline-flex items-center rounded-full bg-green-900/50 px-2.5 py-0.5 text-xs font-medium text-green-400 ring-1 ring-inset ring-green-500/30">
          In Progress
        </span>
      );
    case 'finished':
      return (
        <span className="inline-flex items-center rounded-full bg-gray-800/50 px-2.5 py-0.5 text-xs font-medium text-gray-400 ring-1 ring-inset ring-gray-600/30">
          Finished
        </span>
      );
    case 'starting':
      return (
        <span className="inline-flex items-center rounded-full bg-yellow-900/50 px-2.5 py-0.5 text-xs font-medium text-yellow-400 ring-1 ring-inset ring-yellow-500/30">
          Starting
        </span>
      );
    default:
      return null;
  }
}

export default function LobbiesPage() {
  const [games, setGames] = useState<Game[]>(mockGames);
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchGames();
        if (!cancelled) {
          const mapped = (data as any[]).map((g: any) => ({
            id: g.id,
            turn: g.turn ?? 0,
            maxTurns: 30,
            phase: g.phase ?? 'in_progress',
            winner: g.winner,
            teamsA: Array.isArray(g.teams?.A) ? g.teams.A.length : (g.teamsA ?? 0),
            teamsB: Array.isArray(g.teams?.B) ? g.teams.B.length : (g.teamsB ?? 0),
          }));
          setGames(mapped);
        }
      } catch {
        // API not available yet
      }
    }

    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleStartGame() {
    setStarting(true);
    try {
      const res = await fetch('/api/games/start', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        navigate(`/game/${data.gameId}`);
        return;
      }
    } catch {
      // API not available
    }
    setStarting(false);
  }

  const activeGames = games.filter((g) => g.phase !== 'finished');
  const finishedGames = games.filter((g) => g.phase === 'finished');

  return (
    <div className="space-y-10">
      {/* Start Game */}
      <div className="flex justify-center">
        <button
          onClick={handleStartGame}
          disabled={starting}
          className="cursor-pointer rounded-xl bg-emerald-600 px-10 py-4 text-lg font-bold text-white shadow-lg shadow-emerald-900/40 transition-all hover:bg-emerald-500 hover:shadow-emerald-800/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {starting ? 'Starting...' : '\u{1F99E} Start a Game'}
        </button>
      </div>

      {/* Active Games */}
      <section>
        <h2 className="mb-4 text-xl font-bold text-gray-100">
          Active Games
          {activeGames.length > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500">({activeGames.length})</span>
          )}
        </h2>
        {activeGames.length === 0 ? (
          <p className="text-gray-500">No active games right now. Start one!</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activeGames.map((game) => (
              <GameCard key={game.id} game={game} onClick={() => navigate(`/game/${game.id}`)} />
            ))}
          </div>
        )}
      </section>

      {/* Finished Games */}
      {finishedGames.length > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-bold text-gray-100">
            Recent Games
            <span className="ml-2 text-sm font-normal text-gray-500">({finishedGames.length})</span>
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {finishedGames.map((game) => (
              <GameCard key={game.id} game={game} onClick={() => navigate(`/game/${game.id}`)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function GameCard({ game, onClick }: { game: Game; onClick: () => void }) {
  const progress = Math.round((game.turn / game.maxTurns) * 100);

  return (
    <button
      onClick={onClick}
      className="group cursor-pointer rounded-lg border border-gray-800 bg-gray-900 p-5 text-left transition-all hover:border-gray-700 hover:bg-gray-800/70"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-sm text-gray-400">{game.id}</span>
        {phaseBadge(game.phase)}
      </div>

      {/* Turn progress */}
      <div className="mb-3">
        <div className="mb-1 flex justify-between text-xs text-gray-500">
          <span>Turn {game.turn}/{game.maxTurns}</span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-gray-800">
          <div
            className="h-1.5 rounded-full bg-emerald-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Teams */}
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-500" />
          <span className="text-blue-400">Team A</span>
          <span className="font-mono text-gray-400">{game.teamsA}</span>
        </div>
        <span className="text-gray-600">vs</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-gray-400">{game.teamsB}</span>
          <span className="text-red-400">Team B</span>
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />
        </div>
      </div>

      {/* Winner badge for finished games */}
      {game.phase === 'finished' && game.winner && (
        <div className="mt-3 text-center text-sm font-semibold text-yellow-400">
          Winner: Team {game.winner}
        </div>
      )}
    </button>
  );
}
