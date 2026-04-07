import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PlayerList, ChatPanel, AutoScrollChat, TimerBar, FillBotsPanel, JoinInstructions, TeamPanel } from '../components/lobby';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface LobbyAgent { id: string; handle: string; team: string | null; }
interface PreGamePlayer { id: string; team: 'A' | 'B'; unitClass: string | null; ready: boolean; }
interface ChatMessage { from: string; message: string; timestamp: number; }

// CtL lobby state (from /ws/lobby/:id)
interface CtlLobbyState {
  lobbyId: string;
  phase: 'forming' | 'pre_game' | 'starting' | 'game' | 'failed';
  agents: LobbyAgent[];
  teams: Record<string, string[]>;
  chat: ChatMessage[];
  preGame: { players: PreGamePlayer[]; timeRemainingSeconds: number; chatA: ChatMessage[]; chatB: ChatMessage[]; } | null;
  gameId: string | null;
  error: string | null;
  teamSize: number;
  noTimeout?: boolean;
  timeRemainingSeconds?: number;
}

// OATHBREAKER waiting room state (from /ws/game/:id)
interface OathWaitingState {
  gameType: 'oathbreaker';
  phase: 'waiting';
  targetPlayers: number;
  players: { id: string; handle: string }[];
}

// ---------------------------------------------------------------------------
// CtL-specific: PreGamePanel (class selection — only used for CtL)
// ---------------------------------------------------------------------------

function PreGamePanel({ preGame, agents }: { preGame: NonNullable<CtlLobbyState['preGame']>; agents: LobbyAgent[]; }) {
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
    forming: 'Forming Teams', waiting: 'Waiting for Players', pre_game: 'Class Selection',
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
// OATHBREAKER Waiting Room View
// ---------------------------------------------------------------------------

function OathWaitingView({ id }: { id: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<OathWaitingState | null>(null);
  const [connected, setConnected] = useState(false);
  const [gameStarted, setGameStarted] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Connect to /ws/game/:id (waiting rooms use the game WS path)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/game/${id}`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'state_update' && msg.data) {
          const d = msg.data;
          if (d.phase === 'waiting') {
            setState(d);
          } else {
            // Game has started — the waiting room was promoted
            setGameStarted(id);
          }
        }
        // Also handle game_started message if server sends one
        if (msg.type === 'game_started' || msg.type === 'game_update') {
          setGameStarted(id);
        }
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => setConnected(false);
    return () => { ws.close(); wsRef.current = null; };
  }, [id]);

  // Redirect when game starts
  useEffect(() => {
    if (gameStarted) {
      const t = setTimeout(() => navigate(`/game/${gameStarted}`), 1500);
      return () => clearTimeout(t);
    }
  }, [gameStarted, navigate]);

  if (!state && !gameStarted) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <p className="text-lg font-heading mb-2" style={{ color: 'var(--color-blood)' }}>OATHBREAKER</p>
          <p style={{ color: 'var(--color-ink-faint)' }}>{connected ? 'Waiting for room data...' : `Connecting to waiting room ${id}...`}</p>
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

  const agents = (state!.players || []).map(p => ({ id: p.id, handle: p.handle, team: null }));
  const isFull = agents.length >= state!.targetPlayers;
  const hasExternalAgents = agents.some(a => a.id?.startsWith('ext_'));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-xl font-bold" style={{ color: 'var(--color-ink)' }}>Waiting Room</h1>
          <span className="font-heading text-sm font-medium" style={{ color: 'var(--color-blood)' }}>OATHBREAKER</span>
          <span className="font-mono text-sm" style={{ color: 'var(--color-ink-faint)' }}>{id}</span>
          {phaseBadge('waiting')}
          <span className="text-sm" style={{ color: 'var(--color-ink-light)' }}>{agents.length} / {state!.targetPlayers} players</span>
        </div>
        {!connected && <span className="text-xs" style={{ color: 'var(--color-amber)' }}>disconnected</span>}
      </div>

      {/* Join instructions */}
      <JoinInstructions lobbyId={id} />

      {/* Fill bots */}
      <FillBotsPanel lobbyId={id} isFull={isFull} agentCount={agents.length} hasExternalAgents={hasExternalAgents} />

      {/* Player list */}
      <PlayerList agents={agents} />

      {/* Status message */}
      {isFull && (
        <div className="rounded-lg p-4 text-center" style={{ background: 'rgba(58, 90, 42, 0.08)', border: '1px solid rgba(58, 90, 42, 0.2)' }}>
          <p className="font-heading font-semibold" style={{ color: 'var(--color-forest)' }}>All players joined! Starting game...</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CtL Lobby View (original, refactored to use extracted components)
// ---------------------------------------------------------------------------

function CtlLobbyView({ id }: { id: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<CtlLobbyState | null>(null);
  const [connected, setConnected] = useState(false);
  const [noTimeout, setNoTimeout] = useState(false);
  const [lobbyTimer, setLobbyTimer] = useState<number | null>(null);
  const serverTimeRef = useRef<{ value: number; at: number }>({ value: 0, at: Date.now() });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetch(`/api/lobbies/${id}`).then(r => r.json()).then(d => { if (d?.lobbyId) setState(d); }).catch(() => {});
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/lobby/${id}`);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => { try { const r = JSON.parse(e.data); if (r.type === 'lobby_update' && r.data) setState(r.data); } catch {} };
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

  useEffect(() => {
    if (state?.phase === 'game' && state.gameId) {
      const t = setTimeout(() => navigate(`/game/${state.gameId}`), 1500);
      return () => clearTimeout(t);
    }
  }, [state?.phase, state?.gameId, navigate]);

  async function handleNoTimeout() {
    if (noTimeout) return;
    try { const r = await fetch(`/api/lobbies/${id}/no-timeout`, { method: 'POST' }); if (r.ok) setNoTimeout(true); } catch {}
  }

  async function handleCloseLobby() {
    if (!confirm('Close this lobby? All agents will be disconnected.')) return;
    try { await fetch(`/api/lobbies/${id}`, { method: 'DELETE' }); navigate('/lobbies'); } catch {}
  }

  if (!state) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <div className="text-4xl mb-4">{'\u{1F99E}'}</div>
          <p style={{ color: 'var(--color-ink-faint)' }}>{connected ? 'Waiting for lobby data...' : `Connecting to lobby ${id}...`}</p>
        </div>
      </div>
    );
  }

  const teamEntries = Object.entries(state.teams);
  const isFull = state.agents.length >= (state.teamSize || 2) * 2;
  const hasExternalAgents = state.agents.some((a: any) => a.id?.startsWith('ext_'));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-xl font-bold" style={{ color: 'var(--color-ink)' }}>Lobby</h1>
          <span className="font-mono text-sm" style={{ color: 'var(--color-ink-faint)' }}>{state.lobbyId}</span>
          {phaseBadge(state.phase)}
          <span className="text-sm" style={{ color: 'var(--color-ink-light)' }}>{state.agents.length} / {(state.teamSize || 2) * 2} agents</span>
        </div>
        {!connected && <span className="text-xs" style={{ color: 'var(--color-amber)' }}>disconnected</span>}
      </div>

      {/* Timer bar */}
      {(state.phase === 'forming' || state.phase === 'pre_game') && (
        <TimerBar
          timeRemaining={lobbyTimer}
          noTimeout={noTimeout}
          phase={state.phase}
          onPauseTimer={handleNoTimeout}
          onCloseLobby={handleCloseLobby}
        />
      )}

      {/* Forming phase: Join instructions + dev tools */}
      {state.phase === 'forming' && (
        <div className="space-y-4">
          <JoinInstructions lobbyId={state.lobbyId} />
          <FillBotsPanel lobbyId={state.lobbyId} isFull={isFull} agentCount={state.agents.length} hasExternalAgents={hasExternalAgents} />
        </div>
      )}

      {/* Game redirect */}
      {state.phase === 'game' && state.gameId && (
        <div className="rounded-lg p-4 text-center" style={{ background: 'rgba(58, 90, 42, 0.08)', border: '1px solid rgba(58, 90, 42, 0.2)' }}>
          <p className="font-heading font-semibold" style={{ color: 'var(--color-forest)' }}>Game started! Redirecting...</p>
          <button onClick={() => navigate(`/game/${state.gameId}`)} className="mt-2 rounded font-heading px-4 py-1 text-sm font-medium text-white" style={{ background: 'var(--color-forest)' }}>Go to Game Now</button>
        </div>
      )}

      {/* Error */}
      {state.phase === 'failed' && state.error && (
        <div className="rounded-lg p-4 text-center" style={{ background: 'rgba(139, 32, 32, 0.06)', border: '1px solid rgba(139, 32, 32, 0.2)' }}>
          <p style={{ color: 'var(--color-blood)' }}>{state.error}</p>
        </div>
      )}

      {/* Pre-game */}
      {state.phase === 'pre_game' && state.preGame && (
        <div className="rounded-lg parchment-strong p-4">
          <PreGamePanel preGame={state.preGame} agents={state.agents} />
        </div>
      )}

      {/* Agents & Teams */}
      {(state.phase === 'forming' || state.phase === 'pre_game') && (
        <div className="grid gap-6 md:grid-cols-2">
          <PlayerList agents={state.agents} />
          <div>
            <h3 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-faint)' }}>Teams ({teamEntries.length})</h3>
            {teamEntries.length === 0
              ? <p className="text-sm" style={{ color: 'var(--color-ink-faint)' }}>No teams formed yet...</p>
              : <div className="space-y-2">{teamEntries.map(([tid, t]) => <TeamPanel key={tid} teamId={tid} team={t as any} agents={state.agents} />)}</div>
            }
          </div>
        </div>
      )}

      {/* Chat */}
      <ChatPanel messages={state.chat} agents={state.agents} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// LobbyPage — routes to CtL lobby or OATHBREAKER waiting room
// ---------------------------------------------------------------------------

export default function LobbyPage() {
  const { id } = useParams<{ id: string }>();
  const [mode, setMode] = useState<'loading' | 'ctl' | 'oathbreaker'>('loading');

  useEffect(() => {
    if (!id) return;

    // Try CtL lobby first
    fetch(`/api/lobbies/${id}`)
      .then(r => {
        if (r.ok) return r.json();
        throw new Error('not a lobby');
      })
      .then(d => {
        if (d?.lobbyId) {
          setMode('ctl');
          return;
        }
        throw new Error('not a lobby');
      })
      .catch(() => {
        // Try as a game/waiting room
        fetch(`/api/games/${id}`)
          .then(r => {
            if (r.ok) return r.json();
            throw new Error('not found');
          })
          .then(d => {
            if (d?.gameType === 'oathbreaker' && d?.phase === 'waiting') {
              setMode('oathbreaker');
            } else {
              // It's an active game or unknown — fall back to CtL lobby view
              // (which will show the "connecting" state)
              setMode('ctl');
            }
          })
          .catch(() => {
            // Default to CtL lobby view
            setMode('ctl');
          });
      });
  }, [id]);

  if (!id) return null;

  if (mode === 'loading') {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <p style={{ color: 'var(--color-ink-faint)' }}>Loading lobby {id}...</p>
        </div>
      </div>
    );
  }

  if (mode === 'oathbreaker') {
    return <OathWaitingView id={id} />;
  }

  return <CtlLobbyView id={id} />;
}
