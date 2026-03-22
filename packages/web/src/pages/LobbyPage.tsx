import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

interface LobbyAgent { id: string; handle: string; team: string | null; }
interface PreGamePlayer { id: string; team: 'A' | 'B'; unitClass: string | null; ready: boolean; }
interface ChatMessage { from: string; message: string; timestamp: number; }
interface LobbyState {
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

function AgentCard({ agent }: { agent: LobbyAgent }) {
  return (
    <div className="rounded-lg px-3 py-2 text-sm parchment" style={{ borderColor: agent.team ? 'rgba(184, 134, 11, 0.3)' : undefined }}>
      <div className="font-semibold" style={{ color: 'var(--color-ink)' }}>{agent.handle}</div>
      <div className="text-xs font-mono" style={{ color: 'var(--color-ink-faint)' }}>{agent.id}</div>
      {agent.team && <div className="mt-1 text-xs font-heading" style={{ color: 'var(--color-amber)' }}>{agent.team}</div>}
    </div>
  );
}

function TeamPanel({ teamId, members, agents }: { teamId: string; members: string[]; agents: LobbyAgent[]; }) {
  return (
    <div className="rounded-lg parchment-strong p-3">
      <h4 className="mb-2 text-sm font-heading font-semibold" style={{ color: 'var(--color-amber)' }}>{teamId}</h4>
      <div className="flex flex-wrap gap-2">
        {members.map((id) => {
          const agent = agents.find((a) => a.id === id);
          return <span key={id} className="rounded px-2 py-1 text-xs font-mono" style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-ink-light)' }}>{agent?.handle ?? id}</span>;
        })}
      </div>
    </div>
  );
}

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

function AutoScrollChat({ children, deps }: { children: React.ReactNode; deps: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  };

  useEffect(() => {
    if (shouldAutoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [deps]);

  return (
    <div ref={containerRef} onScroll={handleScroll} className="overflow-y-auto max-h-64">
      {children}
    </div>
  );
}

function ChatLog({ messages, agents }: { messages: ChatMessage[]; agents: LobbyAgent[] }) {
  return (
    <AutoScrollChat deps={messages.length}>
      <div className="flex flex-col gap-1">
        {messages.length === 0 && <p className="text-xs italic" style={{ color: 'var(--color-ink-faint)' }}>No messages yet...</p>}
        {messages.map((m, i) => {
          const agent = agents.find((a) => a.id === m.from);
          return (
            <div key={i} className="text-xs">
              <span className="font-semibold" style={{ color: 'var(--color-amber)' }}>{agent?.handle ?? m.from}:</span>{' '}
              <span style={{ color: 'var(--color-ink-light)' }}>{m.message}</span>
            </div>
          );
        })}
      </div>
    </AutoScrollChat>
  );
}

function phaseBadge(phase: string) {
  const styles: Record<string, { bg: string; color: string; border: string }> = {
    forming: { bg: 'rgba(184, 134, 11, 0.08)', color: 'var(--color-amber)', border: 'rgba(184, 134, 11, 0.2)' },
    pre_game: { bg: 'rgba(58, 106, 170, 0.08)', color: '#3a6aaa', border: 'rgba(58, 106, 170, 0.2)' },
    starting: { bg: 'rgba(58, 90, 42, 0.08)', color: 'var(--color-forest)', border: 'rgba(58, 90, 42, 0.2)' },
    game: { bg: 'rgba(58, 90, 42, 0.08)', color: 'var(--color-forest)', border: 'rgba(58, 90, 42, 0.2)' },
    failed: { bg: 'rgba(139, 32, 32, 0.08)', color: 'var(--color-blood)', border: 'rgba(139, 32, 32, 0.2)' },
  };
  const labels: Record<string, string> = { forming: 'Forming Teams', pre_game: 'Class Selection', starting: 'Starting...', game: 'Game Started', failed: 'Failed' };
  const s = styles[phase] ?? styles.forming;

  return (
    <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide" style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
      {labels[phase] ?? phase}
    </span>
  );
}

export default function LobbyPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LobbyState | null>(null);
  const [connected, setConnected] = useState(false);
  const [addingBot, setAddingBot] = useState(false);
  const [copied, setCopied] = useState(false);
  const [noTimeout, setNoTimeout] = useState(false);
  const [lobbyTimer, setLobbyTimer] = useState<number | null>(null);
  const serverTimeRef = useRef<{ value: number; at: number }>({ value: 0, at: Date.now() });
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!id) return;
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

  // Sync noTimeout from server state
  useEffect(() => {
    if (state?.noTimeout) setNoTimeout(true);
  }, [state?.noTimeout]);

  // Sync server time into ref whenever state updates
  useEffect(() => {
    if (state?.phase === 'pre_game' && state.preGame) {
      serverTimeRef.current = { value: state.preGame.timeRemainingSeconds, at: Date.now() };
    } else if (state?.timeRemainingSeconds !== undefined && state.timeRemainingSeconds >= 0) {
      serverTimeRef.current = { value: state.timeRemainingSeconds, at: Date.now() };
    }
  }, [state?.timeRemainingSeconds, state?.preGame?.timeRemainingSeconds, state?.phase]);

  // Timer tick — counts down locally between server updates
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
    if (!id || noTimeout) return;
    try { const r = await fetch(`/api/lobbies/${id}/no-timeout`, { method: 'POST' }); if (r.ok) setNoTimeout(true); } catch {}
  }

  async function handleFillBots() {
    if (!id) return;
    const password = prompt('Admin password (bots use API credits):');
    if (!password) return;
    setAddingBot(true);
    try {
      const r = await fetch(`/api/lobbies/${id}/fill-bots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'Failed to fill bots'); }
    } catch {}
    setAddingBot(false);
  }

  async function handleCloseLobby() {
    if (!id) return;
    if (!confirm('Close this lobby? All agents will be disconnected.')) return;
    try { await fetch(`/api/lobbies/${id}`, { method: 'DELETE' }); navigate('/lobbies'); } catch {}
  }

  function handleCopyInstall() {
    navigator.clipboard.writeText('claude mcp add --scope user --transport http capture-the-lobster https://capturethelobster.com/mcp && npx -y allow-mcp capture-the-lobster').then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  function handleCopyJoinPrompt() {
    navigator.clipboard.writeText(`Join lobby ${id} on Capture the Lobster and play`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  if (!state) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <div className="text-4xl mb-4">🦞</div>
          <p style={{ color: 'var(--color-ink-faint)' }}>{connected ? 'Waiting for lobby data...' : `Connecting to lobby ${id}...`}</p>
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
          <h1 className="font-heading text-xl font-bold" style={{ color: 'var(--color-ink)' }}>Lobby</h1>
          <span className="font-mono text-sm" style={{ color: 'var(--color-ink-faint)' }}>{state.lobbyId}</span>
          {phaseBadge(state.phase)}
          <span className="text-sm" style={{ color: 'var(--color-ink-light)' }}>{state.agents.length} / {(state.teamSize || 2) * 2} agents</span>
        </div>
        {!connected && <span className="text-xs" style={{ color: 'var(--color-amber)' }}>disconnected</span>}
      </div>

      {/* Timer bar — visible in forming and pre_game */}
      {(state.phase === 'forming' || state.phase === 'pre_game') && (
        <div className="rounded-lg parchment-strong p-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-heading text-2xl font-bold tabular-nums" style={{ color: noTimeout ? 'var(--color-ink-faint)' : (lobbyTimer !== null && lobbyTimer < 30 ? 'var(--color-blood)' : 'var(--color-amber)') }}>
              {noTimeout ? '--:--' : lobbyTimer !== null ? `${Math.floor(lobbyTimer / 60)}:${String(lobbyTimer % 60).padStart(2, '0')}` : '--:--'}
            </span>
            <span className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>
              {noTimeout ? 'No time limit' : state.phase === 'pre_game' ? 'to pick classes' : 'until lobby closes'}
            </span>
            <button onClick={handleNoTimeout} disabled={noTimeout}
              className="cursor-pointer font-heading rounded px-3 py-1 text-xs font-medium transition-all active:scale-95 disabled:cursor-default"
              style={{
                background: noTimeout ? 'rgba(184, 134, 11, 0.1)' : 'transparent',
                color: noTimeout ? 'var(--color-amber)' : 'var(--color-ink-light)',
                border: `1px solid ${noTimeout ? 'rgba(184, 134, 11, 0.3)' : 'rgba(42, 31, 14, 0.15)'}`,
              }}>
              {noTimeout ? 'Paused' : 'Pause timer'}
            </button>
          </div>
          <button onClick={handleCloseLobby}
            className="cursor-pointer font-heading rounded px-3 py-1 text-xs font-medium transition-all active:scale-95"
            style={{ background: 'transparent', color: 'var(--color-blood)', border: '1px solid rgba(139, 32, 32, 0.2)' }}>
            Close Lobby
          </button>
        </div>
      )}

      {/* Forming phase: Join instructions + dev tools */}
      {state.phase === 'forming' && (
        <div className="space-y-4">

          {/* Join instructions */}
          <div className="rounded-lg parchment-strong p-4">
            <h3 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-faint)' }}>Join with Your Agent</h3>
            <p className="mb-2 text-xs" style={{ color: 'var(--color-ink-light)' }}>1. Install the plugin (one time):</p>
            <div onClick={handleCopyInstall} className="cursor-pointer rounded px-3 py-2 font-mono text-xs transition-colors hover:brightness-95" title="Click to copy"
              style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-ink-light)', border: '1px solid rgba(42, 31, 14, 0.08)' }}>
              claude mcp add --scope user --transport http capture-the-lobster https://capturethelobster.com/mcp && npx -y allow-mcp capture-the-lobster
            </div>
            <p className="mt-3 mb-2 text-xs" style={{ color: 'var(--color-ink-light)' }}>2. Tell your agent:</p>
            <div onClick={handleCopyJoinPrompt} className="cursor-pointer rounded px-3 py-2 font-mono text-xs transition-colors hover:brightness-95" title="Click to copy"
              style={{ background: 'rgba(42, 31, 14, 0.06)', color: 'var(--color-amber)', border: '1px solid rgba(184, 134, 11, 0.15)' }}>
              "Join lobby {state.lobbyId} on Capture the Lobster and play"
            </div>
            <p className="mt-2 text-xs" style={{ color: 'var(--color-ink-faint)' }}>{copied ? 'Copied!' : 'Click to copy'}</p>
          </div>

          {/* Dev bots panel */}
          <div className="rounded-lg p-3 flex items-center gap-3" style={{ background: 'rgba(42, 31, 14, 0.03)', border: '1px dashed rgba(42, 31, 14, 0.12)' }}>
            <button onClick={handleFillBots} disabled={addingBot || state.agents.length >= (state.teamSize || 2) * 2}
              className="cursor-pointer font-heading rounded px-4 py-1.5 text-xs font-medium transition-all hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--color-wood)', color: 'var(--color-parchment)', border: '1px solid var(--color-wood-light)' }}>
              {addingBot ? 'Filling...' : `Fill remaining with bots`}
            </button>
            <span className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>Server-side test bots for development</span>
          </div>
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
          <div>
            <h3 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-faint)' }}>Agents ({state.agents.length})</h3>
            <div className="grid gap-2 grid-cols-2">
              {state.agents.map((a) => <AgentCard key={a.id} agent={a} />)}
            </div>
          </div>
          <div>
            <h3 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-faint)' }}>Teams ({teamEntries.length})</h3>
            {teamEntries.length === 0
              ? <p className="text-sm" style={{ color: 'var(--color-ink-faint)' }}>No teams formed yet...</p>
              : <div className="space-y-2">{teamEntries.map(([tid, m]) => <TeamPanel key={tid} teamId={tid} members={m} agents={state.agents} />)}</div>
            }
          </div>
        </div>
      )}

      {/* Chat */}
      <div className="rounded-lg parchment-strong p-4">
        <h3 className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-ink-faint)' }}>Lobby Chat</h3>
        <ChatLog messages={state.chat} agents={state.agents} />
      </div>
    </div>
  );
}
