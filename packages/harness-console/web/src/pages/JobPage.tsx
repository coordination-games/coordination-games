import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Section, StatusPill } from '../components/ui';
import type { JobPublic } from '../types';

export function JobPage() {
  const { jobId } = useParams();
  const [job, setJob] = useState<JobPublic | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const termRef = useRef<HTMLPreElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (!jobId) return;
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

  useEffect(() => {
    const el = termRef.current;
    if (el && stickToBottom.current && lines.length > 0) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div>
      <Section
        title="job"
        right={
          job?.status === 'running' ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => jobId && api.stopJob(jobId).then(setJob)}
            >
              stop run
            </button>
          ) : job?.status === 'done' && job.campaignId ? (
            <Link className="btn btn-primary" to="/lab">
              view results →
            </Link>
          ) : undefined
        }
      >
        <div className="flex items-center gap-3 flex-wrap font-mono text-sm">
          {job && <StatusPill status={job.status} />}
          <span>{job?.kind}</span>
          {job?.specPath && <span style={{ color: 'var(--ink-dim)' }}>{job.specPath}</span>}
          {job?.campaignId && (
            <Link to="/lab" style={{ color: 'var(--blue)' }}>
              {job.campaignId} → results
            </Link>
          )}
          {job?.exitCode !== undefined && job.exitCode !== null && (
            <span style={{ color: 'var(--ink-dim)' }}>exit {job.exitCode}</span>
          )}
        </div>
      </Section>

      <pre
        ref={termRef}
        className="terminal h-[65vh]"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 ? 'waiting for output…' : lines.join('\n')}
      </pre>
    </div>
  );
}
