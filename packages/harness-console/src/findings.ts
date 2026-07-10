/**
 * Findings: turns a campaign's raw runs into an understandable result —
 * conditions grouped by baseLabel (run label minus trailing -rN), a plain-
 * English verdict, and an inline SVG bar chart. All deterministic — no model
 * calls. Disk shapes mirror artifacts.ts (RunManifest) and
 * packages/model-harness/src/analyze.ts (AnalysisReport); every field here
 * is treated as optional since games differ and analysis.json may be absent.
 *
 * This module is also the source of the self-contained HTML research
 * artifact (`buildFindingsHtml`) — the shareable output of the whole console.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { exists, type RunManifest, readJson } from './artifacts.js';
import { assertSafeId, HttpError, OUTPUT_DIR } from './paths.js';

// --- shapes ------------------------------------------------------------------

interface AnalysisFile {
  betrayals?: unknown[];
  brokenPledges?: unknown[];
  deceptions?: unknown[];
  coordination?: unknown[];
  perBot?: { bot?: string; trustworthiness?: number }[];
  summary?: string;
}

interface ManifestSummary {
  commonsHealthPercent?: number;
  flourishingEcosystems?: number;
}

export interface FindingsCondition {
  label: string;
  n: number;
  health: { avg: number; min: number; max: number } | null;
  ecosystemsAvg: number | null;
  incidents: { betrayals: number; brokenPledges: number; deceptions: number };
  coordination: number;
  trust: { avg: number; n: number } | null;
  judgeExcerpt: string | null;
}

export interface Findings {
  campaignId: string;
  totalRuns: number;
  conditions: FindingsCondition[];
  verdict: string[];
}

// --- helpers -------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function baseLabelOf(label: string): string {
  return label.replace(/-r\d+$/, '');
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// --- build ---------------------------------------------------------------------

interface RunRecord {
  label: string;
  manifest: RunManifest | null;
  analysis: AnalysisFile | null;
}

async function readRuns(campaignDir: string): Promise<RunRecord[]> {
  let dirents: string[] = [];
  try {
    dirents = (await fsp.readdir(campaignDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith('run-'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
  return Promise.all(
    dirents.map(async (runDir): Promise<RunRecord> => {
      const dir = path.join(campaignDir, runDir);
      const label = runDir.replace(/^run-\d+-?/, '') || runDir;
      const manifest = await readJson<RunManifest>(path.join(dir, 'manifest.json'));
      const analysis = await readJson<AnalysisFile>(path.join(dir, 'analysis.json'));
      return { label, manifest, analysis };
    }),
  );
}

export async function buildFindings(campaignId: string): Promise<Findings> {
  assertSafeId(campaignId, 'campaign id');
  const campaignDir = path.join(OUTPUT_DIR, campaignId);
  if (!(await exists(campaignDir))) {
    throw new HttpError(404, `campaign not found: ${campaignId}`);
  }

  const runs = await readRuns(campaignDir);

  interface Bucket {
    label: string;
    n: number;
    healthValues: number[];
    ecosystemValues: number[];
    betrayals: number;
    brokenPledges: number;
    deceptions: number;
    coordination: number;
    trustValues: number[];
    judgeExcerpt: string | null;
  }

  const buckets = new Map<string, Bucket>();
  const allHealthValues: number[] = [];
  let anyAnalysis = false;
  let totalBetrayals = 0;
  let totalBrokenPledges = 0;
  let totalDeceptions = 0;

  for (const run of runs) {
    const base = baseLabelOf(run.label);
    let bucket = buckets.get(base);
    if (!bucket) {
      bucket = {
        label: base,
        n: 0,
        healthValues: [],
        ecosystemValues: [],
        betrayals: 0,
        brokenPledges: 0,
        deceptions: 0,
        coordination: 0,
        trustValues: [],
        judgeExcerpt: null,
      };
      buckets.set(base, bucket);
    }
    bucket.n += 1;

    const summary = run.manifest?.outcome?.summary as ManifestSummary | undefined;
    if (typeof summary?.commonsHealthPercent === 'number') {
      bucket.healthValues.push(summary.commonsHealthPercent);
      allHealthValues.push(summary.commonsHealthPercent);
    }
    if (typeof summary?.flourishingEcosystems === 'number') {
      bucket.ecosystemValues.push(summary.flourishingEcosystems);
    }

    if (run.analysis) {
      anyAnalysis = true;
      const betrayals = run.analysis.betrayals?.length ?? 0;
      const brokenPledges = run.analysis.brokenPledges?.length ?? 0;
      const deceptions = run.analysis.deceptions?.length ?? 0;
      bucket.betrayals += betrayals;
      bucket.brokenPledges += brokenPledges;
      bucket.deceptions += deceptions;
      bucket.coordination += run.analysis.coordination?.length ?? 0;
      totalBetrayals += betrayals;
      totalBrokenPledges += brokenPledges;
      totalDeceptions += deceptions;
      for (const pb of run.analysis.perBot ?? []) {
        if (typeof pb.trustworthiness === 'number') bucket.trustValues.push(pb.trustworthiness);
      }
      if (!bucket.judgeExcerpt && run.analysis.summary) bucket.judgeExcerpt = run.analysis.summary;
    }
  }

  const conditions: FindingsCondition[] = [...buckets.values()].map((b) => ({
    label: b.label,
    n: b.n,
    health:
      b.healthValues.length > 0
        ? {
            avg: round1(mean(b.healthValues)),
            min: Math.min(...b.healthValues),
            max: Math.max(...b.healthValues),
          }
        : null,
    ecosystemsAvg: b.ecosystemValues.length > 0 ? round1(mean(b.ecosystemValues)) : null,
    incidents: { betrayals: b.betrayals, brokenPledges: b.brokenPledges, deceptions: b.deceptions },
    coordination: b.coordination,
    trust:
      b.trustValues.length > 0
        ? { avg: round1(mean(b.trustValues)), n: b.trustValues.length }
        : null,
    judgeExcerpt: b.judgeExcerpt,
  }));

  const verdict: string[] = [];

  if (allHealthValues.length > 0) {
    verdict.push(
      `${pluralize(allHealthValues.length, 'game')} · commons ended at ${round1(mean(allHealthValues))}% health on average`,
    );
  }

  if (anyAnalysis) {
    const totalIncidents = totalBetrayals + totalBrokenPledges + totalDeceptions;
    if (totalIncidents === 0) {
      verdict.push('Zero betrayals, broken pledges, or deceptions across the whole campaign.');
    } else {
      verdict.push(
        `${pluralize(totalIncidents, 'incident')} recorded across the campaign ` +
          `(${pluralize(totalBetrayals, 'betrayal')}, ${totalBrokenPledges} broken pledge${totalBrokenPledges === 1 ? '' : 's'}, ${pluralize(totalDeceptions, 'deception')}).`,
      );
    }
  } else {
    verdict.push(
      'No judge analysis yet — run the judge on individual runs to see betrayals, pledges, and deceptions.',
    );
  }

  const withHealth = conditions.filter(
    (c): c is FindingsCondition & { health: NonNullable<FindingsCondition['health']> } =>
      c.health !== null,
  );
  if (withHealth.length >= 2) {
    let best = withHealth[0] as (typeof withHealth)[number];
    let worst = withHealth[0] as (typeof withHealth)[number];
    for (const c of withHealth) {
      if (c.health.avg > best.health.avg) best = c;
      if (c.health.avg < worst.health.avg) worst = c;
    }
    if (best.label !== worst.label) {
      verdict.push(
        `“${best.label}” held up best at ${best.health.avg}% average commons health; “${worst.label}” fared worst at ${worst.health.avg}%.`,
      );
    }
  }

  return { campaignId, totalRuns: runs.length, conditions, verdict };
}

// --- chart ---------------------------------------------------------------------

const CHART_WIDTH = 640;
const CHART_HEIGHT = 260;
const PAD_LEFT = 34;
const PAD_RIGHT = 16;
const PAD_TOP = 24;
const PAD_BOTTOM = 40;

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Hand-rolled inline SVG bar chart: conditions on x, avg commons health (0-100)
 * on y, value labels, min/max whiskers when n>1. Pure function — used verbatim
 * in the HTML export; the web page renders its own JSX equivalent. */
export function buildHealthChartSvg(conditions: FindingsCondition[]): string | null {
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
  const yFor = (v: number) => PAD_TOP + plotHeight * (1 - clamp01(v / 100));

  const gridLines = [0, 25, 50, 75, 100]
    .map((v) => {
      const y = yFor(v);
      return (
        `<line x1="${PAD_LEFT}" y1="${y}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${y}" stroke="var(--line)" stroke-width="1" />` +
        `<text x="${PAD_LEFT - 8}" y="${y + 4}" text-anchor="end" font-size="10" font-family="monospace" fill="var(--ink-dim)">${v}</text>`
      );
    })
    .join('');

  const barsSvg = bars
    .map((c, i) => {
      const cx = PAD_LEFT + slot * i + slot / 2;
      const x = cx - barWidth / 2;
      const barTop = yFor(c.health.avg);
      const barHeight = baseY - barTop;
      const whisker =
        c.n > 1
          ? `<line x1="${cx}" y1="${yFor(c.health.max)}" x2="${cx}" y2="${yFor(c.health.min)}" stroke="var(--ink-dim)" stroke-width="1.5" />` +
            `<line x1="${cx - 5}" y1="${yFor(c.health.max)}" x2="${cx + 5}" y2="${yFor(c.health.max)}" stroke="var(--ink-dim)" stroke-width="1.5" />` +
            `<line x1="${cx - 5}" y1="${yFor(c.health.min)}" x2="${cx + 5}" y2="${yFor(c.health.min)}" stroke="var(--ink-dim)" stroke-width="1.5" />`
          : '';
      const label = escapeXml(c.label);
      return (
        `<rect x="${x}" y="${barTop}" width="${barWidth}" height="${barHeight}" fill="var(--mint)" rx="3" />` +
        `<text x="${cx}" y="${barTop - 8}" text-anchor="middle" font-size="12" font-family="monospace" fill="var(--ink)">${c.health.avg}%</text>` +
        whisker +
        `<text x="${cx}" y="${baseY + 18}" text-anchor="middle" font-size="11" font-family="monospace" fill="var(--ink-dim)">${label}</text>`
      );
    })
    .join('');

  const axis = `<line x1="${PAD_LEFT}" y1="${baseY}" x2="${CHART_WIDTH - PAD_RIGHT}" y2="${baseY}" stroke="var(--line)" stroke-width="1" />`;

  return (
    `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" width="100%" height="${CHART_HEIGHT}" ` +
    `role="img" aria-label="commons health by condition">${gridLines}${axis}${barsSvg}</svg>`
  );
}

// --- HTML export -----------------------------------------------------------------

function escapeHtml(s: string): string {
  return escapeXml(s);
}

/** A completely self-contained HTML document: inline CSS (console's dark
 * aesthetic), inline SVG chart, zero external requests. The shareable
 * research artifact. */
export function buildFindingsHtml(findings: Findings): string {
  const chart = buildHealthChartSvg(findings.conditions);
  const rows = findings.conditions
    .map((c) => {
      const health = c.health ? `${c.health.avg}% (${c.health.min}–${c.health.max})` : '—';
      const trust = c.trust ? `${c.trust.avg}/5 (n=${c.trust.n})` : '—';
      const incidents = c.incidents.betrayals + c.incidents.brokenPledges + c.incidents.deceptions;
      return (
        '<tr>' +
        `<td>${escapeHtml(c.label)}</td>` +
        `<td>${c.n}</td>` +
        `<td class="mint">${escapeHtml(health)}</td>` +
        `<td>${escapeHtml(trust)}</td>` +
        `<td>${incidents}</td>` +
        `<td>${c.coordination}</td>` +
        '</tr>'
      );
    })
    .join('');

  const excerpts = findings.conditions
    .filter((c) => c.judgeExcerpt)
    .map(
      (c) =>
        `<div class="panel"><div class="label">${escapeHtml(c.label)}</div>` +
        `<p class="excerpt">${escapeHtml(c.judgeExcerpt ?? '')}</p></div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Findings — ${escapeHtml(findings.campaignId)}</title>
<style>
  :root {
    --bg: #101210; --panel: #181b18; --line: #2c322c; --ink: #e8e6df;
    --ink-dim: #9a9a90; --mint: #7fd8a4; --amber: #e5b567; --hot: #e56767; --blue: #7fb4d8;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--ink); margin: 0; padding: 32px 24px 48px;
    font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: 0.01em; }
  .sub {
    color: var(--ink-dim); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.08em; margin-bottom: 28px;
  }
  .verdict { font-size: 16px; line-height: 1.5; margin: 0 0 10px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-top: 1px solid var(--line); }
  tr:first-child th { border-top: none; }
  th { color: var(--ink-dim); font-weight: normal; text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; }
  .mint { color: var(--mint); }
  .label {
    font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-dim); margin-bottom: 6px;
  }
  .excerpt { font-size: 13px; line-height: 1.6; margin: 0; color: var(--ink); }
  footer { color: var(--ink-dim); font-size: 11px; margin-top: 32px; }
  svg text { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(findings.campaignId)}</h1>
    <div class="sub">campaign findings &middot; ${findings.totalRuns} run${findings.totalRuns === 1 ? '' : 's'}</div>
    ${findings.verdict.map((v) => `<p class="verdict">${escapeHtml(v)}</p>`).join('\n    ')}
    ${chart ? `<div class="panel">${chart}</div>` : ''}
    <div class="panel">
      <table>
        <thead>
          <tr><th>condition</th><th>n</th><th>health avg (min&ndash;max)</th><th>trust</th><th>incidents</th><th>coordination</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${excerpts}
    <footer>Generated by Campaign Console &middot; ${new Date().toISOString()}</footer>
  </div>
</body>
</html>
`;
}
