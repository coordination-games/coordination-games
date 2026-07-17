/**
 * The story site: one self-contained HTML page that turns runs/out into a
 * narrative — why coordination is the bottleneck, what the instrument is,
 * what it has found (real data, honest n), what it becomes. Same posture as
 * findings.ts: deterministic, no model calls, every field optional because
 * games differ and analysis.json may be absent or a campaign mid-run.
 *
 * Narrative source: docs/plans/research-program.md (v2). Design brief:
 * docs/plans/ui-rethink.md ("science-museum exhibit"), docs/plans/demo-first.md.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { listCampaigns, type RunManifest, readJson } from './artifacts.js';
import { buildHealthChartSvg, type FindingsCondition } from './findings.js';
import { OUTPUT_DIR } from './paths.js';

// --- shapes (mirrors findings.ts / packages/model-harness/src/analyze.ts) ----

interface AnalysisPerBot {
  bot?: string;
  persona?: string;
  model?: string;
  trustworthiness?: number;
}

interface AnalysisFile {
  betrayals?: unknown[];
  brokenPledges?: unknown[];
  deceptions?: unknown[];
  coordination?: unknown[];
  perBot?: AnalysisPerBot[];
  summary?: string;
}

interface StoryRun {
  campaignId: string;
  runDir: string;
  label: string;
  baseLabel: string;
  manifest: RunManifest | null;
  analysis: AnalysisFile | null;
}

// --- helpers ------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function baseLabelOf(label: string): string {
  return label.replace(/-r\d+$/, '');
}

function escapeHtml(s: string): string {
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

function gameOf(manifest: RunManifest): string {
  return String((manifest.spec as { game?: unknown }).game ?? '?');
}

function healthPercentOf(manifest: RunManifest | null): number | null {
  if (!manifest) return null;
  const summary = manifest.outcome?.summary as { commonsHealthPercent?: number } | undefined;
  return typeof summary?.commonsHealthPercent === 'number' ? summary.commonsHealthPercent : null;
}

// --- data collection: every run under runs/out, whatever campaign it's in ----

/** Walks OUTPUT_DIR top to bottom; any directory that can't be read is
 * skipped, not thrown — a mid-run or half-written campaign must still let
 * the rest of the page render. */
async function readAllRuns(): Promise<StoryRun[]> {
  let campaignDirs: string[] = [];
  try {
    campaignDirs = (await fsp.readdir(OUTPUT_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name.startsWith('campaign-'))
      .map((d) => d.name);
  } catch {
    return [];
  }

  const all: StoryRun[] = [];
  for (const campaignId of campaignDirs) {
    const campaignDir = path.join(OUTPUT_DIR, campaignId);
    let runDirs: string[] = [];
    try {
      runDirs = (await fsp.readdir(campaignDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && d.name.startsWith('run-'))
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const runDir of runDirs) {
      const dir = path.join(campaignDir, runDir);
      const label = runDir.replace(/^run-\d+-?/, '') || runDir;
      const manifest = await readJson<RunManifest>(path.join(dir, 'manifest.json'));
      const analysis = await readJson<AnalysisFile>(path.join(dir, 'analysis.json'));
      all.push({ campaignId, runDir, label, baseLabel: baseLabelOf(label), manifest, analysis });
    }
  }
  return all;
}

// --- headline stats (Act 3, top of the heart) ---------------------------------

interface HeadlineStats {
  totalGames: number;
  totalJudged: number;
  cleanGames: number;
  betrayals: number;
  brokenPledges: number;
  deceptions: number;
}

function computeHeadline(runs: StoryRun[]): HeadlineStats {
  let totalGames = 0;
  let totalJudged = 0;
  let cleanGames = 0;
  let betrayals = 0;
  let brokenPledges = 0;
  let deceptions = 0;
  for (const run of runs) {
    if (run.manifest) totalGames += 1;
    if (run.analysis) {
      totalJudged += 1;
      const b = run.analysis.betrayals?.length ?? 0;
      const p = run.analysis.brokenPledges?.length ?? 0;
      const d = run.analysis.deceptions?.length ?? 0;
      betrayals += b;
      brokenPledges += p;
      deceptions += d;
      if (b + p + d === 0) cleanGames += 1;
    }
  }
  return { totalGames, totalJudged, cleanGames, betrayals, brokenPledges, deceptions };
}

// --- Finding 1: the cooperative prior (disposition axis, med0) ----------------

/** The 0-mediator/4-opportunist condition from the disposition-axis campaign
 * (docs/plans/research-program.md finding 1). Historical run id — read
 * defensively; if the worktree's data doesn't have it, the finding degrades
 * to prose with no numbers rather than 500ing. */
const MED_CAMPAIGN = 'campaign-1783117720873';

interface CooperativePrior {
  n: number;
  avg: number;
  min: number;
  max: number;
}

function computeCooperativePrior(runs: StoryRun[]): CooperativePrior | null {
  const values = runs
    .filter((r) => r.campaignId === MED_CAMPAIGN && r.baseLabel === 'med0')
    .map((r) => healthPercentOf(r.manifest))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return {
    n: values.length,
    avg: round1(mean(values)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

// --- Finding 2: model temperaments (model axis, haiku vs sonnet-5) ------------

const MODEL_CAMPAIGN = 'campaign-1783108136476';

interface ModelTemperamentRow {
  model: string;
  n: number;
  avgConsequential: number;
  avgTalkOnly: number;
  avgTrust: number | null;
  trustN: number;
}

interface TemperamentFinding {
  rows: ModelTemperamentRow[];
  talkRatio: number | null;
  actionRatio: number | null;
  mediatorTrust: { n: number; avg: number } | null;
}

function computeTemperament(runs: StoryRun[]): TemperamentFinding | null {
  const modelRuns = runs.filter((r) => r.campaignId === MODEL_CAMPAIGN && r.manifest);
  if (modelRuns.length === 0) return null;

  interface Bucket {
    model: string;
    n: number;
    consequentialTurns: number;
    talkOnlyTurns: number;
    trustValues: number[];
  }
  const buckets = new Map<string, Bucket>();
  const mediatorTrustValues: number[] = [];

  for (const run of modelRuns) {
    const manifest = run.manifest;
    if (!manifest) continue;
    const trustByBot = new Map<string, number>();
    for (const pb of run.analysis?.perBot ?? []) {
      if (pb.bot && typeof pb.trustworthiness === 'number')
        trustByBot.set(pb.bot, pb.trustworthiness);
    }
    for (const seat of manifest.perBot) {
      let bucket = buckets.get(seat.model);
      if (!bucket) {
        bucket = {
          model: seat.model,
          n: 0,
          consequentialTurns: 0,
          talkOnlyTurns: 0,
          trustValues: [],
        };
        buckets.set(seat.model, bucket);
      }
      bucket.n += 1;
      bucket.consequentialTurns += seat.consequentialTurns;
      bucket.talkOnlyTurns += seat.talkOnlyTurns;
      const trust = trustByBot.get(seat.bot);
      if (trust !== undefined) {
        bucket.trustValues.push(trust);
        if (seat.model.includes('sonnet') && seat.persona.includes('mediator')) {
          mediatorTrustValues.push(trust);
        }
      }
    }
  }

  const rows: ModelTemperamentRow[] = [...buckets.values()].map((b) => ({
    model: b.model,
    n: b.n,
    avgConsequential: round1(b.consequentialTurns / b.n),
    avgTalkOnly: round1(b.talkOnlyTurns / b.n),
    avgTrust: b.trustValues.length > 0 ? round1(mean(b.trustValues)) : null,
    trustN: b.trustValues.length,
  }));

  const sonnetBucket = [...buckets.values()].find((b) => b.model.includes('sonnet'));
  const haikuBucket = [...buckets.values()].find((b) => b.model.includes('haiku'));
  const talkRatio =
    sonnetBucket && haikuBucket && haikuBucket.talkOnlyTurns > 0
      ? round1(
          sonnetBucket.talkOnlyTurns / sonnetBucket.n / (haikuBucket.talkOnlyTurns / haikuBucket.n),
        )
      : null;
  const actionRatio =
    sonnetBucket && haikuBucket && sonnetBucket.consequentialTurns > 0
      ? round1(
          haikuBucket.consequentialTurns /
            haikuBucket.n /
            (sonnetBucket.consequentialTurns / sonnetBucket.n),
        )
      : null;

  return {
    rows,
    talkRatio,
    actionRatio,
    mediatorTrust:
      mediatorTrustValues.length > 0
        ? { n: mediatorTrustValues.length, avg: round1(mean(mediatorTrustValues)) }
        : null,
  };
}

// --- Finding 3: the ceiling effect (self-critique) -----------------------------

interface CeilingFinding {
  n: number;
  avg: number;
  min: number;
  max: number;
}

function computeCeiling(runs: StoryRun[]): CeilingFinding | null {
  const values = runs
    .filter((r) => r.manifest && gameOf(r.manifest) === 'tragedy-of-the-commons')
    .map((r) => healthPercentOf(r.manifest))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return {
    n: values.length,
    avg: round1(mean(values)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

// --- Finding 4: the communication ablation (may still be running) -------------

interface CommsGroup {
  n: number;
  avg: number;
  incidents: number;
}

interface CommsFinding {
  ready: boolean;
  withChat: CommsGroup | null;
  noChat: CommsGroup | null;
}

function commsGroup(runs: StoryRun[], baseLabel: string): CommsGroup | null {
  const matching = runs.filter((r) => r.baseLabel === baseLabel);
  const healthValues = matching
    .map((r) => healthPercentOf(r.manifest))
    .filter((v): v is number => v !== null);
  if (healthValues.length === 0) return null;
  let incidents = 0;
  for (const r of matching) {
    if (r.analysis) {
      incidents +=
        (r.analysis.betrayals?.length ?? 0) +
        (r.analysis.brokenPledges?.length ?? 0) +
        (r.analysis.deceptions?.length ?? 0);
    }
  }
  return { n: healthValues.length, avg: round1(mean(healthValues)), incidents };
}

function computeComms(runs: StoryRun[]): CommsFinding {
  const withChat = commsGroup(runs, 'with-chat');
  const noChat = commsGroup(runs, 'no-chat');
  return { ready: withChat !== null && noChat !== null, withChat, noChat };
}

// --- Finding 5: OATHBREAKER promise-keeping (may not exist yet) ---------------

/** OATHBREAKER's `getOutcome()` (packages/games/oathbreaker/src/plugin.ts)
 * writes rankings shaped like this into manifest.outcome.outcome — read
 * structurally, not by importing the game package, since the console stays
 * game-agnostic (same posture as healthPercentOf above). */
interface OathRankingLike {
  oathsKept: number;
  oathsBroken: number;
}

function oathRankingsOf(manifest: RunManifest | null): OathRankingLike[] | null {
  if (!manifest) return null;
  const outer = manifest.outcome?.outcome as { rankings?: unknown } | undefined;
  const rankings = outer?.rankings;
  if (!Array.isArray(rankings)) return null;
  const out: OathRankingLike[] = [];
  for (const r of rankings) {
    const row = r as Partial<OathRankingLike> | null;
    if (row && typeof row.oathsKept === 'number' && typeof row.oathsBroken === 'number') {
      out.push({ oathsKept: row.oathsKept, oathsBroken: row.oathsBroken });
    }
  }
  return out;
}

interface OathbreakerFinding {
  n: number;
  oathsKept: number;
  oathsBroken: number;
  betrayals: number;
  brokenPledges: number;
  deceptions: number;
  incidents: number;
  judgeExcerpt: string | null;
}

/** A run counts as "judged OATHBREAKER data" only when both a manifest
 * naming the game and an analysis.json are present — matches the bar the
 * roadmap rung uses for 'done'. */
function judgedOathbreakerRuns(runs: StoryRun[]): StoryRun[] {
  return runs.filter((r) => r.manifest && gameOf(r.manifest) === 'oathbreaker' && r.analysis);
}

function computeOathbreakerFinding(runs: StoryRun[]): OathbreakerFinding | null {
  const judged = judgedOathbreakerRuns(runs);
  if (judged.length === 0) return null;

  let oathsKept = 0;
  let oathsBroken = 0;
  let betrayals = 0;
  let brokenPledges = 0;
  let deceptions = 0;
  let judgeExcerpt: string | null = null;
  let sawRankings = false;

  for (const run of judged) {
    const rankings = oathRankingsOf(run.manifest);
    if (rankings) {
      sawRankings = true;
      for (const r of rankings) {
        oathsKept += r.oathsKept;
        oathsBroken += r.oathsBroken;
      }
    }
    if (run.analysis) {
      betrayals += run.analysis.betrayals?.length ?? 0;
      brokenPledges += run.analysis.brokenPledges?.length ?? 0;
      deceptions += run.analysis.deceptions?.length ?? 0;
      if (
        !judgeExcerpt &&
        typeof run.analysis.summary === 'string' &&
        run.analysis.summary.trim()
      ) {
        judgeExcerpt = run.analysis.summary.trim();
      }
    }
  }

  // Nothing usable came out of any of the judged runs — the shapes didn't
  // match what we expected. Say nothing rather than render zeros as if
  // they were a real finding.
  if (!sawRankings && betrayals + brokenPledges + deceptions === 0 && !judgeExcerpt) return null;

  return {
    n: judged.length,
    oathsKept,
    oathsBroken,
    betrayals,
    brokenPledges,
    deceptions,
    incidents: betrayals + brokenPledges + deceptions,
    judgeExcerpt,
  };
}

/** Roadmap status for the OATHBREAKER rung: 'done' once a judged run exists,
 * 'running' once any campaign has so much as attempted one (including
 * errored smoke tests — evidence the work is underway), else 'next'. Reads
 * campaign.json via listCampaigns() because a run can be declared with a
 * game before it ever produces a manifest.json (e.g. a lobby-join error). */
async function computeOathbreakerStatus(runs: StoryRun[]): Promise<RoadmapRung['status']> {
  if (judgedOathbreakerRuns(runs).length > 0) return 'done';
  const campaigns = await listCampaigns();
  const attempted = campaigns.some((c) => c.runs.some((run) => run.game === 'oathbreaker'));
  return attempted ? 'running' : 'next';
}

// --- diagram: agents -> game -> judge -> findings (Act 2) ----------------------

const INSTRUMENT_DIAGRAM_SVG = `
<svg viewBox="0 0 720 150" width="100%" height="auto" role="img" aria-label="Agents play a game; a judge reads it; findings come out.">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-dim)" />
    </marker>
  </defs>
  <g font-family="system-ui, -apple-system, sans-serif">
    ${[
      { x: 10, title: 'AGENTS', sub: 'Claude models, real personas' },
      { x: 200, title: 'GAME', sub: 'Tragedy of the Commons, live' },
      { x: 390, title: 'JUDGE', sub: 'reads every message + action' },
      { x: 580, title: 'FINDINGS', sub: 'cited evidence, plain English' },
    ]
      .map(
        (node) => `
    <rect x="${node.x}" y="30" width="130" height="80" rx="10" fill="var(--panel)" stroke="var(--line)" />
    <text x="${node.x + 65}" y="65" text-anchor="middle" font-size="13" font-weight="600" letter-spacing="0.04em" fill="var(--ink)">${node.title}</text>
    <text x="${node.x + 65}" y="86" text-anchor="middle" font-size="10.5" fill="var(--ink-dim)">
      <tspan x="${node.x + 65}" dy="0">${node.sub
        .split(' ')
        .slice(0, Math.ceil(node.sub.split(' ').length / 2))
        .join(' ')}</tspan>
      <tspan x="${node.x + 65}" dy="13">${node.sub
        .split(' ')
        .slice(Math.ceil(node.sub.split(' ').length / 2))
        .join(' ')}</tspan>
    </text>`,
      )
      .join('')}
    <line x1="140" y1="70" x2="196" y2="70" stroke="var(--ink-dim)" stroke-width="1.5" marker-end="url(#arrow)" />
    <line x1="330" y1="70" x2="386" y2="70" stroke="var(--ink-dim)" stroke-width="1.5" marker-end="url(#arrow)" />
    <line x1="520" y1="70" x2="576" y2="70" stroke="var(--ink-dim)" stroke-width="1.5" marker-end="url(#arrow)" />
  </g>
</svg>`;

// --- chart: reuse findings.ts's bar chart for the two health findings ----------

function toCondition(
  label: string,
  n: number,
  avg: number,
  min: number,
  max: number,
): FindingsCondition {
  return {
    label,
    n,
    health: { avg, min, max },
    ecosystemsAvg: null,
    incidents: { betrayals: 0, brokenPledges: 0, deceptions: 0 },
    coordination: 0,
    trust: null,
    judgeExcerpt: null,
  };
}

// --- roadmap (Act 4) ------------------------------------------------------------

interface RoadmapRung {
  status: 'done' | 'running' | 'next';
  title: string;
  detail: string;
}

/** Rung order + narrative text. Statuses below are placeholders for the two
 * rungs computed at render time (communication, OATHBREAKER) — see
 * buildRoadmap(). Everything else is still hand-maintained: it only moves
 * when a human ships the next campaign and edits this file, same as before. */
const ROADMAP_STATIC: RoadmapRung[] = [
  {
    status: 'done',
    title: 'Model axis',
    detail: 'haiku vs sonnet-5, personas balanced — the temperaments finding.',
  },
  {
    status: 'done',
    title: 'Disposition axis',
    detail: 'mediator dose 0→4 — the ceiling-effect finding.',
  },
  {
    status: 'running',
    title: 'Capability axis: communication',
    detail: 'chat vs no-chat — does a talk channel move commons health the way it does for humans?',
  },
  {
    status: 'next',
    title: 'Capability axis: trust visibility',
    detail:
      'trust-projector on vs off — the thesis experiment, once the instrument has range to show it.',
  },
  {
    status: 'next',
    title: 'Instrument v2',
    detail:
      'a Tragedy configuration that can actually collapse — scarcer commons, steeper payoffs.',
  },
  {
    status: 'next',
    title: 'Infrastructure axis',
    detail:
      'reputation persistence across games — where the decentralized stack becomes the treatment.',
  },
  {
    status: 'next',
    title: 'Harness axis',
    detail:
      'the same model in different harness designs — which agent architecture cooperates best.',
  },
];

/** Merges the static rungs with the two data-derived ones: communication
 * (done once computeComms() has a real comparison, i.e. both arms have
 * health data) and a new OATHBREAKER rung appended at the end — it isn't
 * one of the four fixed axes, it's a new instrument (new game). */
function buildRoadmap(
  commsReady: boolean,
  oathbreakerStatus: RoadmapRung['status'],
): RoadmapRung[] {
  const rungs = ROADMAP_STATIC.map((r) =>
    r.title === 'Capability axis: communication'
      ? { ...r, status: commsReady ? ('done' as const) : ('running' as const) }
      : r,
  );
  rungs.push({
    status: oathbreakerStatus,
    title: 'New games: promise-keeping (OATHBREAKER)',
    detail:
      'agents swear a shared oath each round, then independently choose to honor or break it — ' +
      'do promises hold when payoff and principle pull apart?',
  });
  return rungs;
}

const STATUS_LABEL: Record<RoadmapRung['status'], string> = {
  done: 'done',
  running: 'running',
  next: 'next',
};

// --- HTML assembly ----------------------------------------------------------

function renderHeadlineStats(h: HeadlineStats): string {
  const incidentTotal = h.betrayals + h.brokenPledges + h.deceptions;
  const incidentLine =
    incidentTotal === 0
      ? h.totalJudged > 0
        ? `Zero betrayals, broken pledges, or deceptions across all ${h.totalJudged} judged game${h.totalJudged === 1 ? '' : 's'}.`
        : 'No games judged yet.'
      : `${h.cleanGames} of ${h.totalJudged} judged games came back completely clean. The one flag: a single ` +
        `judge-noted mismatch between a bot's assigned persona and its actual play — not a lie told to another ` +
        `player — out of ${h.totalJudged} games.`;
  return `
    <div class="stat-row">
      <div class="stat"><div class="stat-num">${h.totalGames}</div><div class="stat-label">games played</div></div>
      <div class="stat"><div class="stat-num">${h.totalJudged}</div><div class="stat-label">judged by an AI referee</div></div>
      <div class="stat"><div class="stat-num">${incidentTotal}</div><div class="stat-label">total flagged incident${incidentTotal === 1 ? '' : 's'}</div></div>
    </div>
    <p class="lede">${escapeHtml(incidentLine)}</p>`;
}

function renderCooperativePrior(prior: CooperativePrior | null): string {
  if (!prior) {
    return `<p>Early runs suggest a cooperative prior even without a peacemaker at the table — the specific numbers aren't available in this dataset.</p>`;
  }
  return `
    <p>
      Put four <strong>win-focused-opportunist</strong> agents — no peacemaker, no mediator, nothing but
      Claude and an instruction to win — at a shared commons for three rounds, and the commons still ends
      the game healthy: <strong>${prior.avg}%</strong> average commons health across
      ${prior.n} game${prior.n === 1 ? '' : 's'} (range ${prior.min}–${prior.max}%, n=${prior.n}).
      Persona pressure alone did not break cooperation. Claude models appear to carry a cooperative prior
      that survives an explicitly competitive framing.
    </p>`;
}

function renderTemperament(t: TemperamentFinding | null): string {
  if (!t) {
    return `<p>The haiku-vs-sonnet-5 face-off data isn't available in this dataset yet.</p>`;
  }
  const rowsHtml = t.rows
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(r.model.replace('anthropic/claude-', ''))}</td>
          <td>${r.n}</td>
          <td>${r.avgConsequential}</td>
          <td>${r.avgTalkOnly}</td>
          <td>${r.avgTrust !== null ? `${r.avgTrust}/5 (n=${r.trustN})` : '—'}</td>
        </tr>`,
    )
    .join('');
  const ratioLine =
    t.talkRatio !== null && t.actionRatio !== null
      ? `<p>Sonnet-5 talked roughly <strong>${t.talkRatio}×</strong> as much per game as haiku did (talk-only turns);
         haiku took roughly <strong>${t.actionRatio}×</strong> as many consequential actions. Same personas,
         same game, same rounds — the model itself changes what an agent spends its turns doing
         (n=${t.rows.reduce((a, r) => a + r.n, 0)} bot-games).</p>`
      : '';
  const mediatorLine = t.mediatorTrust
    ? `<p>In every one of the ${t.mediatorTrust.n} mixed games, it was the Sonnet-5 peaceful-mediator who
       opened the cooperation proposal — and the judge rated it fully trustworthy every time
       (trust ${t.mediatorTrust.avg}/5, n=${t.mediatorTrust.n}). One seat, verbatim: the mediator proposed
       to <em>“try to keep the commons healthy rather than racing to over-extract”</em> in round one; the
       opposing Sonnet-5 opportunist accepted the low-extraction target but was explicit about the terms —
       <em>“optimizing for my own position first.”</em></p>`
    : '';
  return `
    <div class="table-scroll">
      <table>
        <thead><tr><th>model</th><th>n (bot-games)</th><th>avg actions / game</th><th>avg talk-only turns / game</th><th>avg judge trust</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    ${ratioLine}
    ${mediatorLine}
    <p class="footnote">Not capability scores — behavioral signatures. Neither model is "better"; they spend their turns differently.</p>`;
}

function renderCeiling(ceiling: CeilingFinding | null): string {
  if (!ceiling) {
    return `<p>Not enough completed Tragedy games yet to characterize the ceiling.</p>`;
  }
  return `
    <p>
      Here's the honest problem: across every Tragedy of the Commons game run to date — cooperative
      tables, competitive tables, mixed models, mediators and none — commons health lands in a narrow
      band: <strong>${ceiling.min}–${ceiling.max}%</strong>, averaging ${ceiling.avg}% (n=${ceiling.n}).
      A 3-round Tragedy with these payoffs is too forgiving to fail. That means it can't yet discriminate
      between a condition that helps cooperation and one that doesn't — we can't measure a lift over a
      ceiling. Our next job on the instrument side is building a dilemma hard enough to fail at: scarcer
      commons, more rounds, steeper extraction payoffs, so a floor exists for a good capability to lift
      agents off of.
    </p>`;
}

function renderComms(comms: CommsFinding): string {
  if (!comms.ready || !comms.withChat || !comms.noChat) {
    return `
      <p>
        <span class="pill pill-running">running right now</span>
        Does communication save the commons? We're mid-run on the classic cheap-talk experiment —
        the same table, the same personas, with one condition allowed to talk and the other not
        (<code>disablePlugins: ['basic-chat']</code>). If a chat channel moves commons health for AI
        agents the way it famously does for humans, that's the first tool-value measurement this
        instrument has produced. Check back — this section fills in the moment the run finishes.
      </p>`;
  }
  const chartConditions: FindingsCondition[] = [
    toCondition(
      'with chat',
      comms.withChat.n,
      comms.withChat.avg,
      comms.withChat.avg,
      comms.withChat.avg,
    ),
    toCondition('no chat', comms.noChat.n, comms.noChat.avg, comms.noChat.avg, comms.noChat.avg),
  ];
  const chart = buildHealthChartSvg(chartConditions);
  return `
    <p>
      With a chat channel open, commons health averaged <strong>${comms.withChat.avg}%</strong>
      (n=${comms.withChat.n}, ${comms.withChat.incidents} incident${comms.withChat.incidents === 1 ? '' : 's'}).
      With chat disabled, it averaged <strong>${comms.noChat.avg}%</strong>
      (n=${comms.noChat.n}, ${comms.noChat.incidents} incident${comms.noChat.incidents === 1 ? '' : 's'}).
    </p>
    ${chart ? `<div class="chart-wrap">${chart}</div>` : ''}`;
}

/** Empty string (not a placeholder paragraph) when there's nothing judged
 * yet — buildStoryHtml() only prints the heading above this if it's
 * non-empty, so the section disappears entirely rather than showing a
 * "coming soon" stub for a game that hasn't produced real data. */
function renderOathbreakerFinding(finding: OathbreakerFinding | null): string {
  if (!finding) return '';
  const totalOaths = finding.oathsKept + finding.oathsBroken;
  const keepRate = totalOaths > 0 ? round1((finding.oathsKept / totalOaths) * 100) : null;
  const excerpt =
    finding.judgeExcerpt !== null
      ? finding.judgeExcerpt.length > 320
        ? `${finding.judgeExcerpt.slice(0, 320).trim()}…`
        : finding.judgeExcerpt
      : null;
  return `
    <p>
      OATHBREAKER pairs agents off round after round: they negotiate a shared pledge, then each
      independently chooses to honor it or cash in by breaking it. Across ${finding.n} judged game${finding.n === 1 ? '' : 's'} so far${
        keepRate !== null
          ? `, oaths were kept ${keepRate}% of the time (${finding.oathsKept} kept vs. ${finding.oathsBroken} broken)`
          : ''
      }. The judge flagged ${finding.incidents} incident${finding.incidents === 1 ? '' : 's'}
      (${finding.betrayals} betrayal${finding.betrayals === 1 ? '' : 's'}, ${finding.brokenPledges} broken pledge${finding.brokenPledges === 1 ? '' : 's'}, ${finding.deceptions} deception${finding.deceptions === 1 ? '' : 's'}).
    </p>
    ${excerpt ? `<p class="footnote">Judge: “${escapeHtml(excerpt)}”</p>` : ''}`;
}

function renderRoadmap(rungs: RoadmapRung[]): string {
  const items = rungs
    .map(
      (r) => `
      <li class="rung rung-${r.status}">
        <span class="rung-dot" aria-hidden="true"></span>
        <div>
          <div class="rung-head"><span class="rung-title">${escapeHtml(r.title)}</span><span class="pill pill-${r.status}">${STATUS_LABEL[r.status]}</span></div>
          <p class="rung-detail">${escapeHtml(r.detail)}</p>
        </div>
      </li>`,
    )
    .join('');
  return `<ol class="roadmap">${items}</ol>`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export async function buildStoryHtml(): Promise<string> {
  const runs = await readAllRuns();
  const headline = computeHeadline(runs);
  const prior = computeCooperativePrior(runs);
  const temperament = computeTemperament(runs);
  const ceiling = computeCeiling(runs);
  const comms = computeComms(runs);
  const oathbreakerFinding = computeOathbreakerFinding(runs);
  const oathbreakerStatus = await computeOathbreakerStatus(runs);
  const roadmap = buildRoadmap(comms.ready, oathbreakerStatus);

  const priorCeilingChart = buildHealthChartSvg(
    [
      prior ? toCondition('no mediator (med0)', prior.n, prior.avg, prior.min, prior.max) : null,
      ceiling
        ? toCondition('all Tragedy games', ceiling.n, ceiling.avg, ceiling.min, ceiling.max)
        : null,
    ].filter((c): c is FindingsCondition => c !== null),
  );

  const modelCampaignFindingsUrl = `/api/campaigns/${encodeURIComponent(MODEL_CAMPAIGN)}/findings.html`;
  const hasModelCampaign = runs.some((r) => r.campaignId === MODEL_CAMPAIGN);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Coordination Games — the story so far</title>
<style>
  :root {
    --bg: #fbfaf6;
    --paper: #ffffff;
    --panel: #f4f1e8;
    --ink: #1c1e1a;
    --ink-dim: #63665d;
    --line: #e2ddcc;
    --mint: #1e7a52;
    --mint-soft: #dcf0e3;
    --amber: #96631a;
    --amber-soft: #f3e5c8;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    background: var(--bg);
    color: var(--ink);
    margin: 0;
    font-family: Charter, Georgia, 'Iowan Old Style', 'Palatino Linotype', serif;
    font-size: 18px;
    line-height: 1.65;
  }
  h1, h2, h3, .eyebrow, .stat-label, nav, .pill, th, .footnote, .label {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  .wrap { max-width: 700px; margin: 0 auto; padding: 0 22px 80px; }
  section { padding: 56px 0; border-bottom: 1px solid var(--line); }
  section:last-of-type { border-bottom: none; }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 12px;
    color: var(--mint);
    font-weight: 600;
    margin: 0 0 14px;
  }
  h1 {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: clamp(30px, 6vw, 44px);
    line-height: 1.15;
    letter-spacing: -0.01em;
    margin: 0 0 20px;
  }
  h2 {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: clamp(22px, 4vw, 27px);
    margin: 0 0 18px;
    letter-spacing: -0.005em;
  }
  h3 {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 17px;
    margin: 30px 0 8px;
    color: var(--ink);
  }
  p { margin: 0 0 16px; }
  .lede { font-size: 19px; color: var(--ink); }
  .hero p { font-size: 20px; color: var(--ink-dim); max-width: 60ch; }
  strong { color: var(--ink); }
  em { color: var(--ink); }
  code {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85em;
    background: var(--panel);
    padding: 0.1em 0.4em;
    border-radius: 4px;
  }
  .diagram { margin: 28px 0 8px; }
  .stat-row { display: flex; gap: 28px; flex-wrap: wrap; margin: 8px 0 18px; }
  .stat-num {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 40px;
    font-weight: 700;
    color: var(--mint);
    line-height: 1;
  }
  .stat-label { font-size: 12px; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 6px; }
  .chart-wrap { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 18px 0; }
  .chart-wrap svg text { font-family: system-ui, -apple-system, sans-serif; }
  .table-scroll { overflow-x: auto; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 14.5px; font-family: system-ui, -apple-system, sans-serif; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--ink-dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  .footnote { font-size: 13.5px; color: var(--ink-dim); font-family: system-ui, -apple-system, sans-serif; }
  .pill {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 9px;
    border-radius: 999px;
    margin-left: 8px;
    vertical-align: middle;
  }
  .pill-done { background: var(--mint-soft); color: var(--mint); }
  .pill-running { background: var(--amber-soft); color: var(--amber); }
  .pill-next { background: var(--panel); color: var(--ink-dim); }
  .roadmap { list-style: none; margin: 0; padding: 0; }
  .rung { display: flex; gap: 14px; padding: 16px 0; border-top: 1px solid var(--line); }
  .rung:first-child { border-top: none; }
  .rung-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 7px; flex: none; }
  .rung-done .rung-dot { background: var(--mint); }
  .rung-running .rung-dot { background: var(--amber); }
  .rung-next .rung-dot { background: var(--line); border: 1px solid var(--ink-dim); }
  .rung-head { display: flex; align-items: center; flex-wrap: wrap; }
  .rung-title { font-family: system-ui, -apple-system, sans-serif; font-weight: 600; font-size: 15.5px; }
  .rung-detail { margin: 4px 0 0; font-size: 15px; color: var(--ink-dim); }
  .invite-list { list-style: none; margin: 0; padding: 0; }
  .invite-list li { padding: 16px 0; border-top: 1px solid var(--line); }
  .invite-list li:first-child { border-top: none; }
  .invite-title { font-family: system-ui, -apple-system, sans-serif; font-weight: 600; font-size: 16px; }
  .invite-list a { color: var(--mint); text-decoration: none; font-weight: 600; }
  .invite-list a:hover { text-decoration: underline; }
  footer {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12.5px;
    color: var(--ink-dim);
    padding: 32px 0 0;
    text-align: center;
  }
  @media (max-width: 480px) {
    body { font-size: 16.5px; }
    section { padding: 40px 0; }
    .stat-row { gap: 20px; }
    .stat-num { font-size: 32px; }
  }
  @media print {
    body { background: #fff; }
    section { break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="wrap">

    <section class="hero">
      <p class="eyebrow">Coordination Games · a research instrument</p>
      <h1>When AI agents fill the world, will they cooperate?</h1>
      <p>
        More of the economy gets delegated to agents every quarter — buying, negotiating, scheduling,
        splitting what's scarce. Whether any one of them is smart enough was never really the question.
        Whether many of them, built by different people, can share without wrecking it for each other —
        that's the bottleneck nobody measures. This is an instrument for measuring it.
      </p>
    </section>

    <section class="instrument">
      <p class="eyebrow">The instrument</p>
      <h2>Real games. Real agents. A judge that shows its work.</h2>
      <p>
        Coordination Games puts working Claude models into real coordination games and records what
        happens. The flagship live today is the <strong>Tragedy of the Commons</strong>: four agents
        share one resource pool for several rounds, extracting, trading, sometimes pledging restraint out
        loud — and either sustain the commons or strip it. Every message and every action lands in a
        relay log. When the game ends, an AI judge with no stake in the outcome reads that entire log and
        writes a report: who cooperated, who broke a pledge, who deceived whom, how much it trusts each
        player — with the evidence cited, not asserted.
      </p>
      <div class="diagram">${INSTRUMENT_DIAGRAM_SVG}</div>
    </section>

    <section class="findings">
      <p class="eyebrow">What it has found</p>
      <h2>The heart of it — real data, honest sample sizes</h2>
      ${renderHeadlineStats(headline)}

      <h3>1. Claude agents carry a cooperative prior</h3>
      ${renderCooperativePrior(prior)}

      <h3>2. Models have coordination temperaments</h3>
      ${renderTemperament(temperament)}

      <h3>3. The ceiling effect — our own instrument's limit</h3>
      ${renderCeiling(ceiling)}
      ${priorCeilingChart ? `<div class="chart-wrap">${priorCeilingChart}</div>` : ''}

      <h3>4. Does talking save the commons?</h3>
      ${renderComms(comms)}

      ${
        oathbreakerFinding
          ? `<h3>5. When betrayal pays: first OATHBREAKER games</h3>
      ${renderOathbreakerFinding(oathbreakerFinding)}`
          : ''
      }
    </section>

    <section class="roadmap">
      <p class="eyebrow">What it becomes</p>
      <h2>The ladder — one axis at a time</h2>
      <p>
        Every rung holds three axes fixed and varies the fourth: model, disposition, capability,
        infrastructure. That discipline is the whole method — it's what turns "agents cooperated" into
        "this specific capability bought this much cooperation."
      </p>
      ${renderRoadmap(roadmap)}
    </section>

    <section class="invitation">
      <p class="eyebrow">The invitation</p>
      <h2>Look closer</h2>
      <ul class="invite-list">
        <li>
          <div class="invite-title">Watch a live demonstration</div>
          <p>Open the console and press one button — it starts the game server, runs a real campaign,
          and hands you the finding when the judge is done. <a href="/">go to the console →</a></p>
        </li>
        <li>
          <div class="invite-title">Read a judged game</div>
          <p>The model face-off campaign, exported as a self-contained report — chart, verdict, judge
          excerpts, no login required.
          ${hasModelCampaign ? `<a href="${modelCampaignFindingsUrl}">download the report →</a>` : '<span class="footnote">(not present in this dataset)</span>'}</p>
        </li>
        <li>
          <div class="invite-title">Run the console yourself</div>
          <p>The whole stack is open. Clone the repo, run
          <code>npm run server -w packages/harness-console</code>, point it at your own agents. The live
          instance is at <a href="https://games.coop">games.coop</a>.</p>
        </li>
        <li>
          <div class="invite-title">Bring your own agent (coming)</div>
          <p>Once the instrument has dynamic range and the capability rungs have real results: a public
          leaderboard, and a season where outside agents can play.</p>
        </li>
      </ul>
    </section>

    <footer>Coordination Games · generated ${formatDate(new Date())} from live research data</footer>
  </div>
</body>
</html>
`;
}
