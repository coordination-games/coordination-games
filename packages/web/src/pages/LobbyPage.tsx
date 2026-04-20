import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { JoinInstructions, PlayerList, TeamPanel, TimerBar } from '../components/lobby';
import { API_BASE, getWsUrl } from '../config.js';
import { SlotHost } from '../plugins';

// ---------------------------------------------------------------------------
// Shared types — matches the new generic LobbyDO state shape
// ---------------------------------------------------------------------------

interface LobbyAgent {
  id: string;
  handle: string;
  elo?: number;
}

// Relay messages from the typed relay. Phase 5.1: this page no longer
// inspects `type`/`data` — it just forwards the array to `<SlotHost>` so
// plugin-provided panels (chat, future trust panel, etc.) can render their
// own slice. Field names mirror the wire shape so plugins can share a
// type with the SlotProps `relayMessages`.
type RelayScopeKind = 'all' | 'team' | 'dm';
interface RelayMessage {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  data: any;
  scope: { kind: RelayScopeKind; teamId?: string; recipientHandle?: string };
  pluginId: string;
  sender: string;
  timestamp: number;
}

interface LobbyState {
  lobbyId: string;
  gameType: string;
  agents: LobbyAgent[];
  currentPhase: {
    id: string; // e.g. 'team-formation', 'class-selection', 'open-queue'
    name: string; // e.g. 'Team Formation'
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    view: any; // phase-specific view data from phase.getView()
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    tools: any[]; // available tools in this phase
  } | null;
  relay: RelayMessage[];
  phase: 'lobby' | 'in_progress' | 'finished';
  deadlineMs: number | null;
  gameId: string | null;
  error: string | null;
  noTimeout?: boolean;
}

// ---------------------------------------------------------------------------
// CtL-specific: ClassSelectionPanel — renders currentPhase.view from ClassSelectionPhase
// view shape: { validClasses: string[], classPicks: Record<string, string>, playerIds: string[] }
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
function ClassSelectionPanel({ view, agents }: { view: any; agents: LobbyAgent[] }) {
  const classColors: Record<string, string> = {
    rogue: 'var(--color-forest)',
    knight: '#3a6aaa',
    mage: '#7a4aaa',
  };
  const classPicks: Record<string, string> = view?.classPicks ?? {};
  const playerIds: string[] = view?.playerIds ?? [];

  return (
    <div className="space-y-4">
      <div
        className="text-center text-sm font-heading font-semibold"
        style={{ color: 'var(--color-amber)' }}
      >
        Class Selection
      </div>
      <div className="space-y-1">
        {playerIds.map((pid) => {
          const agent = agents.find((a) => a.id === pid);
          const cls = classPicks[pid];
          return (
            <div
              key={pid}
              className="flex items-center justify-between rounded parchment px-3 py-2"
            >
              <span className="text-sm" style={{ color: 'var(--color-ink)' }}>
                {agent?.handle ?? pid}
              </span>
              <span
                className="text-xs font-semibold"
                style={{
                  color: cls
                    ? (classColors[cls] ?? 'var(--color-ink-faint)')
                    : 'var(--color-ink-faint)',
                }}
              >
                {cls ?? 'choosing...'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase badge (shared)
// ---------------------------------------------------------------------------

function phaseBadge(phase: string, currentPhaseId?: string) {
  // Phase strings here are the unified `GamePhaseKind`
  // ('lobby' | 'in_progress' | 'finished'). 'finished' covers both
  // game-over and lobby-error — the page-level layout uses `state.error`
  // to distinguish those when rendering.
  const styles: Record<string, { bg: string; color: string; border: string }> = {
    lobby: {
      bg: 'rgba(184, 134, 11, 0.08)',
      color: 'var(--color-amber)',
      border: 'rgba(184, 134, 11, 0.2)',
    },
    in_progress: {
      bg: 'rgba(58, 90, 42, 0.08)',
      color: 'var(--color-forest)',
      border: 'rgba(58, 90, 42, 0.2)',
    },
    finished: {
      bg: 'rgba(139, 32, 32, 0.08)',
      color: 'var(--color-blood)',
      border: 'rgba(139, 32, 32, 0.2)',
    },
  };
  const phaseLabels: Record<string, string> = {
    'team-formation': 'Team Formation',
    'class-selection': 'Class Selection',
    'open-queue': 'Waiting for Players',
  };
  const labels: Record<string, string> = {
    lobby: (currentPhaseId && phaseLabels[currentPhaseId]) || 'In Progress',
    in_progress: 'Game Started',
    finished: 'Finished',
  };
  const s = styles[phase] ?? styles.lobby;

  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-heading font-medium tracking-wide"
      // @ts-expect-error TS18048: 's' is possibly 'undefined'. — TODO(2.3-followup)
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
    >
      {labels[phase] ?? phase}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Unified Lobby View (works for all game types via generic phase runner)
// ---------------------------------------------------------------------------

export default function LobbyPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LobbyState | null>(null);
  const [connected, setConnected] = useState(false);
  const [noTimeout, setNoTimeout] = useState(false);
  const [lobbyTimer, setLobbyTimer] = useState<number | null>(null);
  const [gameStarted, setGameStarted] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!id) return;

    // Fetch initial state via REST
    fetch(`${API_BASE}/lobbies/${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.lobbyId) setState(d);
      })
      .catch(() => {});

    // Connect to unified /ws/lobby/:id — new LobbyDO sends raw state (no wrapper)
    const ws = new WebSocket(getWsUrl(`/ws/lobby/${id}`));
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d?.lobbyId) {
          // Raw lobby state from new LobbyDO
          if (d.phase === 'game' && d.gameId) {
            setGameStarted(d.gameId);
          }
          setState(d);
        }
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => setConnected(false);
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (state?.noTimeout) setNoTimeout(true);
  }, [state?.noTimeout]);

  // Compute client-side timer from server deadlineMs
  useEffect(() => {
    if (noTimeout || !state || state.phase !== 'lobby' || !state.deadlineMs) {
      setLobbyTimer(null);
      return;
    }
    const tick = () => {
      // biome-ignore lint/style/noNonNullAssertion: pre-existing non-null assertion; verify in cleanup followup — TODO(2.3-followup)
      const remaining = Math.max(0, Math.floor((state.deadlineMs! - Date.now()) / 1000));
      setLobbyTimer(remaining);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [state?.phase, state?.deadlineMs, noTimeout, state]);

  // Redirect when game starts
  useEffect(() => {
    if (gameStarted) {
      const t = setTimeout(() => navigate(`/game/${gameStarted}`), 1500);
      return () => clearTimeout(t);
    }
    if (state?.phase === 'in_progress' && state.gameId) {
      const t = setTimeout(() => navigate(`/game/${state.gameId}`), 1500);
      return () => clearTimeout(t);
    }
  }, [state?.phase, state?.gameId, gameStarted, navigate]);

  async function handleCloseLobby() {
    if (!id || !confirm('Close this lobby? All agents will be disconnected.')) return;
    try {
      await fetch(`${API_BASE}/lobbies/${id}`, { method: 'DELETE' });
      navigate('/lobbies');
    } catch {}
  }

  if (!id) return null;

  if (!state && !gameStarted) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-5rem)]">
        <div className="text-center">
          <p style={{ color: 'var(--color-ink-faint)' }}>
            {connected ? 'Waiting for lobby data...' : `Connecting to lobby ${id}...`}
          </p>
        </div>
      </div>
    );
  }

  if (gameStarted) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <div
          className="rounded-lg p-4 text-center"
          style={{
            background: 'rgba(58, 90, 42, 0.08)',
            border: '1px solid rgba(58, 90, 42, 0.2)',
          }}
        >
          <p className="font-heading font-semibold" style={{ color: 'var(--color-forest)' }}>
            Game started! Redirecting...
          </p>
          {/* biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup) */}
          <button
            onClick={() => navigate(`/game/${gameStarted}`)}
            className="mt-2 rounded font-heading px-4 py-1 text-sm font-medium text-white"
            style={{ background: 'var(--color-forest)' }}
          >
            Go to Game Now
          </button>
        </div>
      </div>
    );
  }

  if (!state) return null;

  // Derive display info from the new state shape
  const gameType = state.gameType ?? 'capture-the-lobster';
  const gameLabel = gameType === 'oathbreaker' ? 'OATHBREAKER' : 'Capture the Lobster';
  const phaseId = state.currentPhase?.id;
  const phaseView = state.currentPhase?.view;

  // Determine if this is a team-based or simple lobby from phase view data
  const isTeamPhase = phaseId === 'team-formation';
  const isClassSelection = phaseId === 'class-selection';
  const _isOpenQueue = phaseId === 'open-queue';
  const showTimer = state.phase === 'lobby' && state.deadlineMs != null;

  // Team formation view: { teams: [{id, members, invites}], unassigned, teamSize, numTeams }
  const teams: Array<{ id: string; members: string[]; invites: string[] }> = isTeamPhase
    ? (phaseView?.teams ?? [])
    : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="font-heading text-xl font-bold" style={{ color: 'var(--color-ink)' }}>
            Lobby
          </h1>
          {gameType !== 'capture-the-lobster' && (
            <span
              className="font-heading text-sm font-medium"
              style={{ color: 'var(--color-blood)' }}
            >
              {gameLabel}
            </span>
          )}
          <span className="font-mono text-sm" style={{ color: 'var(--color-ink-faint)' }}>
            {state.lobbyId}
          </span>
          {phaseBadge(state.phase, phaseId)}
          <span className="text-sm" style={{ color: 'var(--color-ink-light)' }}>
            {state.agents.length} agents
          </span>
        </div>
        {!connected && (
          <span className="text-xs" style={{ color: 'var(--color-amber)' }}>
            disconnected
          </span>
        )}
      </div>

      {/* Timer bar */}
      {showTimer && (
        <TimerBar
          timeRemaining={lobbyTimer}
          noTimeout={noTimeout}
          phase={phaseId ?? state.phase}
          onCloseLobby={handleCloseLobby}
        />
      )}

      {/* Close button (always available for non-timer lobbies) */}
      {!showTimer && (
        <div className="flex justify-end">
          {/* biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup) */}
          <button
            onClick={handleCloseLobby}
            className="cursor-pointer rounded px-3 py-1 text-xs font-heading font-medium transition-colors"
            style={{ color: 'var(--color-blood)', border: '1px solid rgba(139, 32, 32, 0.2)' }}
          >
            Close Lobby
          </button>
        </div>
      )}

      {/* Running phase: Join instructions */}
      {state.phase === 'lobby' && (
        <JoinInstructions lobbyId={state.lobbyId} gameType={state.gameType} />
      )}

      {/* Game redirect */}
      {state.phase === 'in_progress' && state.gameId && (
        <div
          className="rounded-lg p-4 text-center"
          style={{
            background: 'rgba(58, 90, 42, 0.08)',
            border: '1px solid rgba(58, 90, 42, 0.2)',
          }}
        >
          <p className="font-heading font-semibold" style={{ color: 'var(--color-forest)' }}>
            Game started! Redirecting...
          </p>
          {/* biome-ignore lint/a11y/useButtonType: pre-existing button without type; cleanup followup — TODO(2.3-followup) */}
          <button
            onClick={() => navigate(`/game/${state.gameId}`)}
            className="mt-2 rounded font-heading px-4 py-1 text-sm font-medium text-white"
            style={{ background: 'var(--color-forest)' }}
          >
            Go to Game Now
          </button>
        </div>
      )}

      {/* Error — finished phase with an error string is the lobby-died case. */}
      {state.phase === 'finished' && state.error && (
        <div
          className="rounded-lg p-4 text-center"
          style={{
            background: 'rgba(139, 32, 32, 0.06)',
            border: '1px solid rgba(139, 32, 32, 0.2)',
          }}
        >
          <p style={{ color: 'var(--color-blood)' }}>{state.error}</p>
        </div>
      )}

      {/* Class selection phase (CtL) */}
      {isClassSelection && phaseView && (
        <div className="rounded-lg parchment-strong p-4">
          <ClassSelectionPanel view={phaseView} agents={state.agents} />
        </div>
      )}

      {/* Agents & Teams — shown during the lobby phase */}
      {state.phase === 'lobby' && (
        <div className={teams.length > 0 ? 'grid gap-6 md:grid-cols-2' : ''}>
          <PlayerList agents={state.agents} />
          {teams.length > 0 && (
            <div>
              <h3
                className="mb-3 font-heading text-sm font-semibold uppercase tracking-wider"
                style={{ color: 'var(--color-ink-faint)' }}
              >
                Teams ({teams.length})
              </h3>
              <div className="space-y-2">
                {teams.map((t) => (
                  <TeamPanel key={t.id} teamId={t.id} team={t} agents={state.agents} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Plugin-provided side panels — chat, future trust UI, etc. */}
      <SlotHost
        name="lobby:panel"
        lobbyId={state.lobbyId}
        relayMessages={state.relay ?? []}
        agents={state.agents.map((a) => ({ id: a.id, handle: a.handle }))}
      />
    </div>
  );
}
