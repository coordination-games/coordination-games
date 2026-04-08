import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PlayerList, ChatPanel, AutoScrollChat, TimerBar, JoinInstructions, TeamPanel } from '../components/lobby';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface LobbyAgent { id: string; handle: string; team: string | null; }
interface PreGamePlayer { id: string; team: 'A' | 'B'; unitClass: string | null; ready: boolean; }
interface ChatMessage { from: string; message: string; timestamp: number; }

// Unified lobby state (from /ws/lobby/:id — both runner and simple lobbies)
interface LobbyState {
  lobbyId: string;
  gameType?: string;
  phase: 'forming' | 'pre_game' | 'starting' | 'game' | 'failed';
  agents: LobbyAgent[];
  teams: Record<string, string[]>;
  chat: ChatMessage[];
  preGame: { players: PreGamePlayer[]; timeRemainingSeconds: number; chatA: ChatMessage[]; chatB: ChatMessage[]; } | null;
  gameId: string | null;
  error: string | null;
  teamSize: number;
  targetPlayers?: number;
  noTimeout?: boolean;
  timeRemainingSeconds?: number;
}

// ---------------------------------------------------------------------------
// CtL-specific: PreGamePanel (class selection — only used for CtL)
// ---------------------------------------------------------------------------

function PreGamePanel({ preGame, agents }: { preGame: NonNullable<LobbyState['preGame']>; agents: LobbyAgent[]; }) {
  const classColors: Record<string, string> = { rogue: 'var(--color-forest)', knight: '#3a6aaa', mage: '#7a4aaa' };
  const teamA = preGame.players.filter((p) => p.team === 'A');
  const teamB = preGame.players.filter((p) => p.team === 'B');

  function TeamCol({ label, color, players, chat }: { label: string; color: string; players: PreGamePlayer[]; chat: ChatMessage[] }) {
    return (
      <div>
        <h4 className="mb-2 text-sm font-heading font-bold" style={{ color }}>{label}</h4>
        {players.map((p) => {
          const agent = agents.find((a) => a.id === p.id);
          return (
            <div key={p.id} className="mb-1 flex items-center justify-between rounded parchment px-3 py-2">
              <span className="text-sm" style={{ color: 'var(--color-ink)' }}>{agent?.handle ?? p.id}</span>
              <span className="text-xs font-semibold" style={{ color: p.unitClass ? (classColors[p.unitClass] ?? 'var(--color-ink-faint)') : 'var(--color-ink-faint)' }}>
                {p.unitClass ?? 'choosing...'}
              </span>
            </div>
          );
        })}
        {chat.length > 0 && (
          <AutoScrollChat deps={chat.length}>
            <div className="mt-2 rounded p-2" style={{ background: 'rgba(42, 31, 14, 0.04)' }}>
              {chat.map((m, i) => {
                const agent = agents.find((a) => a.id === m.from);
                return (
                  <div key={i} className="text-xs mb-0.5">
                    <span className="font-semibold" style={{ color }}>{agent?.handle ?? m.from}:</span>{' '}
                    <span style={{ color: 'var(--color-ink-light)' }}>{m.message}</span>
                  </div>
                );
              })}
            </div>
          </AutoScrollChat>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-center text-sm font-heading font-semibold" style={{ color: 'var(--color-amber)' }}>
        Class Selection
      </div>
      <div className="grid grid-cols-2 gap-4">
        <TeamCol label="Team A" color="#3a6aaa" players={teamA} chat={preGame.chatA} />
        <TeamCol label="Team B" color="var(--color-blood)" players={teamB} chat={preGame.chatB} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase badge (shared)
// ---------------------------------------------------------------------------

function phaseBadge(phase: string) {
  const styles: Record<string, { bg: string; color: string; border: string }> = {
    forming: { bg: 'rgba(184, 134, 11, 0.08)', color: 'var(--color-amber)', border: 'rgba(184, 134, 11, 0.2)' },
    waiting: { bg: 'rgba(184, 134, 11, 0.08)', color: 'var(--color-amber)', border: 'rgba(184, 134, 11, 0.2)' },
    pre_game: { bg: 'rgba(58, 106, 170, 0.08)', color: '#3a6aaa', border: 'rgba(58, 106, 170, 0.2)' },
    starting: { bg: 'rgba(58, 90, 42, 0.08)', color: 'var(--color-forest)', border: 'rgba(58, 90, 42, 0.2)' },
    game: { bg: 'rgba(58, 90, 42, 0.08)', color: 'var(--color-forest)', border: 'rgba(58, 90, 42, 0.2)' },
    playing: { bg: 'rgba(58, 90, 42, 0.08)', color: 'var(--color-forest)', border: 'rgba(58, 90, 42, 0.2)' },
    failed: { bg: 'rgba(139, 32, 32, 0.08)', color: 'var(--color-blood)', border: 'rgba(139, 32, 32, 0.2)' },
  };
  const labels: Record<string, string> = {
    forming: 'Forming', waiting: 'Waiting for Players', pre_game: 'Class Selection',
    starting: 'Starting...', game: 'Game Started', playing: 'Game Started', failed: 'Failed',
  };
  const s = styles[phase] ?? styles.forming;

  return (
    <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide" style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
      {labels[phase] ?? phase}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Unified Lobby View (works for both runner-based and simple lobbies)
// ---------------------------------------------------------------------------

export default function LobbyPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LobbyState | null>(null);
  const [connected, setConnected] = useState(false);
  const [noTimeout, setNoTimeout] = useState(false);
  const [lobbyTimer, setLobbyTimer] = useState<number | null>(null);
  const [gameStarted, setGameStarted] = useState<string | null>(null);
  const serverTimeRef = useRef<{ value: number; at: number }>({ value: 0, at: Date.now() });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!id) return;

    // Fetch initial state via REST
    fetch(`/api/lobbies/${id}`).then(r => r.json()).then(d => {
      if (d?.lobbyId) setState(d);
    }).catch(() => {});

    // Connect to unified /ws/lobby/:id
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/lobby/${id}`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      try {
        const r = JSON.parse(e.data);
        if (r.type === 'lobby_update' && r.data) {
          const d = r.data;
          // Check if the lobby was promoted to a game (state_update from game)
          if (d.phase === 'game' && d.gameId) {
            setGameStarted(d.gameId);
          }
          setState(d);
        }
        // Handle game promotion via state_update (spectators transferred)
        if (r.type === 'state_update' && r.data) {
          setGameStarted(id);
        }
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => setConnected(false);
    return () => { ws.close(); wsRef.current = null; };
  }, [id]);

  useEffect(() => {
    if (state?.noTimeout) setNoTimeout(true);
  }, [state?.noTimeout]);

  useEffect(() => {
    if (state?.phase === 'pre_game' && state.preGame) {
      serverTimeRef.current = { value: state.preGame.timeRemainingSeconds, at: Date.now() };
    } else if (state?.timeRemainingSeconds !== undefined && state.timeRemainingSeconds >= 0) {
      serverTimeRef.current = { value: state.timeRemainingSeconds, at: Date.now() };
    }
  }, [state?.timeRemainingSeconds, state?.preGame?.timeRemainingSeconds, state?.phase]);

  useEffect(() => {
    if (noTimeout || !state || (state.phase !== 'forming' && state.phase !== 'pre_game')) {
      setLobbyTimer(null);
      return;
    }
    const tick = () => {
      const elapsed = Math.floor((Date.now() - serverTimeRef.current.at) / 1000);
      setLobbyTimer(Math.max(0, serverTimeRef.current.value - elapsed));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [state?.phase, noTimeout]);

  // Redirect when game starts
  useEffect(() => {
    if (gameStarted) {
      const t = setTimeout(() => navigate(`/game/${gameStarted}`), 1500);
      return () => clearTimeout(t);
    }
    if (state?.phase === 'game' && state.gameId) {
      const t = setTimeout(() => navigate(`/game/${state.gameId}`), 1500);
      return () => clearTimeout(t);
    }
  }, [state?.phase, state?.gameId, gameStarted, navigate]);

  async function handleNoTimeout() {
    if (noTimeout || !id) return;
    try { const r = await fetch(`/api/lobbies/${id}/no-timeout`, { method: 'POST' }); if (r.ok) setNoTimeout(true); } catch {}
  }

  async function handleCloseLobby() {
    if (!id || !confirm('Close this lobby? All agents will be disconnected.')) return;
    try { await fetch(`/api/lobbies/${id}`, { method: 'DELETE' }); navigate('/lobbies'); } catch {}
  }

  if (!id) return null;

  if (!state && !gameStarted) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <p style={{ color: 'var(--color-ink-faint)' }}>{connected ? 'Waiting for lobby data...' : `Connecting to lobby ${id}...`}</p>
        </div>
      </div>
    );
  }

  if (gameStarted) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="rounded-lg p-4 text-center" style={{ background: 'rgba(58, 90, 42, 0.08)', border: '1px solid rgba(58, 90, 42, 0.2)' }}>
          <p className="font-heading font-semibold" style={{ color: 'var(--color-forest)' }}>Game started! Redirecting...</p>
          <button onClick={() => navigate(`/game/${gameStarted}`)} className="mt-2 rounded font-heading px-4 py-1 text-sm font-medium text-white" style={{ background: 'var(--color-forest)' }}>Go to Game Now</button>
        </div>
      </div>
    );
  }

  if (!state) return null;

  // Determine lobby characteristics
  const isSimpleLobby = !state.teamSize || state.teamSize === 0;
  const gameType = state.gameType ?? 'capture-the-lobster';
  const gameLabel = gameType === 'oathbreaker' ? 'OATHBREAKER' : 'Capture the Lobster';
  const totalSlots = isSimpleLobby
    ? (state.targetPlayers ?? state.agents.length)
    : (state.teamSize || 2) * 2;
  const teamEntries = Object.entries(state.teams);
  const isFull = state.agents.length >= totalSlots;
  const hasExternalAgents = state.agents.some((a: any) => a.id?.startsWith('ext_'));
  const showTimer = !isSimpleLobby && (state.phase === 'forming' || state.phase === 'pre_game');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-xl font-bold" style={{ color: 'var(--color-ink)' }}>Lobby</h1>
          {gameType !== 'capture-the-lobster' && (
            <span className="font-heading text-sm font-medium" style={{ color: 'var(--color-blood)' }}>{gameLabel}</span>
          )}
          <span className="font-mono text-sm" style={{ color: 'var(--color-ink-faint)' }}>{state.lobbyId}</span>
          {phaseBadge(state.phase)}
          <span className="text-sm" style={{ color: 'var(--color-ink-light)' }}>{state.agents.length} / {totalSlots} {isSimpleLobby ? 'players' : 'agents'}</span>
        </div>
        {!connected && <span className="text-xs" style={{ color: 'var(--color-amber)' }}>disconnected</span>}
      </div>

      {/* Timer bar (runner lobbies only) */}
      {showTimer && (
        <TimerBar
          timeRemaining={lobbyTimer}
          noTimeout={noTimeout}
          phase={state.phase}
          onPauseTimer={handleNoTimeout}
          onCloseLobby={handleCloseLobby}
        />
      )}

      {/* Close button for simple lobbies */}
      {isSimpleLobby && (
        <div className="flex justify-end">
          <button
            onClick={handleCloseLobby}
            className="cursor-pointer rounded px-3 py-1 text-xs font-heading font-medium transition-colors"
            style={{ color: 'var(--color-blood)', border: '1px solid rgba(139, 32, 32, 0.2)' }}
          >
            Close Lobby
          </button>
        </div>
      )}

      {/* Forming phase: Join instructions */}
      {state.phase === 'forming' && (
        <JoinInstructions lobbyId={state.lobbyId} />
      )}

      {/* Game redirect */}
      {state.phase === 'game' && state.gameId && (
        <div className="rounded-lg p-4 text-center" style={{ background: 'rgba(58, 90, 42, 0.08)', border: '1px solid rgba(58, 90, 42, 0.2)' }}>
          <p className="font-heading font-semibold" style={{ color: 'var(--color-forest)' }}>Game started! Redirecting...</p>
          <button onClick={() => navigate(`/game/${state.gameId}`)} className="mt-2 rounded font-heading px-4 py-1 text-sm font-medium text-white" style={{ background: 'var(--color-forest)' }}>Go to Game Now</button>
        </div>
      )}

      {/* Full lobby message (simple lobbies) */}
      {isSimpleLobby && isFull && state.phase === 'forming' && (
        <div className="rounded-lg p-4 text-center" style={{ background: 'rgba(58, 90, 42, 0.08)', border: '1px solid rgba(58, 90, 42, 0.2)' }}>
          <p className="font-heading font-semibold" style={{ color: 'var(--color-forest)' }}>All players joined! Starting game...</p>
        </div>
      )}

      {/* Error */}
      {state.phase === 'failed' && state.error && (
        <div className="rounded-lg p-4 text-center" style={{ background: 'rgba(139, 32, 32, 0.06)', border: '1px solid rgba(139, 32, 32, 0.2)' }}>
          <p style={{ color: 'var(--color-blood)' }}>{state.error}</p>
        </div>
      )}

      {/* Pre-game (CtL only) */}
      {state.phase === 'pre_game' && state.preGame && (
        <div className="rounded-lg parchment-strong p-4">
          <PreGamePanel preGame={state.preGame} agents={state.agents} />
        </div>
      )}

      {/* Agents & Teams */}
      {(state.phase === 'forming' || state.phase === 'pre_game') && (
        <div className={teamEntries.length > 0 ? "grid gap-6 md:grid-cols-2" : ""}>
          <PlayerList agents={state.agents} />
          {teamEntries.length > 0 && (
            <div>
              <h3 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-faint)' }}>Teams ({teamEntries.length})</h3>
              <div className="space-y-2">{teamEntries.map(([tid, t]) => <TeamPanel key={tid} teamId={tid} team={t as any} agents={state.agents} />)}</div>
            </div>
          )}
        </div>
      )}

      {/* Chat (runner lobbies) */}
      {state.chat.length > 0 && (
        <ChatPanel messages={state.chat} agents={state.agents} />
      )}
    </div>
  );
}
