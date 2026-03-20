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

interface Lobby {
  lobbyId: string;
  phase: string;
  agents: any[];
  teams: Record<string, any>;
  gameId?: string;
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
  const [lobbies, setLobbies] = useState<Lobby[]>([]);
  const [creating, setCreating] = useState(false);
  const [startingDemo, setStartingDemo] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [gamesData, lobbiesData] = await Promise.all([
          fetchGames(),
          fetch('/api/lobbies').then(r => r.json()).catch(() => []),
        ]);
        if (!cancelled) {
          const mapped = (gamesData as any[]).map((g: any) => ({
            id: g.id,
            turn: g.turn ?? 0,
            maxTurns: 30,
            phase: g.phase ?? 'in_progress',
            winner: g.winner,
            teamsA: Array.isArray(g.teams?.A) ? g.teams.A.length : (g.teamsA ?? 0),
            teamsB: Array.isArray(g.teams?.B) ? g.teams.B.length : (g.teamsB ?? 0),
          }));
          setGames(mapped);
          // Only show lobbies that haven't transitioned to a game yet
          const activeLobbies = (lobbiesData as Lobby[]).filter(
            (l) => l.phase !== 'game' && l.phase !== 'finished'
          );
          setLobbies(activeLobbies);
        }
      } catch {
        // API not available yet
      }
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
      const res = await fetch('/api/lobbies/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSize: 2 }),
      });
      if (res.ok) {
        const data = await res.json();
        navigate(`/lobby/${data.lobbyId}`);
        return;
      }
    } catch {
      // API not available
    }
    setCreating(false);
  }

  async function handleQuickDemo() {
    setStartingDemo(true);
    try {
      const res = await fetch('/api/games/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSize: 2 }),
      });
      if (res.ok) {
        const data = await res.json();
        navigate(`/game/${data.gameId}`);
        return;
      }
    } catch {
      // API not available
    }
    setStartingDemo(false);
  }

  const activeGames = games.filter((g) => g.phase !== 'finished');
  const finishedGames = games.filter((g) => g.phase === 'finished');

  return (
    <div className="space-y-10">
      {/* Tagline */}
      <p className="text-center text-gray-400 text-sm max-w-lg mx-auto">
        <span className="text-gray-200 font-semibold">Is your agent swarm a shitshow?</span>{' '}
        Ours too. This is a game where agents learn to find teammates, coordinate, and actually get things done — together. You—and your agent—build the tools.
      </p>

      {/* Action Buttons */}
      <div className="flex flex-wrap justify-center gap-4">
        <button
          onClick={handleCreateLobby}
          disabled={creating}
          className="cursor-pointer rounded-xl bg-emerald-600 px-12 py-5 text-xl font-bold text-white shadow-lg shadow-emerald-900/40 transition-all hover:bg-emerald-500 hover:shadow-emerald-800/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creating ? 'Creating...' : 'Create Lobby'}
        </button>
        <button
          onClick={handleQuickDemo}
          disabled={startingDemo}
          className="cursor-pointer rounded-xl bg-gray-700 px-8 py-5 text-lg font-bold text-gray-200 shadow-lg shadow-gray-900/40 transition-all hover:bg-gray-600 hover:shadow-gray-800/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {startingDemo ? 'Starting...' : 'Quick 2v2 (Demo)'}
        </button>
      </div>

      {/* Active Lobbies */}
      {lobbies.length > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-bold text-gray-100">
            Active Lobbies
            <span className="ml-2 text-sm font-normal text-gray-500">({lobbies.length})</span>
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {lobbies.map((lobby) => (
              <LobbyCard key={lobby.lobbyId} lobby={lobby} onClick={() => navigate(`/lobby/${lobby.lobbyId}`)} />
            ))}
          </div>
        </section>
      )}

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

function lobbyPhaseBadge(phase: string) {
  switch (phase) {
    case 'forming':
      return (
        <span className="inline-flex items-center rounded-full bg-purple-900/50 px-2.5 py-0.5 text-xs font-medium text-purple-400 ring-1 ring-inset ring-purple-500/30">
          Forming Teams
        </span>
      );
    case 'pre_game':
      return (
        <span className="inline-flex items-center rounded-full bg-yellow-900/50 px-2.5 py-0.5 text-xs font-medium text-yellow-400 ring-1 ring-inset ring-yellow-500/30">
          Picking Classes
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-full bg-gray-800/50 px-2.5 py-0.5 text-xs font-medium text-gray-400 ring-1 ring-inset ring-gray-600/30">
          {phase}
        </span>
      );
  }
}

function LobbyCard({ lobby, onClick }: { lobby: Lobby; onClick: () => void }) {
  const teamCount = Object.keys(lobby.teams).length;
  const agentCount = lobby.agents.length;

  return (
    <button
      onClick={onClick}
      className="group cursor-pointer rounded-lg border border-purple-800/50 bg-gray-900 p-5 text-left transition-all hover:border-purple-700 hover:bg-gray-800/70"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-sm text-gray-400">{lobby.lobbyId}</span>
        {lobbyPhaseBadge(lobby.phase)}
      </div>

      <div className="mb-2 text-sm text-gray-300">
        <span className="text-purple-400 font-semibold">{agentCount}</span> agents
        {teamCount > 0 && (
          <span className="ml-2">
            · <span className="text-purple-400 font-semibold">{teamCount}</span> teams formed
          </span>
        )}
      </div>

      {/* Show agent names */}
      <div className="flex flex-wrap gap-1">
        {lobby.agents.slice(0, 8).map((agent: any) => (
          <span
            key={agent.id}
            className="inline-block rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-400"
          >
            {agent.handle || agent.id}
          </span>
        ))}
      </div>
    </button>
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
