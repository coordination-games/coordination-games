import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, fmtWinner, Section, StatusPill } from '../components/ui';
import type { CampaignInfo, JobPublic } from '../types';

function fmtTime(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

/** Game-agnostic peek at the outcome's summary for a headline welfare metric. */
function healthOf(outcome: { summary?: unknown } | null | undefined): string {
  const s = outcome?.summary as { commonsHealthPercent?: number } | undefined;
  return typeof s?.commonsHealthPercent === 'number' ? `${s.commonsHealthPercent}%` : '—';
}

export function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<CampaignInfo[]>([]);
  const [jobs, setJobs] = useState<JobPublic[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      Promise.all([api.campaigns(), api.jobs()])
        .then(([c, j]) => {
          if (!alive) return;
          setCampaigns(c.campaigns);
          setJobs(j.jobs);
          setError(null);
        })
        .catch((err: Error) => alive && setError(err.message));
    };
    load();
    const timer = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const running = jobs.filter((j) => j.status === 'running');

  return (
    <div>
      <ErrorNote error={error} />

      {running.length > 0 && (
        <Section title="running now">
          {running.map((job) => (
            <div key={job.id} className="flex items-center justify-between py-2">
              <div className="font-mono text-sm">
                <StatusPill status={job.status} /> <span className="ml-2">{job.kind}</span>
                {job.specPath && (
                  <span className="ml-2" style={{ color: 'var(--ink-dim)' }}>
                    {job.specPath}
                  </span>
                )}
              </div>
              <Link className="btn" to={`/job/${job.id}`}>
                watch live →
              </Link>
            </div>
          ))}
        </Section>
      )}

      <Section
        title="campaigns"
        right={
          <Link className="btn btn-primary" to="/new">
            + new campaign
          </Link>
        }
      >
        {campaigns.length === 0 ? (
          <Empty>
            No campaigns yet. Launch one from “New Campaign” — results land in runs/out/.
          </Empty>
        ) : (
          campaigns.map((c) => (
            <div key={c.id} className="mb-5">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="font-display font-semibold">{c.id}</span>
                <span className="label">{fmtTime(c.startedAt)}</span>
                {!c.complete && <StatusPill status="running" />}
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="label text-left">
                    <th className="py-1 pr-4 font-normal">run</th>
                    <th className="py-1 pr-4 font-normal">game</th>
                    <th className="py-1 pr-4 font-normal">status</th>
                    <th className="py-1 pr-4 font-normal">winner</th>
                    <th className="py-1 pr-4 font-normal">commons</th>
                    <th className="py-1 pr-4 font-normal">judge</th>
                  </tr>
                </thead>
                <tbody>
                  {c.runs.map((r, i) => (
                    <tr
                      key={r.runDir ?? `${r.label}-${i}`}
                      className="border-t"
                      style={{ borderColor: 'var(--line)' }}
                    >
                      <td className="py-2 pr-4 font-mono text-xs">
                        {r.runDir ? (
                          <Link
                            to={`/campaign/${encodeURIComponent(c.id)}/run/${encodeURIComponent(r.runDir)}`}
                            style={{ color: 'var(--blue)' }}
                          >
                            {r.label}
                          </Link>
                        ) : (
                          r.label
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.game}</td>
                      <td className="py-2 pr-4">
                        <StatusPill status={r.status} />
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {r.status === 'ok' ? fmtWinner(r.outcome?.winnerLabel) : '—'}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs" style={{ color: 'var(--mint)' }}>
                        {r.status === 'ok' ? healthOf(r.outcome) : '—'}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.analysis ? '✓' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}
