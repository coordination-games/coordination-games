import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorNote, fmtWinner, Section, StatusPill } from '../components/ui';
import type { CampaignInfo, Findings, FindingsCondition } from '../types';

export function FindingsPage() {
  const { campaignId = '' } = useParams();
  const [findings, setFindings] = useState<Findings | null>(null);
  const [campaign, setCampaign] = useState<CampaignInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .findings(campaignId)
      .then((f) => alive && setFindings(f))
      .catch((err: Error) => alive && setError(err.message));
    api
      .campaigns()
      .then((c) => {
        if (alive) setCampaign(c.campaigns.find((x) => x.id === campaignId) ?? null);
      })
      .catch(() => {
        // Run list is a nice-to-have on this page — the campaign scan can fail
        // independently of the findings aggregation above.
      });
    return () => {
      alive = false;
    };
  }, [campaignId]);

  if (error) return <ErrorNote error={error} />;
  if (!findings) return <Empty>loading findings…</Empty>;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Link to="/" className="font-mono text-xs" style={{ color: 'var(--ink-dim)' }}>
          ← campaigns
        </Link>
        <span className="font-display font-semibold">{campaignId}</span>
        <span className="label">
          {findings.totalRuns} run{findings.totalRuns === 1 ? '' : 's'}
        </span>
        <a
          className="btn btn-primary ml-auto"
          href={api.findingsHtmlUrl(campaignId)}
          download={`${campaignId}-findings.html`}
        >
          download research artifact
        </a>
      </div>

      <Section title="verdict">
        {findings.verdict.length === 0 ? (
          <Empty>Not enough data yet for a verdict.</Empty>
        ) : (
          findings.verdict.map((v, i) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: verdict is a read-only, server-ordered list
              key={`verdict-${i}`}
              className="text-lg leading-relaxed mb-2"
              style={{ color: i === 0 ? 'var(--mint)' : 'var(--ink)' }}
            >
              {v}
            </p>
          ))
        )}
      </Section>

      <HealthChart conditions={findings.conditions} />

      <Section title="conditions">
        <table className="w-full text-sm">
          <thead>
            <tr className="label text-left">
              <th className="py-1 pr-4 font-normal">condition</th>
              <th className="py-1 pr-4 font-normal">n</th>
              <th className="py-1 pr-4 font-normal">health avg (min–max)</th>
              <th className="py-1 pr-4 font-normal">trust</th>
              <th className="py-1 pr-4 font-normal">incidents</th>
              <th className="py-1 pr-4 font-normal">coordination</th>
            </tr>
          </thead>
          <tbody>
            {findings.conditions.map((c) => (
              <tr key={c.label} className="border-t" style={{ borderColor: 'var(--line)' }}>
                <td className="py-2 pr-4 font-mono text-xs">{c.label}</td>
                <td className="py-2 pr-4 font-mono text-xs">{c.n}</td>
                <td className="py-2 pr-4 font-mono text-xs" style={{ color: 'var(--mint)' }}>
                  {c.health ? `${c.health.avg}% (${c.health.min}–${c.health.max})` : '—'}
                </td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {c.trust ? `${c.trust.avg}/5 (n=${c.trust.n})` : '—'}
                </td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {c.incidents.betrayals + c.incidents.brokenPledges + c.incidents.deceptions}
                </td>
                <td className="py-2 pr-4 font-mono text-xs">{c.coordination}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {findings.conditions
        .filter((c) => c.judgeExcerpt)
        .map((c) => (
          <Section key={c.label} title={`judge excerpt · ${c.label}`}>
            <p className="text-sm leading-relaxed">{c.judgeExcerpt}</p>
          </Section>
        ))}

      {campaign && campaign.runs.length > 0 && (
        <Section title="runs">
          <table className="w-full text-sm">
            <thead>
              <tr className="label text-left">
                <th className="py-1 pr-4 font-normal">run</th>
                <th className="py-1 pr-4 font-normal">status</th>
                <th className="py-1 pr-4 font-normal">winner</th>
                <th className="py-1 pr-4 font-normal">commons</th>
                <th className="py-1 pr-4 font-normal">judge</th>
              </tr>
            </thead>
            <tbody>
              {campaign.runs.map((r, i) => (
                <tr
                  key={r.runDir ?? `${r.label}-${i}`}
                  className="border-t"
                  style={{ borderColor: 'var(--line)' }}
                >
                  <td className="py-2 pr-4 font-mono text-xs">
                    {r.runDir ? (
                      <Link
                        to={`/campaign/${encodeURIComponent(campaignId)}/run/${encodeURIComponent(r.runDir)}`}
                        style={{ color: 'var(--blue)' }}
                      >
                        {r.label}
                      </Link>
                    ) : (
                      r.label
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {r.status === 'ok' ? fmtWinner(r.outcome?.winnerLabel) : '—'}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs" style={{ color: 'var(--mint)' }}>
                    {healthOf(r.outcome)}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.analysis ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

/** Game-agnostic peek at the outcome's summary for a headline welfare metric
 * (mirrors CampaignsPage's healthOf). */
function healthOf(outcome: { summary?: unknown } | null | undefined): string {
  const s = outcome?.summary as { commonsHealthPercent?: number } | undefined;
  return typeof s?.commonsHealthPercent === 'number' ? `${s.commonsHealthPercent}%` : '—';
}

// --- chart -----------------------------------------------------------------------

const CHART_WIDTH = 640;
const CHART_HEIGHT = 260;
const PAD_LEFT = 34;
const PAD_RIGHT = 16;
const PAD_TOP = 24;
const PAD_BOTTOM = 40;
const GRID_TICKS = [0, 25, 50, 75, 100];

/** JSX equivalent of findings.ts's buildHealthChartSvg — same geometry, CSS-var
 * colors so it inherits the page's dark aesthetic directly (no export needed
 * here; the HTML export renders its own copy server-side). */
function HealthChart({ conditions }: { conditions: FindingsCondition[] }) {
  const bars = conditions.filter(
    (c): c is FindingsCondition & { health: NonNullable<FindingsCondition['health']> } =>
      c.health !== null,
  );
  if (bars.length === 0) return null;

  const plotWidth = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const slot = plotWidth / bars.length;
  const barWidth = Math.min(64, slot * 0.55);
  const baseY = PAD_TOP + plotHeight;
  const yFor = (v: number) => PAD_TOP + plotHeight * (1 - Math.max(0, Math.min(1, v / 100)));

  return (
    <Section title="commons health by condition">
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        width="100%"
        height={CHART_HEIGHT}
        role="img"
        aria-label="commons health by condition"
      >
        {GRID_TICKS.map((v) => (
          <g key={v}>
            <line
              x1={PAD_LEFT}
              y1={yFor(v)}
              x2={CHART_WIDTH - PAD_RIGHT}
              y2={yFor(v)}
              stroke="var(--line)"
              strokeWidth={1}
            />
            <text
              x={PAD_LEFT - 8}
              y={yFor(v) + 4}
              textAnchor="end"
              fontSize={10}
              fontFamily="monospace"
              fill="var(--ink-dim)"
            >
              {v}
            </text>
          </g>
        ))}
        <line
          x1={PAD_LEFT}
          y1={baseY}
          x2={CHART_WIDTH - PAD_RIGHT}
          y2={baseY}
          stroke="var(--line)"
          strokeWidth={1}
        />
        {bars.map((c, i) => {
          const cx = PAD_LEFT + slot * i + slot / 2;
          const x = cx - barWidth / 2;
          const barTop = yFor(c.health.avg);
          const barHeight = baseY - barTop;
          return (
            <g key={c.label}>
              <rect
                x={x}
                y={barTop}
                width={barWidth}
                height={barHeight}
                fill="var(--mint)"
                rx={3}
              />
              <text
                x={cx}
                y={barTop - 8}
                textAnchor="middle"
                fontSize={12}
                fontFamily="monospace"
                fill="var(--ink)"
              >
                {c.health.avg}%
              </text>
              {c.n > 1 && (
                <>
                  <line
                    x1={cx}
                    y1={yFor(c.health.max)}
                    x2={cx}
                    y2={yFor(c.health.min)}
                    stroke="var(--ink-dim)"
                    strokeWidth={1.5}
                  />
                  <line
                    x1={cx - 5}
                    y1={yFor(c.health.max)}
                    x2={cx + 5}
                    y2={yFor(c.health.max)}
                    stroke="var(--ink-dim)"
                    strokeWidth={1.5}
                  />
                  <line
                    x1={cx - 5}
                    y1={yFor(c.health.min)}
                    x2={cx + 5}
                    y2={yFor(c.health.min)}
                    stroke="var(--ink-dim)"
                    strokeWidth={1.5}
                  />
                </>
              )}
              <text
                x={cx}
                y={baseY + 18}
                textAnchor="middle"
                fontSize={11}
                fontFamily="monospace"
                fill="var(--ink-dim)"
              >
                {c.label}
              </text>
            </g>
          );
        })}
      </svg>
    </Section>
  );
}
