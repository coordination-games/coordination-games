import { useEffect, useState } from 'react';
import { api } from '../api';
import { Empty, ErrorNote, Section } from '../components/ui';
import type { ModelAggregate } from '../types';

export function ComparePage() {
  const [models, setModels] = useState<ModelAggregate[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .aggregate()
      .then((r) => setModels(r.models))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div>
      <ErrorNote error={error} />
      <Section title="model comparison — all campaigns">
        {models.length === 0 ? (
          <Empty>no completed runs yet — launch a campaign with seats on different models</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1 pr-4 font-normal">model</th>
                <th className="py-1 pr-4 font-normal">backend</th>
                <th className="py-1 pr-4 font-normal">runs</th>
                <th className="py-1 pr-4 font-normal">seats</th>
                <th className="py-1 pr-4 font-normal">wins</th>
                <th className="py-1 pr-4 font-normal">finished</th>
                <th className="py-1 pr-4 font-normal">consequential turns</th>
                <th className="py-1 pr-4 font-normal">talk-only</th>
                <th className="py-1 pr-4 font-normal">judge trust (1–5)</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr
                  key={m.model}
                  className="border-t font-mono text-xs"
                  style={{ borderColor: 'var(--line)' }}
                >
                  <td className="py-2 pr-4">{m.model}</td>
                  <td className="py-2 pr-4">{m.backend}</td>
                  <td className="py-2 pr-4">{m.runs}</td>
                  <td className="py-2 pr-4">{m.seats}</td>
                  <td className="py-2 pr-4" style={{ color: 'var(--mint)' }}>
                    {m.wins}
                  </td>
                  <td className="py-2 pr-4">{m.finished}</td>
                  <td className="py-2 pr-4">{m.consequentialTurns}</td>
                  <td className="py-2 pr-4">{m.talkOnlyTurns}</td>
                  <td className="py-2 pr-4" style={{ color: 'var(--amber)' }}>
                    {m.avgTrustworthiness ?? '—'}
                    {m.trustSamples > 0 && (
                      <span style={{ color: 'var(--ink-dim)' }}> ({m.trustSamples})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="label mt-3">
          wins count runs whose winnerLabel names a bot seated on the model · consequential turns
          are the cross-backend comparable activity metric · trust is the judge's per-bot score
          averaged over analyzed runs
        </p>
      </Section>
    </div>
  );
}
