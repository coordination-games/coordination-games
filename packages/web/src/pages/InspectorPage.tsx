import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { InspectError, InspectGameDiagnostics, InspectResponse } from '../api';
import { fetchInspect } from '../api';
import { cleanAgentDisplayName } from '../games/tragedy-of-the-commons/original/lib/format';

const INSPECTOR_KEY_STORAGE_KEY = 'coordination-games.inspector-key';
const LEGACY_KEY_STORAGE_KEY = 'coordination-games.admin-token';
const LOCAL_DEV_INSPECTOR_KEY = import.meta.env.DEV ? 'local-inspector-token' : '';

type InspectorTab = 'events' | 'agent' | 'replay';
type EventFilter = 'all' | 'game' | 'chat' | 'reasoning' | 'trust' | 'crisis' | 'action';

interface ResourceInventory {
  grain?: number;
  timber?: number;
  ore?: number;
  fish?: number;
  water?: number;
  energy?: number;
}

interface InspectorPlayer {
  id: string;
  resources?: ResourceInventory;
  influence?: number;
  vp?: number;
  regionsControlled?: string[];
}

interface InspectorEvent {
  id: string;
  timestamp: number;
  type: string;
  category: EventFilter;
  summary: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInspectError(value: unknown): value is InspectError {
  return isRecord(value) && typeof value.error === 'string';
}

function isGameDiagnostics(value: unknown): value is InspectGameDiagnostics {
  return isRecord(value) && typeof value.now === 'number' && 'gameState' in value;
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function formatTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function readPlayers(state: unknown): InspectorPlayer[] {
  const players = toRecord(state).players;
  if (!Array.isArray(players)) return [];
  return players.filter((player): player is InspectorPlayer => {
    return isRecord(player) && typeof player.id === 'string';
  });
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}...` : value;
}

function displayAgentName(playerId: string, handles: Record<string, string>): string {
  return cleanAgentDisplayName(handles[playerId] ?? shortId(playerId));
}

function resourceTotal(resources: ResourceInventory | undefined): number {
  if (!resources) return 0;
  return Object.values(resources).reduce((total, value) => total + (value ?? 0), 0);
}

function readSubmittedActions(state: unknown): Record<string, unknown> {
  const submittedActions = toRecord(state).submittedActions;
  return isRecord(submittedActions) ? submittedActions : {};
}

function readHandleMap(meta: unknown): Record<string, string> {
  const handleMap = toRecord(meta).handleMap;
  if (!isRecord(handleMap)) return {};
  return Object.fromEntries(
    Object.entries(handleMap).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function readEcosystems(state: unknown): Array<Record<string, unknown>> {
  const ecosystems = toRecord(state).ecosystems;
  return Array.isArray(ecosystems) ? ecosystems.filter(isRecord) : [];
}

function readRelayMessages(diagnostics: InspectGameDiagnostics | null): unknown[] {
  const inspectRelay = toRecord(diagnostics).relayMessages;
  if (Array.isArray(inspectRelay)) return inspectRelay;
  const metaRelay = toRecord(diagnostics?.meta).relayMessages;
  if (Array.isArray(metaRelay)) return metaRelay;
  const progressRelay = toRecord(diagnostics?.progress).relayMessages;
  return Array.isArray(progressRelay) ? progressRelay : [];
}

function readReasoningEntries(
  diagnostics: InspectGameDiagnostics | null,
  playerId: string | null | undefined,
): Array<Record<string, unknown>> {
  return readRelayMessages(diagnostics)
    .filter((relay) => {
      const relayRecord = toRecord(relay);
      return relayRecord.type === 'reasoning' && (!playerId || relayRecord.sender === playerId);
    })
    .map(toRecord);
}

function summarizeAction(action: unknown): string {
  if (action === null || action === undefined) return 'waiting';
  if (!isRecord(action)) return String(action);
  if (action.type === 'offer_trade') return 'offered trade';
  if (action.type === 'extract_commons') return 'extracted commons';
  if (action.type === 'build_settlement') return 'built settlement';
  if (action.type === 'pass') return 'held position';
  if (action.type === 'round_timeout') return 'timed out';
  if (action.type === 'game_start') return 'game started';
  return typeof action.type === 'string' ? action.type.replace(/_/g, ' ') : 'submitted';
}

function eventTypeLabel(type: string): string {
  if (type === 'game.session.inspect') return 'Session loaded';
  if (type === 'game.phase.change') return 'Phase changed';
  if (type === 'game.round.current') return 'Round update';
  if (type === 'game.action') return 'Action submitted';
  if (type === 'commons.ecosystem.health') return 'Commons health update';
  if (type === 'reasoning') return 'Published reasoning';
  if (type === 'messaging') return 'Message';
  return type.replace(/[._]/g, ' ');
}

function summarizeRelayScope(relay: Record<string, unknown>): string {
  const scope = relay.scope;
  if (typeof scope === 'string') return scope === 'all' ? 'public' : `dm → ${scope}`;
  const scopeRecord = toRecord(scope);
  const kind = typeof scopeRecord.kind === 'string' ? scopeRecord.kind : 'all';
  if (kind === 'dm') {
    return `dm → ${cleanAgentDisplayName(String(scopeRecord.recipientHandle ?? 'unknown'))}`;
  }
  if (kind === 'team') return `team ${String(scopeRecord.teamId ?? '')}`.trim();
  return 'public';
}

function buildEvents(
  inspect: InspectResponse | null,
  diagnostics: InspectGameDiagnostics | null,
  handles: Record<string, string>,
): InspectorEvent[] {
  const state = toRecord(diagnostics?.gameState);
  const events: InspectorEvent[] = [];
  const now = inspect?.now ?? diagnostics?.now ?? Date.now();

  // Use the most recent relay timestamp as the "state as of" time
  // so synthetic state events don't all show the page-load time
  const relays = readRelayMessages(diagnostics);
  const latestRelayTs = relays.reduce((max: number, relay: unknown) => {
    const r = toRecord(relay);
    const ts = typeof r.timestamp === 'number' && Number.isFinite(r.timestamp) ? r.timestamp : 0;
    return ts > max ? ts : max;
  }, 0);
  const stateTs = latestRelayTs > 0 ? latestRelayTs : now;

  if (inspect) {
    events.push({
      id: 'session-loaded',
      timestamp: now,
      type: 'game.session.inspect',
      category: 'game',
      summary: `${inspect.gameId ?? inspect.sessionId} loaded from Inspector endpoint`,
      data: {
        sessionId: inspect.sessionId,
        gameId: inspect.gameId,
        lobbyId: inspect.lobby?.lobby_id ?? null,
        gameType: inspect.gameRow?.game_type ?? inspect.lobby?.game_type ?? null,
        now: inspect.now,
      },
    });
  }

  if (typeof state.phase === 'string') {
    events.push({
      id: 'phase',
      timestamp: stateTs,
      type: 'game.phase.change',
      category: 'game',
      summary: `→ ${state.phase}`,
      data: { phase: state.phase, round: state.round },
    });
  }

  if (typeof state.round === 'number') {
    events.push({
      id: 'round',
      timestamp: stateTs,
      type: 'game.round.current',
      category: 'game',
      summary: `Round ${state.round}`,
      data: { round: state.round },
    });
  }

  for (const [playerId, action] of Object.entries(readSubmittedActions(state))) {
    events.push({
      id: `action-${playerId}`,
      timestamp: stateTs,
      type: 'game.action',
      category: 'action',
      summary: `${displayAgentName(playerId, handles)} ${summarizeAction(action)}`,
      data: { playerId, action },
    });
  }

  for (const ecosystem of readEcosystems(state)) {
    const health = typeof ecosystem.health === 'number' ? ecosystem.health : null;
    const name = typeof ecosystem.name === 'string' ? ecosystem.name : ecosystem.id;
    events.push({
      id: `ecosystem-${String(ecosystem.id ?? name)}`,
      timestamp: stateTs,
      type: 'commons.ecosystem.health',
      category: 'game',
      summary: `${String(name)} health ${health ?? '—'}`,
      data: ecosystem,
    });
  }

  for (const [index, relay] of readRelayMessages(diagnostics).entries()) {
    const relayRecord = toRecord(relay);
    const relayData = toRecord(relayRecord.data);
    const type = typeof relayRecord.type === 'string' ? relayRecord.type : 'relay.message';
    const sender = typeof relayRecord.sender === 'string' ? relayRecord.sender : 'table';
    const senderLabel = sender === 'table' ? 'Table' : displayAgentName(sender, handles);
    const scopeSummary = summarizeRelayScope(relayRecord);
    const body =
      typeof relayData.body === 'string'
        ? relayData.body
        : typeof relayRecord.content === 'string'
          ? relayRecord.content
          : type;
    events.push({
      id: `relay-${index}`,
      timestamp:
        typeof relayRecord.timestamp === 'number' && Number.isFinite(relayRecord.timestamp)
          ? relayRecord.timestamp
          : now,
      type,
      category: type.includes('reasoning') ? 'reasoning' : type === 'messaging' ? 'chat' : 'game',
      summary: `${senderLabel} · ${scopeSummary}: ${body}`.slice(0, 160),
      data: relay,
    });
  }

  return events;
}

function eventMatchesFilter(event: InspectorEvent, filter: EventFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'game') return event.type.startsWith('game.');
  if (filter === 'chat')
    return (
      event.category === 'chat' || event.type.startsWith('chat.') || event.type.includes('message')
    );
  if (filter === 'reasoning') return event.category === 'reasoning' || event.type === 'reasoning';
  if (filter === 'trust')
    return event.type.startsWith('trust.') || event.type.includes('commitment');
  if (filter === 'crisis') return event.type.startsWith('crisis.');
  if (filter === 'action') return event.category === 'action';
  return true;
}

function eventAccent(category: EventFilter): string {
  if (category === 'game') return 'border-l-[#58a6ff]';
  if (category === 'action') return 'border-l-[#3fb950]';
  if (category === 'chat') return 'border-l-[#bc8cff]';
  if (category === 'reasoning') return 'border-l-[#f778ba]';
  if (category === 'trust') return 'border-l-[#d29922]';
  if (category === 'crisis') return 'border-l-[#f85149]';
  return 'border-l-[#30363d]';
}

function JsonViewer({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 max-w-full overflow-auto rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-[11px] leading-relaxed text-[#c9d1d9]">
      {stringify(value)}
    </pre>
  );
}

function JsonSection({
  title,
  value,
  open = false,
}: {
  title: string;
  value: unknown;
  open?: boolean;
}) {
  return (
    <details className="mb-3 rounded-md border border-[#30363d] bg-[#0d1117]" open={open}>
      <summary className="cursor-pointer px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-[#8b949e] hover:text-[#c9d1d9]">
        {title}
      </summary>
      <div className="border-t border-[#30363d] p-2">
        <JsonViewer value={value} />
      </div>
    </details>
  );
}

function EmptyState({ children }: { children: string }) {
  return <div className="py-10 text-center text-xs text-[#8b949e]">{children}</div>;
}

export default function InspectorPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const [inspectorKey, setInspectorKey] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [inspect, setInspect] = useState<InspectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>('events');
  const [filter, setFilter] = useState<EventFilter>('all');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<InspectorEvent | null>(null);
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const stored =
      window.localStorage.getItem(INSPECTOR_KEY_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_KEY_STORAGE_KEY) ??
      LOCAL_DEV_INSPECTOR_KEY;
    setInspectorKey(stored);
    setDraftKey(stored);
  }, []);

  const loadInspect = useCallback(async () => {
    if (!gameId) return;
    if (!inspectorKey.trim()) {
      setError('Inspector access key required for this local diagnostic endpoint.');
      setInspect(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchInspect(gameId, inspectorKey.trim());
      setInspect(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inspector data');
    } finally {
      setLoading(false);
    }
  }, [inspectorKey, gameId]);

  useEffect(() => {
    void loadInspect();
  }, [loadInspect]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const handle = window.setInterval(() => {
      void loadInspect();
    }, 3500);
    return () => window.clearInterval(handle);
  }, [autoRefresh, loadInspect]);

  const diagnostics = useMemo(() => {
    if (isGameDiagnostics(inspect?.gameInspect)) return inspect.gameInspect;
    return null;
  }, [inspect]);

  const inspectError = useMemo(() => {
    if (isInspectError(inspect?.gameInspect)) return inspect.gameInspect;
    return null;
  }, [inspect]);

  const gameState = diagnostics?.gameState;
  const stateRecord = toRecord(gameState);
  const players = useMemo(() => readPlayers(gameState), [gameState]);
  const submittedActions = useMemo(() => readSubmittedActions(gameState), [gameState]);
  const handles = useMemo(() => readHandleMap(diagnostics?.meta), [diagnostics]);
  const events = useMemo(
    () => buildEvents(inspect, diagnostics, handles),
    [inspect, diagnostics, handles],
  );
  const filteredEvents = useMemo(
    () => events.filter((event) => eventMatchesFilter(event, filter)),
    [events, filter],
  );
  const ecosystems = useMemo(() => readEcosystems(gameState), [gameState]);
  const selectedAgent = selectedAgentId
    ? (players.find((player) => player.id === selectedAgentId) ?? null)
    : null;
  const allAgentReasoning = useMemo(() => readReasoningEntries(diagnostics, null), [diagnostics]);

  const toggleEventExpansion = useCallback((event: InspectorEvent) => {
    setSelectedEvent(event);
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (next.has(event.id)) next.delete(event.id);
      else next.add(event.id);
      return next;
    });
  }, []);

  const resolvedGameId =
    inspect?.gameId ?? inspect?.gameRow?.game_id ?? inspect?.lobby?.game_id ?? gameId ?? '';
  const gameType = inspect?.gameRow?.game_type ?? inspect?.lobby?.game_type ?? 'unknown';
  const currentRound = typeof stateRecord.round === 'number' ? stateRecord.round : '—';
  const phase =
    typeof stateRecord.phase === 'string' ? stateRecord.phase : (inspect?.lobby?.phase ?? '—');

  return (
    <div className="h-[calc(100vh-5rem)] w-full max-w-full overflow-hidden bg-[#0d1117] font-mono text-[#c9d1d9]">
      <header className="flex flex-col gap-3 border-b border-[#30363d] bg-[#161b22] px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-base font-semibold tracking-[0.18em] text-[#58a6ff]">
            TRAGEDY INSPECTOR
          </h1>
          <p className="mt-1 text-[11px] text-[#8b949e]">
            Technical diagnostics for one live game: event timeline, published reasoning, raw state,
            and runtime health.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-[#8b949e]">
          <span>
            Events: <strong className="text-[#c9d1d9]">{events.length}</strong>
          </span>
          <span>
            Agents: <strong className="text-[#c9d1d9]">{players.length}</strong>
          </span>
          <span>
            Round: <strong className="text-[#c9d1d9]">{currentRound}</strong>
          </span>
          <span className="rounded-full bg-[#3fb950] px-2 py-0.5 text-[10px] font-bold text-[#0d1117]">
            {String(phase).toUpperCase()}
          </span>
        </div>
      </header>

      <section className="flex max-w-full flex-col gap-2 overflow-x-hidden border-b border-[#30363d] bg-[#161b22] px-5 py-2 lg:flex-row lg:items-center">
        <button
          type="button"
          className="rounded-md border border-[#3fb950] px-3 py-1 text-xs text-[#3fb950] opacity-50"
          disabled
        >
          Resume
        </button>
        <button
          type="button"
          className="rounded-md border border-[#f85149] px-3 py-1 text-xs text-[#f85149] opacity-50"
          disabled
        >
          Pause
        </button>
        <button
          className="rounded-md border border-[#30363d] bg-[#21262d] px-3 py-1 text-xs transition hover:border-[#58a6ff] hover:text-[#58a6ff]"
          type="button"
          onClick={() => setSelectedEvent(null)}
        >
          Clear selected event
        </button>
        <button
          className="rounded-md border border-[#30363d] bg-[#21262d] px-3 py-1 text-xs transition hover:border-[#58a6ff] hover:text-[#58a6ff]"
          type="button"
          onClick={() => void loadInspect()}
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
        <button
          className={`rounded-md border px-3 py-1 text-xs transition ${
            autoRefresh
              ? 'border-[#3fb950] bg-[#3fb950] text-[#0d1117]'
              : 'border-[#30363d] bg-[#21262d] hover:border-[#58a6ff] hover:text-[#58a6ff]'
          }`}
          type="button"
          onClick={() => setAutoRefresh((value) => !value)}
        >
          {autoRefresh ? 'Polling on' : 'Polling off'}
        </button>
        <Link
          to={`/game/${encodeURIComponent(resolvedGameId)}`}
          className="rounded-md border border-[#30363d] bg-[#21262d] px-3 py-1 text-xs transition hover:border-[#58a6ff] hover:text-[#58a6ff]"
        >
          Spectator
        </Link>
        <div className="flex-1" />
        <form
          className="flex min-w-0 items-center gap-2 text-xs lg:w-[31rem] lg:max-w-[38vw]"
          onSubmit={(event) => {
            event.preventDefault();
            const key = draftKey.trim();
            window.localStorage.setItem(INSPECTOR_KEY_STORAGE_KEY, key);
            setInspectorKey(key);
          }}
        >
          <label
            htmlFor="inspector-key"
            className="text-[10px] uppercase tracking-[0.16em] text-[#8b949e]"
          >
            Inspector key
          </label>
          <input
            id="inspector-key"
            type="password"
            value={draftKey}
            onChange={(event) => setDraftKey(event.target.value)}
            placeholder="local access key"
            className="min-w-0 flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1 text-xs text-[#c9d1d9] outline-none focus:border-[#58a6ff]"
          />
          <button
            className="rounded-md border border-[#30363d] px-2 py-1 hover:border-[#58a6ff]"
            type="submit"
          >
            Save
          </button>
        </form>
      </section>

      {error && (
        <div className="border-b border-[#f85149] bg-[#2d1214] px-5 py-2 text-xs text-[#ffb4ac]">
          {error}
        </div>
      )}
      {inspectError && (
        <div className="border-b border-[#d29922] bg-[#2d2412] px-5 py-2 text-xs text-[#f1c56f]">
          Inspect endpoint returned: {inspectError.error}
        </div>
      )}

      <main className="grid min-h-0 grid-cols-1 overflow-hidden lg:h-[calc(100%-8.9rem)] lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_minmax(18rem,24rem)]">
        <aside className="min-w-0 overflow-y-auto border-r border-[#30363d] bg-[#161b22]">
          <section className="border-b border-[#30363d] p-3">
            <h2 className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[#8b949e]">Agents</h2>
            {players.length === 0 ? (
              <EmptyState>Waiting for game...</EmptyState>
            ) : (
              <div className="grid gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedAgentId(null);
                    setActiveTab('agent');
                  }}
                  className={`rounded-md border p-2 text-left transition ${
                    selectedAgentId === null
                      ? 'border-[#58a6ff] bg-[rgba(88,166,255,0.1)]'
                      : 'border-[#30363d] hover:border-[#58a6ff]'
                  }`}
                >
                  <div className="font-semibold text-[#c9d1d9]">All agents</div>
                  <div className="mt-1 text-[11px] text-[#8b949e]">
                    Full table · {players.length} agents · {allAgentReasoning.length} published
                    notes
                  </div>
                </button>
                {players.map((player) => (
                  <button
                    key={player.id}
                    type="button"
                    onClick={() => {
                      setSelectedAgentId(player.id);
                      setActiveTab('agent');
                    }}
                    className={`rounded-md border p-2 text-left transition ${
                      selectedAgent?.id === player.id
                        ? 'border-[#58a6ff] bg-[rgba(88,166,255,0.1)]'
                        : 'border-[#30363d] hover:border-[#58a6ff]'
                    }`}
                  >
                    <div className="font-semibold text-[#c9d1d9]">
                      {displayAgentName(player.id, handles)}
                    </div>
                    <div className="mt-1 text-[11px] text-[#8b949e]">
                      VP {player.vp ?? 0} · Influence {player.influence ?? 0} ·{' '}
                      {summarizeAction(submittedActions[player.id])}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="border-b border-[#30363d] p-3">
            <h2 className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[#8b949e]">
              Game Info
            </h2>
            <dl className="grid gap-2 text-xs">
              <div>
                <dt className="text-[#8b949e]">Game</dt>
                <dd className="break-all text-[#c9d1d9]">{gameType}</dd>
              </div>
              <div>
                <dt className="text-[#8b949e]">Session</dt>
                <dd className="break-all text-[#c9d1d9]">{resolvedGameId || '—'}</dd>
              </div>
              <div>
                <dt className="text-[#8b949e]">Last read</dt>
                <dd className="text-[#c9d1d9]">{formatTime(inspect?.now)}</dd>
              </div>
            </dl>
          </section>
        </aside>

        <section className="min-w-0 overflow-y-auto bg-[#0d1117] p-4">
          <nav className="mb-3 flex min-w-0 border-b border-[#30363d]">
            {(['events', 'agent', 'replay'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-xs capitalize transition ${
                  activeTab === tab
                    ? 'border-b-2 border-[#58a6ff] text-[#58a6ff]'
                    : 'text-[#8b949e] hover:text-[#c9d1d9]'
                }`}
              >
                {tab === 'agent' ? 'Agent Detail' : tab}
              </button>
            ))}
          </nav>

          {activeTab === 'events' && (
            <div>
              <div className="mb-3 flex min-w-0 flex-wrap gap-2">
                {(['all', 'game', 'chat', 'reasoning', 'trust', 'crisis', 'action'] as const).map(
                  (item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setFilter(item)}
                      className={`rounded-full border px-3 py-1 text-[11px] capitalize ${
                        filter === item
                          ? 'border-[#58a6ff] bg-[#58a6ff] text-[#0d1117]'
                          : 'border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9]'
                      }`}
                    >
                      {item}
                    </button>
                  ),
                )}
              </div>
              <div className="grid min-w-0 gap-1">
                {filteredEvents.length === 0 ? (
                  <EmptyState>No matching events yet.</EmptyState>
                ) : (
                  filteredEvents.map((event) => {
                    const expanded = expandedEventIds.has(event.id);
                    return (
                      <article
                        key={event.id}
                        className={`min-w-0 border-l-4 ${eventAccent(event.category)} rounded-r bg-[#161b22] text-xs transition ${
                          expanded ? 'bg-[#21262d]' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleEventExpansion(event)}
                          aria-expanded={expanded}
                          className="flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left transition hover:bg-[#21262d]"
                        >
                          <span className="shrink-0 text-[10px] text-[#8b949e]">
                            {expanded ? '▾' : '▸'} {formatTime(event.timestamp)}
                          </span>
                          <span className="shrink-0 font-semibold text-[#c9d1d9]">
                            {eventTypeLabel(event.type)}
                          </span>
                          <span className="min-w-0 flex-1 break-words text-[#8b949e]">
                            {event.summary}
                          </span>
                        </button>
                        {expanded && (
                          <div className="border-t border-[#30363d] px-3 py-2 text-[11px] text-[#8b949e]">
                            Raw payload is selected in the right rail for inspection.
                          </div>
                        )}
                      </article>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {activeTab === 'agent' && (
            <div>
              {selectedAgentId === null ? (
                <div className="grid gap-4">
                  <section className="grid gap-3 xl:grid-cols-3">
                    <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-3">
                      <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-[#8b949e]">
                        Visible Agents
                      </div>
                      <div className="grid gap-2">
                        {players.length === 0 ? (
                          <EmptyState>No agent identities registered.</EmptyState>
                        ) : (
                          players.slice(0, 6).map((player) => (
                            <article
                              key={`identity-${player.id}`}
                              className="rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-xs"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <div className="font-semibold text-[#c9d1d9]">
                                    {displayAgentName(player.id, handles)}
                                  </div>
                                  <div className="mt-1 font-mono text-[11px] text-[#8b949e]">
                                    ID: {shortId(player.id)}
                                  </div>
                                </div>
                                <span className="rounded-full border border-[#30363d] bg-[#21262d] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[#58a6ff]">
                                  visible
                                </span>
                              </div>
                              <div className="mt-2 text-[11px] text-[#8b949e]">
                                Human label first; raw ID stays available for debugging.
                              </div>
                            </article>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-3">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="text-[11px] uppercase tracking-[0.14em] text-[#8b949e]">
                          Visible Standing
                        </div>
                        <span className="font-mono text-[10px] text-[#8b949e]">
                          {players.length} visible
                        </span>
                      </div>
                      <div className="grid gap-2">
                        {players.length === 0 ? (
                          <EmptyState>No attestation data available.</EmptyState>
                        ) : (
                          players
                            .slice()
                            .sort((left, right) => (right.vp ?? 0) - (left.vp ?? 0))
                            .slice(0, 6)
                            .map((player, index) => (
                              <article
                                key={`attestation-${player.id}`}
                                className="rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-xs"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="break-all font-semibold text-[#c9d1d9]">
                                    {displayAgentName(player.id, handles)}
                                  </span>
                                  <span className="rounded-full border border-[#d29922] bg-[rgba(210,153,34,0.12)] px-2 py-0.5 text-[10px] text-[#d29922]">
                                    #{index + 1}
                                  </span>
                                </div>
                                <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-[#8b949e]">
                                  <span>
                                    Score{' '}
                                    <strong className="text-[#c9d1d9]">{player.vp ?? 0}</strong>
                                  </span>
                                  <span>
                                    Influence{' '}
                                    <strong className="text-[#c9d1d9]">
                                      {player.influence ?? 0}
                                    </strong>
                                  </span>
                                  <span>{summarizeAction(submittedActions[player.id])}</span>
                                </div>
                              </article>
                            ))
                        )}
                      </div>
                    </div>

                    <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-3">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="text-[11px] uppercase tracking-[0.14em] text-[#8b949e]">
                          Board Presence
                        </div>
                        <span className="font-mono text-[10px] text-[#8b949e]">
                          {players.length}/{players.length} active
                        </span>
                      </div>
                      <div className="grid gap-2">
                        {players.length === 0 ? (
                          <EmptyState>No participation data available.</EmptyState>
                        ) : (
                          players.slice(0, 6).map((player) => (
                            <article
                              key={`participation-${player.id}`}
                              className="rounded-md border border-[#30363d] bg-[#0d1117] p-3 text-xs"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="truncate font-semibold text-[#c9d1d9]">
                                    {displayAgentName(player.id, handles)}
                                  </div>
                                  <div className="mt-1 text-[11px] text-[#8b949e]">
                                    Resources {resourceTotal(player.resources)} · Regions{' '}
                                    {(player.regionsControlled ?? []).length}
                                  </div>
                                </div>
                                <span className="rounded-full bg-[rgba(63,185,80,0.16)] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[#7ee787]">
                                  active
                                </span>
                              </div>
                            </article>
                          ))
                        )}
                      </div>
                    </div>
                  </section>

                  <div>
                    <h2 className="mb-3 text-lg font-semibold text-[#c9d1d9]">All agents</h2>
                    <div className="grid min-w-0 gap-2 md:grid-cols-2">
                      {players.map((player) => (
                        <button
                          key={player.id}
                          type="button"
                          onClick={() => setSelectedAgentId(player.id)}
                          className="rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-left transition hover:border-[#58a6ff]"
                        >
                          <div className="font-semibold text-[#c9d1d9]">
                            {displayAgentName(player.id, handles)}
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-[#8b949e]">
                            <span>
                              Score <strong className="text-[#c9d1d9]">{player.vp ?? 0}</strong>
                            </span>
                            <span>
                              INF{' '}
                              <strong className="text-[#c9d1d9]">{player.influence ?? 0}</strong>
                            </span>
                            <span>{summarizeAction(submittedActions[player.id])}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-xs text-[#8b949e]">
                    Full reasoning is available in Events → Reasoning.
                  </section>
                </div>
              ) : !selectedAgent ? (
                <EmptyState>Select an agent from the sidebar.</EmptyState>
              ) : (
                <div className="grid gap-4">
                  <div>
                    <h2 className="mb-3 text-lg font-semibold text-[#c9d1d9]">
                      {displayAgentName(selectedAgent.id, handles)}
                    </h2>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      {Object.entries(selectedAgent.resources ?? {}).map(([name, value]) => (
                        <div
                          key={name}
                          className="rounded border border-[#30363d] bg-[#161b22] p-2 text-center"
                        >
                          <div className="text-[10px] capitalize text-[#8b949e]">{name}</div>
                          <div className="text-lg font-bold text-[#c9d1d9]">{value ?? 0}</div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-[#8b949e]">
                      VP <strong className="text-[#c9d1d9]">{selectedAgent.vp ?? 0}</strong> ·
                      Influence{' '}
                      <strong className="text-[#c9d1d9]">{selectedAgent.influence ?? 0}</strong> ·
                      Regions{' '}
                      <strong className="text-[#c9d1d9]">
                        {(selectedAgent.regionsControlled ?? []).join(', ') || 'none'}
                      </strong>
                    </p>
                  </div>

                  <section className="rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-xs text-[#8b949e]">
                    Full reasoning is available in Events → Reasoning.
                  </section>

                  <section>
                    <h3 className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[#8b949e]">
                      Submitted action
                    </h3>
                    <JsonViewer value={submittedActions[selectedAgent.id] ?? null} />
                  </section>
                </div>
              )}
            </div>
          )}

          {activeTab === 'replay' && (
            <div className="grid gap-4">
              <div className="rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-xs text-[#8b949e]">
                Replay snapshots available:{' '}
                <strong className="text-[#c9d1d9]">{diagnostics?.snapshotCount ?? 0}</strong>
              </div>
              <JsonViewer value={diagnostics?.progress ?? null} />
            </div>
          )}
        </section>

        <aside className="min-w-0 overflow-y-auto border-l border-[#30363d] bg-[#161b22] p-3">
          <JsonSection title="State inspector" value={gameState ?? null} open />

          <JsonSection
            title="Ecosystems raw state"
            value={ecosystems.length === 0 ? { message: 'No ecosystem data' } : ecosystems}
          />

          <JsonSection
            title="Selected event"
            value={selectedEvent ?? { message: 'Click an event to inspect' }}
            open={Boolean(selectedEvent)}
          />

          <JsonSection
            title="Runtime diagnostics"
            value={{
              meta: diagnostics?.meta ?? null,
              progress: diagnostics?.progress ?? null,
              actionLogLength: diagnostics?.actionLogLength ?? 0,
              snapshotCount: diagnostics?.snapshotCount ?? 0,
              alarm: diagnostics?.alarm ?? null,
              websockets: diagnostics?.websockets ?? 0,
              pluginProgress: diagnostics?.pluginProgress ?? null,
            }}
          />
        </aside>
      </main>
    </div>
  );
}
