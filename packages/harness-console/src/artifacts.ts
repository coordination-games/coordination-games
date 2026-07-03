/**
 * Read layer over runs/out/** — the disk is the source of truth.
 *
 * Shapes come from packages/model-harness (buildOutcome in orchestrate.ts,
 * AnalysisReport in analyze.ts, TranscriptEvent in types.ts, CampaignRunSummary
 * in index.ts). The committed examples/sample-run-totc uses STALE shapes —
 * everything here targets what the current harness writes.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { assertSafeId, HttpError, OUTPUT_DIR } from './paths.js';

// --- shapes the harness writes (mirrored, structurally tolerant) -------------

export interface CampaignRunSummary {
  label: string;
  game: string;
  /** 'ok'|'error' come from the harness's campaign.json; 'running'|'incomplete'
   * are console-synthesized for manifest-less run dirs (live vs interrupted). */
  status: 'ok' | 'error' | 'running' | 'incomplete';
  runDir?: string;
  lobbyId?: string;
  gameId?: string;
  analysis?: boolean;
  outcome?: RunOutcome | null;
  error?: string;
}

export interface RunOutcome {
  phase?: string;
  round?: number;
  isFinished?: boolean;
  winnerLabel?: string | null;
  statusVariant?: string | null;
  outcome?: unknown;
  summary?: unknown;
}

export interface ManifestSeat {
  bot: string;
  persona: string;
  model: string;
  backend: string;
}

export interface ManifestPerBot extends ManifestSeat {
  modelCalls: number;
  consequentialTurns: number;
  talkOnlyTurns: number;
  finished: boolean;
  reason: string;
}

export interface RunManifest {
  runId: string;
  spec: Record<string, unknown>;
  lobbyId?: string;
  gameId?: string;
  seats: ManifestSeat[];
  outcome?: RunOutcome | null;
  perBot: ManifestPerBot[];
}

export interface CampaignInfo {
  id: string;
  /** campaign.json exists — the sweep has finished writing its index. */
  complete: boolean;
  total: number;
  startedAt: number | null;
  runs: CampaignRunSummary[];
}

export interface RunInfo {
  campaignId: string;
  runId: string;
  manifest: RunManifest | null;
  bots: string[];
  hasAnalysis: boolean;
  hasRelay: boolean;
}

// --- helpers -----------------------------------------------------------------

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function parseJsonl(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Torn tail line of a live file — skip; the tail poll picks it up next time.
    }
  }
  return out;
}

function campaignStartedAt(id: string): number | null {
  const m = /^campaign-(\d+)$/.exec(id);
  const ts = m?.[1] ? Number(m[1]) : Number.NaN;
  return Number.isFinite(ts) ? ts : null;
}

function runDirPath(campaignId: string, runId: string): string {
  assertSafeId(campaignId, 'campaign id');
  assertSafeId(runId, 'run id');
  return path.join(OUTPUT_DIR, campaignId, runId);
}

// --- listing -----------------------------------------------------------------

export async function listCampaigns(activeIds?: Set<string>): Promise<CampaignInfo[]> {
  let entries: string[] = [];
  try {
    const dirents = await fsp.readdir(OUTPUT_DIR, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory() && d.name.startsWith('campaign-'))
      .map((d) => d.name);
  } catch {
    return [];
  }

  const campaigns = await Promise.all(
    entries.map(async (id): Promise<CampaignInfo> => {
      const dir = path.join(OUTPUT_DIR, id);
      const index = await readJson<{ total?: number; runs?: CampaignRunSummary[] }>(
        path.join(dir, 'campaign.json'),
      );
      if (index?.runs) {
        return {
          id,
          complete: true,
          total: index.total ?? index.runs.length,
          startedAt: campaignStartedAt(id),
          runs: index.runs,
        };
      }
      // In-flight (or interrupted) campaign: synthesize summaries from run dirs.
      const runs = await listRunDirsAsSummaries(dir, activeIds?.has(id) ?? false);
      return { id, complete: false, total: runs.length, startedAt: campaignStartedAt(id), runs };
    }),
  );

  return campaigns.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

async function listRunDirsAsSummaries(
  campaignDir: string,
  live: boolean,
): Promise<CampaignRunSummary[]> {
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
    dirents.map(async (runDir): Promise<CampaignRunSummary> => {
      const manifest = await readJson<RunManifest>(path.join(campaignDir, runDir, 'manifest.json'));
      const label = runDir.replace(/^run-\d+-?/, '') || runDir;
      if (!manifest) return { label, game: '?', status: live ? 'running' : 'incomplete', runDir };
      const summary: CampaignRunSummary = {
        label,
        game: String((manifest.spec as { game?: unknown }).game ?? '?'),
        status: 'ok',
        runDir,
        analysis: await exists(path.join(campaignDir, runDir, 'analysis.json')),
        outcome: manifest.outcome ?? null,
      };
      if (manifest.lobbyId) summary.lobbyId = manifest.lobbyId;
      if (manifest.gameId) summary.gameId = manifest.gameId;
      return summary;
    }),
  );
}

// --- single run --------------------------------------------------------------

export async function readRun(campaignId: string, runId: string): Promise<RunInfo> {
  const dir = runDirPath(campaignId, runId);
  if (!(await exists(dir))) throw new HttpError(404, `run not found: ${campaignId}/${runId}`);
  const manifest = await readJson<RunManifest>(path.join(dir, 'manifest.json'));
  let bots: string[] = [];
  try {
    bots = (await fsp.readdir(path.join(dir, 'bots')))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort();
  } catch {
    // No transcripts yet.
  }
  return {
    campaignId,
    runId,
    manifest,
    bots,
    hasAnalysis: await exists(path.join(dir, 'analysis.json')),
    hasRelay: await exists(path.join(dir, 'relay.jsonl')),
  };
}

export async function readAnalysis(campaignId: string, runId: string): Promise<unknown> {
  const file = path.join(runDirPath(campaignId, runId), 'analysis.json');
  const parsed = await readJson<unknown>(file);
  if (parsed === null) throw new HttpError(404, 'analysis.json not found (or unreadable)');
  return parsed;
}

export async function readRelay(campaignId: string, runId: string): Promise<unknown[]> {
  const file = path.join(runDirPath(campaignId, runId), 'relay.jsonl');
  try {
    return parseJsonl(await fsp.readFile(file, 'utf8'));
  } catch {
    throw new HttpError(404, 'relay.jsonl not found');
  }
}

export interface TranscriptPage {
  events: unknown[];
  /** Pass back as ?offset= to poll for new events (line offset, not bytes). */
  nextOffset: number;
}

export async function readTranscript(
  campaignId: string,
  runId: string,
  bot: string,
  offset: number,
): Promise<TranscriptPage> {
  assertSafeId(bot, 'bot name');
  const file = path.join(runDirPath(campaignId, runId), 'bots', `${bot}.jsonl`);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw new HttpError(404, `transcript not found for bot ${bot}`);
  }
  const all = parseJsonl(raw);
  const from = Math.max(0, Math.min(offset, all.length));
  return { events: all.slice(from), nextOffset: all.length };
}

// --- cross-run aggregation (the model A/B view) --------------------------------

export interface ModelAggregate {
  model: string;
  backend: string;
  seats: number;
  runs: number;
  wins: number;
  finished: number;
  consequentialTurns: number;
  talkOnlyTurns: number;
  /** Mean judge trustworthiness (1-5) across analyzed seats, null if none. */
  avgTrustworthiness: number | null;
  trustSamples: number;
}

interface AnalysisPerBot {
  bot?: string;
  trustworthiness?: number;
}

export async function aggregateModels(): Promise<ModelAggregate[]> {
  const campaigns = await listCampaigns();
  const byModel = new Map<string, ModelAggregate & { trustTotal: number }>();

  for (const campaign of campaigns) {
    for (const run of campaign.runs) {
      if (run.status !== 'ok' || !run.runDir) continue;
      const dir = path.join(OUTPUT_DIR, campaign.id, run.runDir);
      const manifest = await readJson<RunManifest>(path.join(dir, 'manifest.json'));
      if (!manifest?.perBot?.length) continue;
      const analysis = await readJson<{ perBot?: AnalysisPerBot[] }>(
        path.join(dir, 'analysis.json'),
      );
      const trustByBot = new Map<string, number>();
      for (const pb of analysis?.perBot ?? []) {
        if (pb.bot && typeof pb.trustworthiness === 'number') {
          trustByBot.set(pb.bot, pb.trustworthiness);
        }
      }
      const winnerLabel = manifest.outcome?.winnerLabel ?? null;
      const modelsInRun = new Set<string>();
      for (const seat of manifest.perBot) {
        let agg = byModel.get(seat.model);
        if (!agg) {
          agg = {
            model: seat.model,
            backend: seat.backend,
            seats: 0,
            runs: 0,
            wins: 0,
            finished: 0,
            consequentialTurns: 0,
            talkOnlyTurns: 0,
            avgTrustworthiness: null,
            trustSamples: 0,
            trustTotal: 0,
          };
          byModel.set(seat.model, agg);
        }
        agg.seats += 1;
        if (!modelsInRun.has(seat.model)) {
          agg.runs += 1;
          modelsInRun.add(seat.model);
        }
        // winnerLabel is a display label; count a win when it names this bot.
        // (Team-label winners won't string-match a bot — acceptable v1 caveat.)
        if (winnerLabel && winnerLabel === seat.bot) agg.wins += 1;
        if (seat.finished) agg.finished += 1;
        agg.consequentialTurns += seat.consequentialTurns ?? 0;
        agg.talkOnlyTurns += seat.talkOnlyTurns ?? 0;
        const trust = trustByBot.get(seat.bot);
        if (trust !== undefined) {
          agg.trustTotal += trust;
          agg.trustSamples += 1;
        }
      }
    }
  }

  return [...byModel.values()]
    .map(({ trustTotal, ...agg }) => ({
      ...agg,
      avgTrustworthiness:
        agg.trustSamples > 0 ? Math.round((trustTotal / agg.trustSamples) * 100) / 100 : null,
    }))
    .sort((a, b) => b.wins - a.wins || b.consequentialTurns - a.consequentialTurns);
}
