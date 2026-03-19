import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Types matching LobbyRunnerState from the server
// ---------------------------------------------------------------------------

interface LobbyAgent {
  id: string;
  handle: string;
  team: string | null;
}

interface PreGamePlayer {
  id: string;
  team: 'A' | 'B';
  unitClass: string | null;
  ready: boolean;
}

interface ChatMessage {
  from: string;
  message: string;
  timestamp: number;
}

interface LobbyState {
  lobbyId: string;
  phase: 'forming' | 'pre_game' | 'starting' | 'game' | 'failed';
  agents: LobbyAgent[];
  teams: Record<string, string[]>;
  chat: ChatMessage[];
  preGame: {
    players: PreGamePlayer[];
    timeRemainingSeconds: number;
  } | null;
  gameId: string | null;
  error: string | null;
  teamSize: number;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AgentCard({ agent }: { agent: LobbyAgent }) {
  const teamColor = agent.team
    ? 'border-emerald-600 bg-emerald-900/20'
    : 'border-gray-700 bg-gray-800/50';

  return (
    <div className={`rounded-lg border ${teamColor} px-3 py-2 text-sm`}>
      <div className="font-semibold text-gray-200">{agent.handle}</div>
      <div className="text-xs text-gray-500">{agent.id}</div>
      {agent.team && (
        <div className="mt-1 text-xs text-emerald-400">{agent.team}</div>
      )}
    </div>
  );
}

function TeamPanel({ teamId, members, agents }: {
  teamId: string;
  members: string[];
  agents: LobbyAgent[];
}) {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
      <h4 className="mb-2 text-sm font-semibold text-emerald-400">{teamId}</h4>
      <div className="flex flex-wrap gap-2">
        {members.map((id) => {
          const agent = agents.find((a) => a.id === id);
          return (
            <span key={id} className="rounded bg-gray-800 px-2 py-1 text-xs text-gray-300">
              {agent?.handle ?? id}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function PreGamePanel({ preGame, agents }: {
  preGame: NonNullable<LobbyState['preGame']>;
  agents: LobbyAgent[];
}) {
  const classColors: Record<string, string> = {
    rogue: 'text-green-400',
    knight: 'text-blue-400',
    mage: 'text-purple-400',
  };

  const teamA = preGame.players.filter((p) => p.team === 'A');
  const teamB = preGame.players.filter((p) => p.team === 'B');

  return (
    <div className="space-y-4">
      <div className="text-center text-sm text-yellow-400">
        Class Selection -- {preGame.timeRemainingSeconds}s remaining
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <h4 className="mb-2 text-sm font-bold text-blue-400">Team A</h4>
          {teamA.map((p) => {
            const agent = agents.find((a) => a.id === p.id);
            return (
              <div key={p.id} className="mb-1 flex items-center justify-between rounded bg-gray-800 px-3 py-2">
                <span className="text-sm text-gray-200">{agent?.handle ?? p.id}</span>
                <span className={`text-xs font-semibold ${p.unitClass ? classColors[p.unitClass] ?? 'text-gray-400' : 'text-gray-600'}`}>
                  {p.unitClass ?? 'choosing...'}
                </span>
              </div>
            );
          })}
        </div>
        <div>
          <h4 className="mb-2 text-sm font-bold text-red-400">Team B</h4>
          {teamB.map((p) => {
            const agent = agents.find((a) => a.id === p.id);
            return (
              <div key={p.id} className="mb-1 flex items-center justify-between rounded bg-gray-800 px-3 py-2">
                <span className="text-sm text-gray-200">{agent?.handle ?? p.id}</span>
                <span className={`text-xs font-semibold ${p.unitClass ? classColors[p.unitClass] ?? 'text-gray-400' : 'text-gray-600'}`}>
                  {p.unitClass ?? 'choosing...'}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ChatLog({ messages, agents }: { messages: ChatMessage[]; agents: LobbyAgent[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div className="flex flex-col gap-1 overflow-y-auto max-h-64 scrollbar-thin">
      {messages.length === 0 && (
        <p className="text-xs italic text-gray-600">No messages yet...</p>
      )}
      {messages.map((m, i) => {
        const agent = agents.find((a) => a.id === m.from);
        return (
          <div key={i} className="text-xs">
            <span className="font-semibold text-emerald-400">{agent?.handle ?? m.from}:</span>{' '}
            <span className="text-gray-300">{m.message}</span>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase badge
// ---------------------------------------------------------------------------

function phaseBadge(phase: string) {
  const styles: Record<string, string> = {
    forming: 'bg-yellow-900/50 text-yellow-400 ring-yellow-500/30',
    pre_game: 'bg-blue-900/50 text-blue-400 ring-blue-500/30',
    starting: 'bg-emerald-900/50 text-emerald-400 ring-emerald-500/30',
    game: 'bg-green-900/50 text-green-400 ring-green-500/30',
    failed: 'bg-red-900/50 text-red-400 ring-red-500/30',
  };

  const labels: Record<string, string> = {
    forming: 'Forming Teams',
    pre_game: 'Class Selection',
    starting: 'Starting...',
    game: 'Game Started',
    failed: 'Failed',
  };

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${styles[phase] ?? styles.forming}`}>
      {labels[phase] ?? phase}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LobbyPage
// ---------------------------------------------------------------------------

export default function LobbyPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LobbyState | null>(null);
  const [connected, setConnected] = useState(false);
  const [addingBot, setAddingBot] = useState(false);
  const [copied, setCopied] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!id) return;

    // Fetch initial state
    fetch(`/api/lobbies/${id}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && data.lobbyId) {
          setState(data);
        }
      })
      .catch(() => {});

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/lobby/${id}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        if (raw.type === 'lobby_update' && raw.data) {
          setState(raw.data);
        }
      } catch {
        console.warn('Failed to parse lobby WS message');
      }
    };

    ws.onerror = () => {};
    ws.onclose = () => setConnected(false);

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [id]);

  // Auto-redirect to game when lobby transitions to game phase
  useEffect(() => {
    if (state?.phase === 'game' && state.gameId) {
      const timer = setTimeout(() => {
        navigate(`/game/${state.gameId}`);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [state?.phase, state?.gameId, navigate]);

  async function handleAddBot() {
    if (!id) return;
    setAddingBot(true);
    try {
      await fetch(`/api/lobbies/${id}/add-bot`, { method: 'POST' });
    } catch {
      // ignore
    }
    setAddingBot(false);
  }

  function handleCopyJoinCommand() {
    const cmd = `bash <(curl -s https://capturethelobster.com/join.sh) ${id}`;
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (!state) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <div className="text-4xl mb-4">🦞</div>
          <p className="text-gray-400">
            {connected ? 'Waiting for lobby data...' : `Connecting to lobby ${id}...`}
          </p>
        </div>
      </div>
    );
  }

  const teamEntries = Object.entries(state.teams);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-100">Lobby</h1>
          <span className="font-mono text-sm text-gray-500">{state.lobbyId}</span>
          {phaseBadge(state.phase)}
          <span className="text-sm text-gray-400">
            {state.agents.length} / {(state.teamSize || 2) * 2} agents
          </span>
        </div>
        <div className="flex items-center gap-3">
          {!connected && (
            <span className="text-xs text-yellow-500">disconnected</span>
          )}
        </div>
      </div>

      {/* Forming phase: Add Bot + Join instructions */}
      {state.phase === 'forming' && (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Add Bot */}
          <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
              Add Players
            </h3>
            <button
              onClick={handleAddBot}
              disabled={addingBot || state.agents.length >= (state.teamSize || 2) * 2}
              className="cursor-pointer rounded-lg bg-emerald-600 px-5 py-2 text-sm font-bold text-white transition-all hover:bg-emerald-500 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {addingBot ? 'Adding...' : '+ Add Bot'}
            </button>
          </div>

          {/* Join instructions */}
          <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
              Join as External Agent
            </h3>
            <div
              onClick={handleCopyJoinCommand}
              className="cursor-pointer rounded bg-gray-800 px-3 py-2 font-mono text-xs text-gray-300 hover:bg-gray-700 transition-colors"
              title="Click to copy"
            >
              bash &lt;(curl -s https://capturethelobster.com/join.sh) {state.lobbyId}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {copied ? 'Copied!' : 'Click to copy join command'}
            </p>
          </div>
        </div>
      )}

      {/* Game redirect notice */}
      {state.phase === 'game' && state.gameId && (
        <div className="rounded-lg border border-emerald-600 bg-emerald-900/30 p-4 text-center">
          <p className="text-emerald-300 font-semibold">
            Game started! Redirecting to game...
          </p>
          <button
            onClick={() => navigate(`/game/${state.gameId}`)}
            className="mt-2 rounded bg-emerald-600 px-4 py-1 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Go to Game Now
          </button>
        </div>
      )}

      {/* Error */}
      {state.phase === 'failed' && state.error && (
        <div className="rounded-lg border border-red-600 bg-red-900/30 p-4 text-center">
          <p className="text-red-300">{state.error}</p>
        </div>
      )}

      {/* Pre-game class selection */}
      {state.phase === 'pre_game' && state.preGame && (
        <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
          <PreGamePanel preGame={state.preGame} agents={state.agents} />
        </div>
      )}

      {/* Agents & Teams (forming phase) */}
      {(state.phase === 'forming' || state.phase === 'pre_game') && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Agents */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
              Agents ({state.agents.length})
            </h3>
            <div className="grid gap-2 grid-cols-2">
              {state.agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
            </div>
          </div>

          {/* Teams */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
              Teams ({teamEntries.length})
            </h3>
            {teamEntries.length === 0 ? (
              <p className="text-sm text-gray-600">No teams formed yet...</p>
            ) : (
              <div className="space-y-2">
                {teamEntries.map(([teamId, members]) => (
                  <TeamPanel
                    key={teamId}
                    teamId={teamId}
                    members={members}
                    agents={state.agents}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Chat */}
      <div className="rounded-lg border border-gray-700 bg-gray-900 p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
          Lobby Chat
        </h3>
        <ChatLog messages={state.chat} agents={state.agents} />
      </div>
    </div>
  );
}
