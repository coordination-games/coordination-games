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
  const [startingLobby, setStartingLobby] = useState(false);
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [openLobbyResult, setOpenLobbyResult] = useState<{
    lobbyId: string;
    token?: string;
    agentId?: string;
    mcpUrl?: string;
  } | null>(null);
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

  async function handleStartGame(teamSize: number) {
    setStarting(true);
    try {
      const res = await fetch('/api/games/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSize }),
      });
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

  async function handleStartLobby() {
    setStartingLobby(true);
    try {
      const res = await fetch('/api/lobbies/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSize: 4 }),
      });
      if (res.ok) {
        const data = await res.json();
        navigate(`/lobby/${data.lobbyId}`);
        return;
      }
    } catch {
      // API not available
    }
    setStartingLobby(false);
  }

  async function handleCreateOpenLobby() {
    setCreatingOpen(true);
    setOpenLobbyResult(null);
    try {
      // 1. Create lobby with external slots
      const lobbyRes = await fetch('/api/lobbies/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamSize: 2, externalSlots: 1 }),
      });
      if (!lobbyRes.ok) { setCreatingOpen(false); return; }
      const lobbyData = await lobbyRes.json();

      // 2. Register an external agent slot
      const regRes = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lobbyId: lobbyData.lobbyId }),
      });
      if (!regRes.ok) { setCreatingOpen(false); return; }
      const regData = await regRes.json();

      setOpenLobbyResult({
        lobbyId: lobbyData.lobbyId,
        token: regData.token,
        agentId: regData.agentId,
        mcpUrl: `${window.location.origin}${regData.mcpUrl}`,
      });
    } catch {
      // API error
    }
    setCreatingOpen(false);
  }

  const activeGames = games.filter((g) => g.phase !== 'finished');
  const finishedGames = games.filter((g) => g.phase === 'finished');

  return (
    <div className="space-y-10">
      {/* Start Game Buttons */}
      <div className="flex flex-wrap justify-center gap-4">
        <button
          onClick={handleStartLobby}
          disabled={startingLobby}
          className="cursor-pointer rounded-xl bg-emerald-600 px-10 py-4 text-lg font-bold text-white shadow-lg shadow-emerald-900/40 transition-all hover:bg-emerald-500 hover:shadow-emerald-800/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {startingLobby ? 'Starting Lobby...' : '\u{1F99E} Start Lobby Game'}
        </button>
        <button
          onClick={handleCreateOpenLobby}
          disabled={creatingOpen}
          className="cursor-pointer rounded-xl bg-purple-600 px-8 py-4 text-lg font-bold text-white shadow-lg shadow-purple-900/40 transition-all hover:bg-purple-500 hover:shadow-purple-800/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {creatingOpen ? 'Creating...' : '\u{1F310} Create Open Lobby'}
        </button>
        <button
          onClick={() => handleStartGame(2)}
          disabled={starting}
          className="cursor-pointer rounded-xl bg-gray-700 px-8 py-4 text-lg font-bold text-gray-200 shadow-lg shadow-gray-900/40 transition-all hover:bg-gray-600 hover:shadow-gray-800/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {starting ? 'Starting...' : 'Quick 2v2'}
        </button>
        <button
          onClick={() => handleStartGame(4)}
          disabled={starting}
          className="cursor-pointer rounded-xl bg-gray-700 px-8 py-4 text-lg font-bold text-gray-200 shadow-lg shadow-gray-900/40 transition-all hover:bg-gray-600 hover:shadow-gray-800/50 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {starting ? 'Starting...' : 'Quick 4v4'}
        </button>
      </div>

      {/* Open Lobby Connection Info */}
      {openLobbyResult && (
        <div className="mx-auto max-w-2xl rounded-lg border border-purple-700 bg-purple-900/30 p-5">
          <h3 className="mb-3 text-lg font-bold text-purple-300">
            Open Lobby Created - Share with External Agents
          </h3>
          <div className="space-y-2 font-mono text-sm">
            <div>
              <span className="text-gray-400">MCP Endpoint: </span>
              <span className="text-purple-200 select-all">{openLobbyResult.mcpUrl}</span>
            </div>
            <div>
              <span className="text-gray-400">Bearer Token: </span>
              <span className="text-purple-200 select-all break-all">{openLobbyResult.token}</span>
            </div>
            <div>
              <span className="text-gray-400">Agent ID: </span>
              <span className="text-purple-200 select-all">{openLobbyResult.agentId}</span>
            </div>
            <div>
              <span className="text-gray-400">Lobby ID: </span>
              <span className="text-purple-200 select-all">{openLobbyResult.lobbyId}</span>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-400">
            External agents connect via MCP Streamable HTTP. Send POST to the endpoint with
            Authorization: Bearer &lt;token&gt;.
          </p>
          <button
            onClick={() => navigate(`/lobby/${openLobbyResult.lobbyId}`)}
            className="mt-3 cursor-pointer rounded-lg bg-purple-700 px-6 py-2 text-sm font-bold text-white hover:bg-purple-600 active:scale-95"
          >
            Go to Lobby →
          </button>
        </div>
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
