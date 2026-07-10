import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, fmtWinner, JsonBlock, Section, StatusPill } from '../components/ui';
import type { AnalysisReport, RunInfo, TranscriptEvent } from '../types';

type Tab = 'overview' | 'analysis' | 'transcripts' | 'relay';

const EVENT_KINDS = ['all', 'model_response', 'tool_call', 'tool_result', 'session'] as const;

function personaName(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1] ?? ref;
}

export function RunPage() {
  const { campaignId = '', runId = '' } = useParams();
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => {
    api
      .run(campaignId, runId)
      .then(setInfo)
      .catch((err: Error) => setError(err.message));
  }, [campaignId, runId]);

  if (error) return <ErrorNote error={error} />;
  if (!info) return <Empty>loading…</Empty>;

  const tabs: Tab[] = ['overview', 'analysis', 'transcripts', 'relay'];

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Link to="/lab" className="font-mono text-xs" style={{ color: 'var(--ink-dim)' }}>
          ← lab
        </Link>
        <span className="font-display font-semibold">
          {campaignId} / {runId}
        </span>
        {info.manifest ? <StatusPill status="ok" /> : <StatusPill status="running" />}
      </div>

      <div className="flex gap-1 mb-4">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            className="btn"
            style={tab === t ? { borderColor: 'var(--mint)', color: 'var(--mint)' } : undefined}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview info={info} />}
      {tab === 'analysis' && (
        <Analysis campaignId={campaignId} runId={runId} hasAnalysis={info.hasAnalysis} />
      )}
      {tab === 'transcripts' && (
        <Transcripts campaignId={campaignId} runId={runId} bots={info.bots} />
      )}
      {tab === 'relay' && <Relay campaignId={campaignId} runId={runId} hasRelay={info.hasRelay} />}
    </div>
  );
}

// --- overview ------------------------------------------------------------------

function Overview({ info }: { info: RunInfo }) {
  const m = info.manifest;
  if (!m) return <Empty>manifest.json not written yet — this run is still in flight.</Empty>;
  return (
    <div>
      {info.hasAnalysis && <JudgeTeaser campaignId={info.campaignId} runId={info.runId} />}
      <Section title="outcome" right={m.gameId ? <WatchReplayLink gameId={m.gameId} /> : undefined}>
        <div className="flex gap-6 flex-wrap font-mono text-sm mb-3">
          <div>
            <div className="label">winner</div>
            <div style={{ color: 'var(--mint)' }}>{fmtWinner(m.outcome?.winnerLabel)}</div>
          </div>
          <div>
            <div className="label">phase</div>
            <div>{m.outcome?.phase ?? '?'}</div>
          </div>
          <div>
            <div className="label">round</div>
            <div>{m.outcome?.round ?? '?'}</div>
          </div>
          <div>
            <div className="label">status</div>
            <div>{m.outcome?.statusVariant ?? '—'}</div>
          </div>
          <div>
            <div className="label">game id</div>
            <div>{m.gameId ?? '—'}</div>
          </div>
        </div>
        <JsonBlock value={m.outcome} />
      </Section>

      <Section title="seats">
        <table className="w-full text-sm">
          <thead>
            <tr className="label text-left">
              <th className="py-1 pr-4 font-normal">bot</th>
              <th className="py-1 pr-4 font-normal">persona</th>
              <th className="py-1 pr-4 font-normal">model</th>
              <th className="py-1 pr-4 font-normal">backend</th>
              <th className="py-1 pr-4 font-normal">consequential</th>
              <th className="py-1 pr-4 font-normal">talk-only</th>
              <th className="py-1 pr-4 font-normal">finished</th>
              <th className="py-1 pr-4 font-normal">reason</th>
            </tr>
          </thead>
          <tbody>
            {m.perBot.map((b) => (
              <tr
                key={b.bot}
                className="border-t font-mono text-xs"
                style={{ borderColor: 'var(--line)' }}
              >
                <td className="py-2 pr-4">{b.bot}</td>
                <td className="py-2 pr-4">{personaName(b.persona)}</td>
                <td className="py-2 pr-4">{b.model}</td>
                <td className="py-2 pr-4">{b.backend}</td>
                <td className="py-2 pr-4">{b.consequentialTurns}</td>
                <td className="py-2 pr-4">{b.talkOnlyTurns}</td>
                <td className="py-2 pr-4">{b.finished ? '✓' : '—'}</td>
                <td className="py-2 pr-4">{b.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="label mt-2">
          model-call counts are not comparable across backends — compare consequential turns.
        </p>
      </Section>

      <Section title="spec">
        <JsonBlock value={m.spec} />
      </Section>
    </div>
  );
}

/**
 * Link to the spectator UI's replay for this run's game.
 *
 * Only available once the manifest is written (finished runs) — the console
 * has no other source for gameId while a run is in flight. Assumes
 * `packages/web` is being served via `npm run build:local && npm run preview`
 * (see the spectator card on the settings page).
 */
function WatchReplayLink({ gameId }: { gameId: string }) {
  return (
    <a
      className="btn btn-primary"
      href={`http://${window.location.hostname}:4173/replay/${gameId}`}
      target="_blank"
      rel="noreferrer"
    >
      ▶ watch replay
    </a>
  );
}

/** The judge's verdict, front and center on the overview — summary + trust chips. */
function JudgeTeaser({ campaignId, runId }: { campaignId: string; runId: string }) {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  useEffect(() => {
    api
      .analysis(campaignId, runId)
      .then(setReport)
      .catch(() => setReport(null));
  }, [campaignId, runId]);
  if (!report) return null;
  const incidents =
    (report.betrayals?.length ?? 0) +
    (report.brokenPledges?.length ?? 0) +
    (report.deceptions?.length ?? 0);
  return (
    <Section title="judge verdict">
      {report.summary && <p className="text-sm leading-relaxed mb-3">{report.summary}</p>}
      <div className="flex gap-2 flex-wrap">
        <span
          className="font-mono text-[11px] px-2 py-0.5 rounded-full border"
          style={{
            color: incidents === 0 ? 'var(--mint)' : 'var(--hot)',
            borderColor: incidents === 0 ? 'var(--mint)' : 'var(--hot)',
          }}
        >
          {incidents === 0 ? 'no betrayals · no deceptions' : `${incidents} incident(s)`}
        </span>
        <span
          className="font-mono text-[11px] px-2 py-0.5 rounded-full border"
          style={{ color: 'var(--blue)', borderColor: 'var(--blue)' }}
        >
          {report.coordination?.length ?? 0} coordination pact(s)
        </span>
        {(report.perBot ?? []).map((b) => (
          <span
            key={b.bot}
            className="font-mono text-[11px] px-2 py-0.5 rounded-full border"
            style={{ color: 'var(--amber)', borderColor: 'var(--line)' }}
          >
            {b.bot} · trust {b.trustworthiness ?? '?'}/5
          </span>
        ))}
      </div>
    </Section>
  );
}

// --- analysis --------------------------------------------------------------------

function Analysis({
  campaignId,
  runId,
  hasAnalysis,
}: {
  campaignId: string;
  runId: string;
  hasAnalysis: boolean;
}) {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [relay, setRelay] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);

  useEffect(() => {
    if (!hasAnalysis) return;
    api
      .analysis(campaignId, runId)
      .then(setReport)
      .catch((err: Error) => setError(err.message));
  }, [campaignId, runId, hasAnalysis]);

  const loadRelay = useCallback(() => {
    if (relay) return;
    api
      .relay(campaignId, runId)
      .then((r) => setRelay(r.messages))
      .catch(() => setRelay([]));
  }, [campaignId, runId, relay]);

  if (!hasAnalysis) {
    return (
      <Section title="judge analysis">
        <Empty>
          No analysis.json for this run.
          <div className="mt-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={judging}
              onClick={() => {
                setJudging(true);
                api.analyze(campaignId, runId).catch((err: Error) => setError(err.message));
              }}
            >
              {judging ? 'judge launched — refresh in a minute' : 'run judge now'}
            </button>
          </div>
        </Empty>
        <ErrorNote error={error} />
      </Section>
    );
  }
  if (error) return <ErrorNote error={error} />;
  if (!report) return <Empty>loading analysis…</Empty>;

  return (
    <div>
      {report.summary && (
        <Section title="judge summary">
          <p className="text-sm leading-relaxed">{report.summary}</p>
        </Section>
      )}

      <IncidentList
        title={`betrayals (${report.betrayals?.length ?? 0})`}
        items={(report.betrayals ?? []).map((b) => ({
          head: `r${b.round ?? '?'} · ${b.actor ?? '?'} → ${b.victim ?? '?'} · severity ${b.severity ?? '?'}`,
          evidence: b.evidence ?? [],
        }))}
      />
      <IncidentList
        title={`broken pledges (${report.brokenPledges?.length ?? 0})`}
        items={(report.brokenPledges ?? []).map((p) => ({
          head: `r${p.round ?? '?'} · ${p.by ?? '?'}: “${p.pledge ?? ''}”`,
          evidence: p.evidence ?? [],
        }))}
      />
      <IncidentList
        title={`deceptions (${report.deceptions?.length ?? 0})`}
        items={(report.deceptions ?? []).map((d) => ({
          head: `${d.actor ?? '?'} claimed “${d.claim ?? ''}” — reality: ${d.reality ?? '?'}`,
          evidence: d.evidence ?? [],
        }))}
      />
      <IncidentList
        title={`coordination (${report.coordination?.length ?? 0})`}
        items={(report.coordination ?? []).map((c) => ({
          head: `${(c.participants ?? []).join(' + ')}: ${c.description ?? ''}${c.heldUntil ? ` (held until ${c.heldUntil})` : ''}`,
          evidence: [],
        }))}
        tone="good"
      />

      <Section title={`notable moments (${report.notableMoments?.length ?? 0})`}>
        {(report.notableMoments ?? []).length === 0 ? (
          <Empty>none recorded</Empty>
        ) : (
          (report.notableMoments ?? []).map((m, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: judge report is a read-only, append-ordered list
              key={`nm-${i}-${m.round ?? 0}`}
              className="py-2 border-t text-sm"
              style={{ borderColor: 'var(--line)' }}
            >
              <span className="font-mono text-xs" style={{ color: 'var(--amber)' }}>
                r{m.round ?? '?'}
              </span>{' '}
              {m.description}
              {(m.relayRefs ?? []).length > 0 && (
                <RelayRefs refs={m.relayRefs ?? []} relay={relay} loadRelay={loadRelay} />
              )}
            </div>
          ))
        )}
      </Section>

      <Section title="per-bot judgement">
        <table className="w-full text-sm">
          <thead>
            <tr className="label text-left">
              <th className="py-1 pr-4 font-normal">bot</th>
              <th className="py-1 pr-4 font-normal">model</th>
              <th className="py-1 pr-4 font-normal">style</th>
              <th className="py-1 pr-4 font-normal">trust (1–5)</th>
              <th className="py-1 pr-4 font-normal">notable</th>
            </tr>
          </thead>
          <tbody>
            {(report.perBot ?? []).map((b) => (
              <tr key={b.bot} className="border-t align-top" style={{ borderColor: 'var(--line)' }}>
                <td className="py-2 pr-4 font-mono text-xs">{b.bot}</td>
                <td className="py-2 pr-4 font-mono text-xs">{b.model}</td>
                <td className="py-2 pr-4 text-xs">{b.style}</td>
                <td className="py-2 pr-4 font-mono text-xs" style={{ color: 'var(--mint)' }}>
                  {b.trustworthiness ?? '—'}
                </td>
                <td className="py-2 pr-4 text-xs">{(b.notable ?? []).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

function IncidentList({
  title,
  items,
  tone = 'bad',
}: {
  title: string;
  items: { head: string; evidence: string[] }[];
  tone?: 'bad' | 'good';
}) {
  return (
    <Section title={title}>
      {items.length === 0 ? (
        <Empty>none found</Empty>
      ) : (
        items.map((item, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: judge report is a read-only, append-ordered list
            key={`i-${i}-${item.head.slice(0, 24)}`}
            className="py-2 border-t"
            style={{ borderColor: 'var(--line)' }}
          >
            <div
              className="text-sm font-medium"
              style={{ color: tone === 'bad' ? 'var(--hot)' : 'var(--mint)' }}
            >
              {item.head}
            </div>
            {item.evidence.map((ev, j) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: evidence quotes are read-only and ordered
                key={`e-${j}-${ev.slice(0, 24)}`}
                className="font-mono text-xs mt-1 pl-3"
                style={{ color: 'var(--ink-dim)' }}
              >
                “{ev}”
              </div>
            ))}
          </div>
        ))
      )}
    </Section>
  );
}

function RelayRefs({
  refs,
  relay,
  loadRelay,
}: {
  refs: number[];
  relay: unknown[] | null;
  loadRelay: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        className="btn"
        onClick={() => {
          setOpen(!open);
          loadRelay();
        }}
      >
        {open ? 'hide' : 'show'} evidence ({refs.join(', ')})
      </button>
      {open && (
        <div className="mt-2">
          {relay === null ? (
            <span className="label">loading relay…</span>
          ) : (
            refs.map((idx) => (
              <pre key={idx} className="terminal mt-1 max-h-40">
                #{idx} {JSON.stringify(relay[idx] ?? '(out of range)', null, 2)}
              </pre>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// --- transcripts -------------------------------------------------------------------

function Transcripts({
  campaignId,
  runId,
  bots,
}: {
  campaignId: string;
  runId: string;
  bots: string[];
}) {
  const [bot, setBot] = useState(bots[0] ?? '');
  const [kind, setKind] = useState<(typeof EVENT_KINDS)[number]>('all');
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bot) return;
    api
      .transcript(campaignId, runId, bot)
      .then((page) => setEvents(page.events))
      .catch((err: Error) => setError(err.message));
  }, [campaignId, runId, bot]);

  const filtered = useMemo(
    () => (kind === 'all' ? events : events.filter((e) => e.kind === kind)),
    [events, kind],
  );

  if (bots.length === 0) return <Empty>no transcripts written yet</Empty>;

  return (
    <div>
      <ErrorNote error={error} />
      <div className="flex gap-2 mb-3 flex-wrap">
        <select className="input max-w-60" value={bot} onChange={(e) => setBot(e.target.value)}>
          {bots.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        {EVENT_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className="btn"
            style={kind === k ? { borderColor: 'var(--mint)', color: 'var(--mint)' } : undefined}
            onClick={() => setKind(k)}
          >
            {k}
          </button>
        ))}
        <span className="label self-center">{filtered.length} events</span>
      </div>
      <div className="max-h-[60vh] overflow-auto">
        {filtered.map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: transcript is append-only; line order is its identity
          <EventRow key={`ev-${i}-${e.t}`} event={e} />
        ))}
      </div>
    </div>
  );
}

const KIND_COLORS: Record<string, string> = {
  model_request: 'var(--ink-dim)',
  model_response: 'var(--blue)',
  tool_call: 'var(--amber)',
  tool_result: 'var(--ink-dim)',
  session: 'var(--mint)',
};

function EventRow({ event }: { event: TranscriptEvent }) {
  const [open, setOpen] = useState(false);
  const color = KIND_COLORS[event.kind] ?? 'var(--ink)';
  const headline = (() => {
    if (event.kind === 'tool_call') return String(event.name ?? '');
    if (event.kind === 'tool_result') {
      return `${String(event.name ?? '')}${event.isError ? ' ✗ ERROR' : ''}`;
    }
    if (event.kind === 'model_response') {
      const text = typeof event.text === 'string' ? event.text : '';
      return text.slice(0, 160) || `${((event.toolCalls as unknown[]) ?? []).length} tool call(s)`;
    }
    if (event.kind === 'session')
      return `${String(event.event ?? '')} ${String(event.detail ?? '')}`;
    return '';
  })();

  return (
    <button
      type="button"
      className="block w-full text-left border-t py-1.5 font-mono text-xs cursor-pointer"
      style={{ borderColor: 'var(--line)' }}
      onClick={() => setOpen(!open)}
    >
      <span style={{ color, fontWeight: event.isError ? 700 : 400 }}>{event.kind}</span>{' '}
      <span style={{ color: event.isError ? 'var(--hot)' : 'var(--ink)' }}>{headline}</span>
      {open && <pre className="terminal mt-2 max-h-80">{JSON.stringify(event, null, 2)}</pre>}
    </button>
  );
}

// --- relay ---------------------------------------------------------------------------

function Relay({
  campaignId,
  runId,
  hasRelay,
}: {
  campaignId: string;
  runId: string;
  hasRelay: boolean;
}) {
  const [messages, setMessages] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasRelay) return;
    api
      .relay(campaignId, runId)
      .then((r) => setMessages(r.messages))
      .catch((err: Error) => setError(err.message));
  }, [campaignId, runId, hasRelay]);

  if (!hasRelay) return <Empty>no relay.jsonl for this run</Empty>;
  if (error) return <ErrorNote error={error} />;
  if (!messages) return <Empty>loading relay…</Empty>;

  return (
    <div className="max-h-[70vh] overflow-auto">
      {messages.map((msg, i) => {
        const m = msg as {
          type?: string;
          scope?: unknown;
          data?: { body?: string };
          senderHandle?: string;
          sender?: string;
        };
        const body = m?.data?.body;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: relay.jsonl line index IS the message id (analysis relayRefs point at it)
            key={`relay-${i}`}
            className="border-t py-1.5 font-mono text-xs"
            style={{ borderColor: 'var(--line)' }}
          >
            <span style={{ color: 'var(--ink-dim)' }}>#{i}</span>{' '}
            <span style={{ color: 'var(--amber)' }}>{m?.type ?? '?'}</span>{' '}
            <span style={{ color: 'var(--blue)' }}>{m?.senderHandle ?? m?.sender ?? ''}</span>{' '}
            {typeof body === 'string' ? body : <JsonBlock value={msg} />}
          </div>
        );
      })}
    </div>
  );
}
