import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Empty } from '../components/ui';
import type { DemoSummary } from '../types';

/**
 * The front door (docs/plans/demo-first.md, "layer 1"): three canned
 * demonstrations, zero configuration. A non-technical viewer presses one
 * button and watches AI agents play. The full spec builder lives in the Lab.
 */
export function DemosPage() {
  const navigate = useNavigate();
  const [demos, setDemos] = useState<DemoSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  useEffect(() => {
    api
      .demos()
      .then((r) => setDemos(r.demos))
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  async function launch(id: string) {
    setLaunchingId(id);
    setRunError(null);
    setFailedId(null);
    try {
      const job = await api.runDemo(id);
      navigate(`/watch/${job.id}`);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      setFailedId(id);
      setLaunchingId(null);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <div className="label mb-1">coordination games · demonstrations</div>
        <p className="text-sm" style={{ color: 'var(--ink-dim)' }}>
          pick a question, press one button — watch AI agents play, then read the finding in plain
          English.
        </p>
      </div>

      {loadError && (
        <div
          className="panel p-3 mb-4 font-mono text-xs"
          style={{ color: 'var(--hot)', borderColor: 'var(--hot)' }}
        >
          {loadError}
        </div>
      )}

      {runError && (
        <div
          className="panel p-3 mb-4 flex items-center justify-between gap-3"
          style={{ borderColor: 'var(--hot)' }}
        >
          <span className="text-sm" style={{ color: 'var(--hot)' }}>
            {runError}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => failedId && launch(failedId)}
            style={{ flexShrink: 0 }}
          >
            retry
          </button>
        </div>
      )}

      {!demos && !loadError && <Empty>loading demos…</Empty>}

      <div className="grid gap-4 md:grid-cols-3">
        {(demos ?? []).map((demo) => (
          <DemoCard
            key={demo.id}
            demo={demo}
            launching={launchingId === demo.id}
            disabled={launchingId !== null}
            onLaunch={() => launch(demo.id)}
          />
        ))}
      </div>
    </div>
  );
}

function DemoCard({
  demo,
  launching,
  disabled,
  onLaunch,
}: {
  demo: DemoSummary;
  launching: boolean;
  disabled: boolean;
  onLaunch: () => void;
}) {
  return (
    <div className="panel p-5 flex flex-col">
      <div className="label mb-2">{demo.title}</div>
      <h2 className="font-display text-lg font-600 mb-2" style={{ color: 'var(--mint)' }}>
        {demo.question}
      </h2>
      <p className="text-sm flex-1 leading-relaxed" style={{ color: 'var(--ink-dim)' }}>
        {demo.blurb}
      </p>
      <div className="flex items-center justify-between mt-4 gap-3">
        <span className="label">~{demo.estMinutes} min</span>
        <button
          type="button"
          className="btn btn-primary"
          style={{ padding: '10px 18px' }}
          disabled={disabled}
          onClick={onLaunch}
        >
          {launching ? 'warming up the game server…' : 'run this demo'}
        </button>
      </div>
    </div>
  );
}
