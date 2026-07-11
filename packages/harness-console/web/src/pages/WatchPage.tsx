import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Empty, StatusPill } from '../components/ui';
import type { Findings, JobPublic, NarratedEvent } from '../types';

/** Same-host, spectator's fixed dev port — matches SettingsPage's SpectatorStatus
 * and RunPage's WatchReplayLink. */
const SPECTATOR_ORIGIN = `http://${window.location.hostname}:4173`;
const FEED_POLL_MS = 3000;
const ROUND_BEGINS_RE = /round\s+(\d+)\s+begins/i;

type Phase = 'warming' | 'playing' | 'finished' | 'failed';

function phaseOf(job: JobPublic | null): Phase {
  if (!job) return 'warming';
  if (job.status === 'error' || job.status === 'stopped') return 'failed';
  if (job.status === 'done') return 'finished';
  return job.gameIds.length > 0 ? 'playing' : 'warming';
}

/**
 * A visitor never sees a "waiting on the harness" spinner — the warming phase
 * narrates the same log lines a researcher would tail, in plain language.
 * Scans most-recent-first so the phrase always reflects where things actually
 * are, not where they started.
 */
function warmingStatus(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (/\[identity\].*authenticated/.test(line)) return 'waking the agents…';
    if (/running \d+ sessions concurrently/.test(line))
      return 'the agents are sitting down to play…';
    if (/\[lobby\].+joined/.test(line)) return 'agents are joining the table…';
    if (/\[lobby\].+created/.test(line)) return 'the table is ready — inviting the agents…';
    if (/\[lobby\] creating/.test(line)) return 'setting up the table…';
  }
  return 'warming up…';
}

/** A demo-friendly rewrite of the last error-shaped log line, for the failed
 * phase when no usage-limit notice was set. Strips the harness's `[tag]`
 * prefixes — this UI never shows internal vocabulary. */
function lastErrorLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (/fail|error|✗/i.test(line))
      return line.replace(/^\[[^\]]*\]\s*/, '').replace(/^\S+!\s*/, '');
  }
  return null;
}

function useSpectatorReachable(): boolean | null {
  const [reachable, setReachable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      fetch(SPECTATOR_ORIGIN, { signal: controller.signal, mode: 'no-cors' })
        .then(() => {
          if (!cancelled) setReachable(true);
        })
        .catch(() => {
          if (!cancelled) setReachable(false);
        })
        .finally(() => clearTimeout(timer));
    };
    check();
    const timer = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return reachable;
}

export function WatchPage() {
  const { jobId } = useParams();
  const [job, setJob] = useState<JobPublic | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!jobId) return;
    setJob(null);
    setLines([]);
    const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
    source.addEventListener('status', (e) => {
      setJob(JSON.parse((e as MessageEvent).data) as JobPublic);
    });
    source.addEventListener('log', (e) => {
      const { line } = JSON.parse((e as MessageEvent).data) as { line: string };
      setLines((prev) => (prev.length > 4000 ? [...prev.slice(-3500), line] : [...prev, line]));
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [jobId]);

  const phase = phaseOf(job);
  const currentGameId =
    job && job.gameIds.length > 0 ? job.gameIds[job.gameIds.length - 1] : undefined;

  return (
    <div>
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="label">watching a demonstration</div>
        {job && <StatusPill status={job.status} />}
        {phase === 'playing' && job && job.runsTotal && job.runsTotal > 1 && (
          <span className="label">
            game {job.gameIds.length} of {job.runsTotal}
          </span>
        )}
      </div>

      {phase === 'warming' && <WarmingPanel lines={lines} />}
      {phase === 'playing' && currentGameId && <PlayingPanel gameId={currentGameId} />}
      {phase === 'finished' && job && <FinishedPanel job={job} />}
      {phase === 'failed' && job && <FailedPanel job={job} lines={lines} />}

      <details className="mt-6">
        <summary className="label" style={{ cursor: 'pointer' }}>
          details — raw output
        </summary>
        <pre className="terminal mt-2" style={{ maxHeight: '40vh' }}>
          {lines.length === 0 ? 'waiting for output…' : lines.join('\n')}
        </pre>
      </details>
    </div>
  );
}

// --- warming -----------------------------------------------------------------

function WarmingPanel({ lines }: { lines: string[] }) {
  return (
    <div className="panel watch-warming">
      <div className="watch-warming-dot" />
      <div>
        <div className="font-display text-lg font-600" style={{ color: 'var(--mint)' }}>
          {warmingStatus(lines)}
        </div>
        <div className="label mt-2">this usually takes under a minute</div>
      </div>
    </div>
  );
}

// --- playing -------------------------------------------------------------------

function PlayingPanel({ gameId }: { gameId: string }) {
  const reachable = useSpectatorReachable();
  return (
    <div className="watch-board-wrap">
      {reachable === false ? (
        <div className="watch-board-placeholder panel">
          the game board isn't being served right now — the narrated feed alongside is still live.
        </div>
      ) : (
        <iframe
          key={gameId}
          className="watch-board-frame"
          src={`${SPECTATOR_ORIGIN}/game/${gameId}?embed=1`}
          title="game board"
        />
      )}
      <NarratedFeed gameId={gameId} />
    </div>
  );
}

function NarratedFeed({ gameId }: { gameId: string }) {
  const [events, setEvents] = useState<NarratedEvent[]>([]);
  const [meter, setMeter] = useState<{ label: string; percent: number } | null>(null);
  const [showThoughts, setShowThoughts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef(-1);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    setMeter(null);
    setError(null);
    sinceRef.current = -1;

    async function poll() {
      try {
        const feed = await api.liveFeed(gameId, sinceRef.current);
        if (cancelled) return;
        setError(null);
        if (feed.meter) setMeter(feed.meter);
        if (feed.events.length > 0) {
          sinceRef.current = feed.events.reduce((max, e) => Math.max(max, e.i), sinceRef.current);
          setEvents((prev) => [...prev, ...feed.events]);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), FEED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [gameId]);

  useEffect(() => {
    const el = feedRef.current;
    if (el && stickToBottom.current && events.length > 0) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div>
      {meter && (
        <div className="watch-meter">
          <div className="flex items-center justify-between mb-1">
            <span className="label">{meter.label}</span>
            <span className="font-mono text-xs" style={{ color: 'var(--mint)' }}>
              {meter.percent}%
            </span>
          </div>
          <div className="watch-meter-track">
            <div
              className="watch-meter-fill"
              style={{ width: `${Math.max(0, Math.min(100, meter.percent))}%` }}
            />
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <span className="label">table talk</span>
        <button type="button" className="btn" onClick={() => setShowThoughts((v) => !v)}>
          {showThoughts ? 'hide thoughts' : 'show thoughts'}
        </button>
      </div>
      <div
        className="watch-feed"
        ref={feedRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {events.length === 0 ? (
          <Empty>waiting for the first move…</Empty>
        ) : (
          events.map((e) => <FeedItem key={e.i} event={e} showThoughts={showThoughts} />)
        )}
      </div>
      {error && (
        <div className="label mt-1" style={{ color: 'var(--hot)' }}>
          {error}
        </div>
      )}
    </div>
  );
}

function FeedItem({ event, showThoughts }: { event: NarratedEvent; showThoughts: boolean }) {
  if (event.kind === 'system') {
    const roundMatch = ROUND_BEGINS_RE.exec(event.body);
    if (roundMatch?.[1]) {
      return <div className="feed-item feed-round-marker">round {roundMatch[1]}</div>;
    }
    return <div className="feed-item feed-quiet">{event.body}</div>;
  }
  if (event.kind === 'reasoning') {
    if (!showThoughts) return null;
    return (
      <div className="feed-item feed-reasoning">
        {event.actor ? `${event.actor}: ` : ''}
        {event.body}
      </div>
    );
  }
  if (event.kind === 'trust') {
    return (
      <div className="feed-item feed-trust">
        {event.actor ?? '?'} {event.body}
      </div>
    );
  }
  if (event.kind === 'action') {
    return (
      <div className="feed-item feed-quiet">
        {event.actor ? `${event.actor} ` : ''}
        {event.body}
      </div>
    );
  }
  return (
    <div className="feed-item feed-chat">
      <div className="feed-chat-actor">{event.actor ?? 'table'}</div>
      <div className="feed-chat-body">{event.body}</div>
    </div>
  );
}

// --- finished --------------------------------------------------------------------

function FinishedPanel({ job }: { job: JobPublic }) {
  const [findings, setFindings] = useState<Findings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const campaignId = job.campaignId;

  useEffect(() => {
    if (!campaignId) return;
    api
      .findings(campaignId)
      .then(setFindings)
      .catch((err: Error) => setError(err.message));
  }, [campaignId]);

  if (!campaignId) {
    return (
      <div className="panel p-5">
        <Empty>the demonstration finished, but no result was recorded.</Empty>
        <div className="mt-3">
          <Link className="btn btn-primary" to="/">
            run another demonstration
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <div className="label mb-2">the finding</div>
      {error && <Empty>{error}</Empty>}
      {!error && !findings && <Empty>gathering the finding…</Empty>}
      {findings && findings.verdict.length === 0 && (
        <Empty>not enough data yet for a verdict.</Empty>
      )}
      {findings?.verdict.map((v, i) => (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: verdict is a read-only, server-ordered list
          key={`verdict-${i}`}
          className="text-lg leading-relaxed mb-2"
          style={{ color: i === 0 ? 'var(--mint)' : 'var(--ink)' }}
        >
          {v}
        </p>
      ))}

      {findings && findings.conditions.length > 0 && (
        <div
          className="grid gap-2 mt-4 mb-5"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}
        >
          {findings.conditions.map((c) => (
            <div key={c.label} className="panel p-3">
              <div className="label mb-1">{c.label}</div>
              <div className="font-mono text-sm" style={{ color: 'var(--mint)' }}>
                {c.health ? `${c.health.avg}% commons health` : '—'}
              </div>
              <div className="label mt-1">
                {c.n} game{c.n === 1 ? '' : 's'}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <Link className="btn btn-primary" to={`/campaign/${encodeURIComponent(campaignId)}`}>
          view full findings
        </Link>
        {job.gameIds.map((gid, i) => (
          <a
            key={gid}
            className="btn"
            href={`${SPECTATOR_ORIGIN}/replay/${gid}`}
            target="_blank"
            rel="noreferrer"
          >
            watch replay{job.gameIds.length > 1 ? ` (game ${i + 1})` : ''}
          </a>
        ))}
        <Link className="btn" to="/">
          run another demonstration
        </Link>
      </div>
    </div>
  );
}

// --- failed ----------------------------------------------------------------------

function FailedPanel({ job, lines }: { job: JobPublic; lines: string[] }) {
  const message = job.limitNotice ?? lastErrorLine(lines) ?? 'The demonstration could not finish.';
  return (
    <div className="panel p-5">
      <div className="label mb-2" style={{ color: 'var(--hot)' }}>
        something went wrong
      </div>
      <p className="text-base leading-relaxed mb-4">{message}</p>
      <Link className="btn btn-primary" to="/">
        try again
      </Link>
    </div>
  );
}
