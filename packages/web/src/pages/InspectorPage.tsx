import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { InspectError, InspectGameDiagnostics, InspectResponse } from '../api';
import { fetchInspect } from '../api';

const TOKEN_STORAGE_KEY = 'coordination-games.admin-token';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInspectError(value: unknown): value is InspectError {
  return isRecord(value) && typeof value.error === 'string';
}

function isGameDiagnostics(value: unknown): value is InspectGameDiagnostics {
  return isRecord(value) && typeof value.now === 'number' && 'gameState' in value;
}

function formatTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDelta(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : '';
  if (Math.abs(value) >= 1000) return `${sign}${(value / 1000).toFixed(1)}s`;
  return `${sign}${value}ms`;
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function metricValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

interface MetricCardProps {
  label: string;
  value: string | number | boolean | null | undefined;
  tone?: 'mint' | 'amber' | 'graphite';
}

function MetricCard({ label, value, tone = 'graphite' }: MetricCardProps) {
  const toneClass =
    tone === 'mint'
      ? 'text-[var(--color-mint-deep)]'
      : tone === 'amber'
        ? 'text-[#9a6a14]'
        : 'text-[var(--color-warm-black)]';
  return (
    <div className="rounded-2xl border border-[rgba(28,26,23,0.1)] bg-white/70 p-4 shadow-sm">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-ash)]">
        {label}
      </div>
      <div className={`mt-2 font-display text-2xl tracking-tight ${toneClass}`}>
        {metricValue(value)}
      </div>
    </div>
  );
}

interface JsonPanelProps {
  title: string;
  value: unknown;
  defaultOpen?: boolean;
}

function JsonPanel({ title, value, defaultOpen = false }: JsonPanelProps) {
  return (
    <details
      open={defaultOpen}
      className="rounded-2xl border border-[rgba(28,26,23,0.12)] bg-[rgba(255,252,244,0.86)] shadow-sm"
    >
      <summary className="cursor-pointer select-none px-4 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-graphite)]">
        {title}
      </summary>
      <pre className="max-h-[26rem] overflow-auto border-t border-[rgba(28,26,23,0.08)] bg-[rgba(11,18,23,0.94)] p-4 text-[11px] leading-relaxed text-[#d7efe6]">
        {stringify(value)}
      </pre>
    </details>
  );
}

function StatusPill({ children }: { children: string }) {
  return (
    <span className="inline-flex rounded-full border border-[rgba(2,226,172,0.28)] bg-[rgba(2,226,172,0.12)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-mint-deep)]">
      {children}
    </span>
  );
}

export default function InspectorPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const [adminToken, setAdminToken] = useState('');
  const [draftToken, setDraftToken] = useState('');
  const [inspect, setInspect] = useState<InspectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
    setAdminToken(stored);
    setDraftToken(stored);
  }, []);

  const loadInspect = useCallback(async () => {
    if (!gameId) return;
    if (!adminToken.trim()) {
      setError('Admin token required. Paste ADMIN_TOKEN to inspect privileged runtime state.');
      setInspect(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchInspect(gameId, adminToken.trim());
      setInspect(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inspector data');
    } finally {
      setLoading(false);
    }
  }, [adminToken, gameId]);

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

  const gameType = inspect?.gameRow?.game_type ?? inspect?.lobby?.game_type ?? 'unknown';
  const resolvedGameId =
    inspect?.gameId ?? inspect?.gameRow?.game_id ?? inspect?.lobby?.game_id ?? gameId;

  return (
    <div className="min-h-[calc(100vh-5rem)] -mx-4 -my-6 bg-[radial-gradient(circle_at_top_left,rgba(2,226,172,0.15),transparent_32rem),linear-gradient(135deg,#fffaf0,#efe9dc)] px-4 py-6 sm:-mx-6 sm:-my-10 sm:px-6 sm:py-8">
      <div className="mx-auto flex max-w-[92rem] flex-col gap-6">
        <header className="rounded-[2rem] border border-[rgba(28,26,23,0.1)] bg-[rgba(255,252,244,0.82)] p-5 shadow-sm backdrop-blur sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <StatusPill>private inspector</StatusPill>
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-ash)]">
                  backend / research / operator
                </span>
              </div>
              <h1 className="font-display text-4xl tracking-tight text-[var(--color-warm-black)] sm:text-5xl">
                Inspector View
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-graphite)]">
                Privileged diagnostics for a live session. This route reads the admin inspect
                endpoint directly; it does not expand spectator payloads or add game-plugin
                responsibilities.
              </p>
            </div>

            <form
              className="flex w-full flex-col gap-2 rounded-2xl border border-[rgba(28,26,23,0.1)] bg-white/65 p-3 lg:max-w-xl"
              onSubmit={(event) => {
                event.preventDefault();
                const token = draftToken.trim();
                window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
                setAdminToken(token);
              }}
            >
              <label
                htmlFor="admin-token"
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-ash)]"
              >
                Admin token
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="admin-token"
                  type="password"
                  value={draftToken}
                  onChange={(event) => setDraftToken(event.target.value)}
                  placeholder="Paste ADMIN_TOKEN"
                  className="min-w-0 flex-1 rounded-xl border border-[rgba(28,26,23,0.16)] bg-white px-3 py-2 font-mono text-xs text-[var(--color-warm-black)] outline-none transition focus:border-[var(--color-mint-deep)]"
                />
                <button
                  type="submit"
                  className="rounded-xl bg-[var(--color-warm-black)] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white transition hover:bg-[var(--color-mint-deep)]"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="session" value={inspect?.sessionId ?? gameId} />
          <MetricCard label="game type" value={gameType} tone="mint" />
          <MetricCard label="phase" value={inspect?.lobby?.phase ?? 'direct game'} />
          <MetricCard label="finished" value={inspect?.gameRow?.finished ?? diagnostics?.isOver} />
          <MetricCard
            label="last read"
            value={inspect ? formatTime(inspect.now) : '—'}
            tone="amber"
          />
        </section>

        <div className="flex flex-col gap-3 rounded-2xl border border-[rgba(28,26,23,0.1)] bg-[rgba(255,252,244,0.82)] p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-graphite)]">
            inspecting <span className="text-[var(--color-mint-deep)]">{resolvedGameId}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/game/${encodeURIComponent(resolvedGameId ?? '')}`}
              className="rounded-xl border border-[rgba(28,26,23,0.14)] bg-white/70 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-graphite)] transition hover:border-[var(--color-mint-deep)] hover:text-[var(--color-mint-deep)]"
            >
              Spectator
            </Link>
            <button
              type="button"
              onClick={() => setAutoRefresh((value) => !value)}
              className={`rounded-xl border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] transition ${
                autoRefresh
                  ? 'border-[rgba(2,226,172,0.5)] bg-[rgba(2,226,172,0.16)] text-[var(--color-mint-deep)]'
                  : 'border-[rgba(28,26,23,0.14)] bg-white/70 text-[var(--color-graphite)] hover:border-[var(--color-mint-deep)]'
              }`}
            >
              {autoRefresh ? 'Polling on' : 'Polling off'}
            </button>
            <button
              type="button"
              onClick={() => void loadInspect()}
              className="rounded-xl bg-[var(--color-mint-deep)] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white transition hover:bg-[var(--color-warm-black)] disabled:opacity-50"
              disabled={loading}
            >
              {loading ? 'Refreshing' : 'Refresh'}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {inspectError && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Inspect endpoint returned: {inspectError.error}
          </div>
        )}

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="actions" value={diagnostics?.actionLogLength} />
          <MetricCard label="snapshots" value={diagnostics?.snapshotCount} />
          <MetricCard label="websockets" value={diagnostics?.websockets} />
          <MetricCard label="plugin progress" value={diagnostics?.pluginProgress} />
          <MetricCard
            label="alarm delta"
            value={formatDelta(diagnostics?.alarm.slotDelta)}
            tone="amber"
          />
        </section>

        {diagnostics?.alarm.queue && diagnostics.alarm.queue.length > 0 && (
          <section className="rounded-2xl border border-[rgba(28,26,23,0.1)] bg-white/70 p-4 shadow-sm">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-graphite)]">
              Alarm queue
            </h2>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {diagnostics.alarm.queue.map((entry) => (
                <div
                  key={`${String(entry.slot ?? 'slot')}-${entry.deltaMs}`}
                  className="rounded-xl border border-[rgba(28,26,23,0.08)] bg-[rgba(255,252,244,0.78)] p-3 font-mono text-xs text-[var(--color-graphite)]"
                >
                  <div>delta: {formatDelta(entry.deltaMs)}</div>
                  <div className="mt-1 text-[var(--color-ash)]">{stringify(entry)}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="grid gap-4 xl:grid-cols-2">
          <JsonPanel title="lobby row" value={inspect?.lobby} />
          <JsonPanel title="game row" value={inspect?.gameRow} />
          <JsonPanel title="runtime meta" value={diagnostics?.meta} defaultOpen />
          <JsonPanel title="progress" value={diagnostics?.progress} />
          <JsonPanel title="raw game state" value={diagnostics?.gameState} defaultOpen />
          <JsonPanel title="full inspect response" value={inspect} />
        </section>
      </div>
    </div>
  );
}
