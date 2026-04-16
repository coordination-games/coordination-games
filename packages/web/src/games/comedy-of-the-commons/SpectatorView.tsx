import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpectatorViewProps } from '../types';
import { API_BASE, getWsUrl } from '../../config.js';

interface ComedyPlayer {
  id: string;
  vp: number;
  influence: number;
  totalResources: number;
  resources: Record<string, number>;
  regionsControlled: string[];
}

interface ComedyEcosystem {
  id: string;
  name: string;
  resource: string;
  health: number;
  maxHealth: number;
  status: 'flourishing' | 'stable' | 'strained' | 'collapsed';
}

interface ComedySpectatorState {
  round: number;
  maxRounds: number;
  phase: 'waiting' | 'playing' | 'finished';
  winner: string | null;
  players: ComedyPlayer[];
  ecosystems: ComedyEcosystem[];
  activeTrades: Array<{ to: string; give: Record<string, number>; receive: Record<string, number> }>;
}

function mapServerState(raw: any): ComedySpectatorState | null {
  const data = raw?.data ?? raw;
  if (!data?.players || !Array.isArray(data.players) || !Array.isArray(data.ecosystems)) return null;
  return {
    round: data.round ?? 0,
    maxRounds: data.maxRounds ?? data.config?.maxRounds ?? 12,
    phase: data.phase ?? 'waiting',
    winner: data.winner ?? null,
    players: data.players,
    ecosystems: data.ecosystems,
    activeTrades: data.activeTrades ?? [],
  };
}

function statusColor(status: ComedyEcosystem['status']): string {
  switch (status) {
    case 'flourishing': return '#7bd88f';
    case 'strained': return '#f6c177';
    case 'collapsed': return '#ef6b73';
    default: return '#8ecae6';
  }
}

export function ComedySpectatorView(props: SpectatorViewProps) {
  const { gameId, handles, chatMessages } = props;
  const [state, setState] = useState<ComedySpectatorState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!gameId) return;

    fetch(`${API_BASE}/games/${gameId}`)
      .then((r) => r.json())
      .then((data) => {
        const mapped = mapServerState(data);
        if (mapped) setState(mapped);
      })
      .catch(() => setError('Failed to load Comedy game state'));

    const ws = new WebSocket(getWsUrl(`/ws/game/${gameId}`));
    wsRef.current = ws;
    ws.onopen = () => { setConnected(true); setError(null); };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setError('WebSocket error');
    ws.onmessage = (event) => {
      try {
        const mapped = mapServerState(JSON.parse(event.data));
        if (mapped) setState(mapped);
      } catch {
        // Ignore malformed spectator updates.
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [gameId]);

  const sortedPlayers = useMemo(
    () => [...(state?.players ?? [])].sort((a, b) => (b.vp - a.vp) || (b.influence - a.influence)),
    [state?.players],
  );

  if (!state) {
    return (
      <div className="flex h-[calc(100vh-5rem)] items-center justify-center px-6 text-center">
        <div>
          <div className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-emerald-300">Comedy of the Commons</div>
          <p className="text-sm text-slate-300">{error ?? (connected ? 'Waiting for game state…' : 'Connecting…')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-5rem)] bg-slate-950 px-6 py-6 text-slate-100">
      <div className="mx-auto grid max-w-7xl gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-2xl border border-emerald-500/20 bg-slate-900/80 p-5 shadow-xl">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-emerald-200">Comedy of the Commons</h1>
              <p className="text-sm text-slate-400">Round {state.round}/{state.maxRounds} · {state.phase}</p>
            </div>
            <div className="rounded-full border border-emerald-500/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-emerald-300">
              {state.winner ? `Leader: ${handles[state.winner] ?? state.winner}` : 'Live commons race'}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {sortedPlayers.map((player) => {
              const name = handles[player.id] ?? player.id;
              return (
                <article key={player.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <h2 className="font-medium text-emerald-100">{name}</h2>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{player.regionsControlled.length} regions · {player.totalResources} resources</p>
                    </div>
                    <div className="text-right text-xs text-slate-300">
                      <div>VP {player.vp}</div>
                      <div>Inf {player.influence}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs text-slate-300">
                    {Object.entries(player.resources).map(([resource, amount]) => (
                      <div key={resource} className="rounded-lg bg-slate-900/80 px-2 py-1">
                        <div className="uppercase tracking-[0.12em] text-slate-500">{resource}</div>
                        <div className="font-medium text-slate-100">{amount}</div>
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <aside className="space-y-6">
          <section className="rounded-2xl border border-sky-500/20 bg-slate-900/80 p-5 shadow-xl">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-sky-300">Ecosystems</h2>
            <div className="space-y-3">
              {state.ecosystems.map((ecosystem) => {
                const pct = Math.max(0, Math.min(100, Math.round((ecosystem.health / ecosystem.maxHealth) * 100)));
                return (
                  <div key={ecosystem.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium text-slate-100">{ecosystem.name}</span>
                      <span className="text-xs uppercase tracking-[0.18em]" style={{ color: statusColor(ecosystem.status) }}>{ecosystem.status}</span>
                    </div>
                    <div className="mb-2 h-2 rounded-full bg-slate-800">
                      <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: statusColor(ecosystem.status) }} />
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>{ecosystem.resource}</span>
                      <span>{ecosystem.health}/{ecosystem.maxHealth}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-amber-500/20 bg-slate-900/80 p-5 shadow-xl">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">Active trades</h2>
            {state.activeTrades.length === 0 ? (
              <p className="text-sm text-slate-400">No reciprocal trades settled this round.</p>
            ) : (
              <div className="space-y-2 text-sm text-slate-300">
                {state.activeTrades.map((trade, index) => (
                  <div key={`${trade.to}-${index}`} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <div className="text-xs uppercase tracking-[0.14em] text-slate-500">to {handles[trade.to] ?? trade.to}</div>
                    <div>Give {JSON.stringify(trade.give)} · Receive {JSON.stringify(trade.receive)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-violet-500/20 bg-slate-900/80 p-5 shadow-xl">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-violet-300">Public chat</h2>
            <div className="space-y-2 text-sm text-slate-300">
              {chatMessages.length === 0 ? (
                <p className="text-slate-400">No public messages yet.</p>
              ) : (
                chatMessages.slice(-8).map((message, index) => (
                  <div key={`${message.timestamp}-${index}`} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                    <div className="mb-1 text-xs uppercase tracking-[0.14em] text-slate-500">{handles[message.from] ?? message.from}</div>
                    <div>{message.message}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
