/**
 * Canonical spec summary for the console — the ONLY parser is the harness's own
 * loadCampaign, so what the console shows is exactly what a real run would use.
 * Tournament entries are detected via isTournamentRun; ordinary specs stay
 * standard. Parse failures are classified, redacted, and length-bounded — never
 * thrown at the caller (except id-containment / non-YAML, which are guard errors).
 */

import path from 'node:path';
import type { ResolvedModelProfile } from '../model-profile-types.js';
import { loadCampaign } from '../spec.js';
import type { TragedySeriesTournamentRequest } from '../tournament-types.js';
import { isTournamentRun } from '../tournament-types.js';
import { backendForModel, type CampaignRun, type RunLimits, type SeatSpec } from '../types.js';
import { type BoundedRoot, resolvePathId, SPEC_ROOTS } from './paths.js';
import { redactText } from './redact.js';

const SPEC_EXT_RE = /\.(ya?ml)$/i;
const MAX_FAILURE_MESSAGE = 500;

/** Non-secret resolved tuning/reliability values — never apiKeyEnv/baseUrl/pricing. */
export interface SummarySeatSettings {
  readonly temperature: number | null;
  readonly topP: number | null;
  readonly maxCompletionTokens: number | null;
  readonly reasoningSplit: boolean | null;
  readonly reasoningEffort: string | null;
  readonly timeoutMs: number | null;
  readonly retries: number | null;
}

export interface SummarySeat {
  readonly persona: string;
  readonly count: number;
  readonly provider: string;
  readonly model: string;
  readonly profile: string | null;
  readonly settings: SummarySeatSettings | null;
}

export interface SummaryEntry {
  readonly label: string;
  readonly game: string;
  readonly kind: 'standard' | 'tournament';
  readonly rounds: number;
  readonly repeats: number;
  readonly seats: SummarySeat[];
  readonly maxModelSessions: number;
  readonly tournament: TragedySeriesTournamentRequest | null;
}

export interface SummaryTotals {
  readonly entries: number;
  readonly totalRuns: number;
  readonly maxModelSessions: number;
}

export interface SpecSummaryOk {
  readonly ok: true;
  readonly id: string;
  readonly name: string;
  readonly identities: 'ephemeral' | 'pool';
  readonly limits: RunLimits;
  readonly entries: SummaryEntry[];
  readonly totals: SummaryTotals;
}

export interface SpecSummaryFailure {
  readonly ok: false;
  readonly id: string;
  readonly name: string;
  readonly failure: {
    readonly kind: 'invalid-spec';
    readonly message: string;
    readonly truncated: boolean;
  };
}

export type SpecSummary = SpecSummaryOk | SpecSummaryFailure;

/** Resolve + syntactically validate a spec id against the given roots (guard errors throw). */
async function resolveSpecId(
  id: string,
  roots: readonly BoundedRoot[],
): Promise<{ abs: string; name: string }> {
  const { abs, decoded } = await resolvePathId(id, roots);
  if (!SPEC_EXT_RE.test(abs)) throw new Error('spec must be a .yaml/.yml file');
  return { abs, name: decoded.rel };
}

function seatSettings(config: ResolvedModelProfile): SummarySeatSettings {
  return {
    temperature: config.temperature ?? null,
    topP: config.topP ?? null,
    maxCompletionTokens: config.maxCompletionTokens ?? null,
    reasoningSplit: config.reasoningSplit ?? null,
    reasoningEffort: config.reasoningEffort ?? null,
    timeoutMs: config.timeoutMs ?? null,
    retries: config.retries ?? null,
  };
}

function summarizeSeat(seat: SeatSpec): SummarySeat {
  return {
    persona: path.basename(seat.persona),
    count: seat.count ?? 1,
    provider: seat.modelConfig?.provider ?? backendForModel(seat.model),
    model: seat.modelConfig?.model ?? seat.model,
    profile: seat.profile ?? null,
    settings: seat.modelConfig ? seatSettings(seat.modelConfig) : null,
  };
}

function summarizeEntry(baseLabel: string, group: readonly CampaignRun[]): SummaryEntry {
  const spec = group[0]?.spec;
  if (!spec) throw new Error('empty campaign group');
  const repeats = group[0]?.repeatTotal ?? group.length;
  const seatCount = spec.seats.reduce((total, seat) => total + (seat.count ?? 1), 0);
  const tournament = isTournamentRun(spec) ? spec.tournament : null;
  const maxModelSessions = tournament
    ? repeats * tournament.policy.seriesLength * seatCount
    : repeats * seatCount;
  return {
    label: baseLabel,
    game: spec.game,
    kind: tournament ? 'tournament' : 'standard',
    rounds: spec.rounds,
    repeats,
    seats: spec.seats.map(summarizeSeat),
    maxModelSessions,
    tournament,
  };
}

function groupByLabel(runs: readonly CampaignRun[]): SummaryEntry[] {
  const byLabel = new Map<string, CampaignRun[]>();
  for (const run of runs) {
    const group = byLabel.get(run.baseLabel);
    if (group) group.push(run);
    else byLabel.set(run.baseLabel, [run]);
  }
  return [...byLabel].map(([label, group]) => summarizeEntry(label, group));
}

function classifyFailure(err: unknown): SpecSummaryFailure['failure'] {
  const raw = redactText(err instanceof Error ? err.message : String(err));
  const truncated = raw.length > MAX_FAILURE_MESSAGE;
  return {
    kind: 'invalid-spec',
    message: truncated ? raw.slice(0, MAX_FAILURE_MESSAGE) : raw,
    truncated,
  };
}

/**
 * Summarize one spec via the canonical loadCampaign parser. Containment / non-YAML
 * ids reject (guard errors); a spec that parses is echoed truthfully; a spec that
 * fails to parse becomes a classified, redacted, bounded failure.
 */
export async function summarizeSpec(
  id: string,
  roots: readonly BoundedRoot[] = SPEC_ROOTS,
): Promise<SpecSummary> {
  const { abs, name } = await resolveSpecId(id, roots);
  let runs: CampaignRun[];
  try {
    runs = await loadCampaign(abs);
  } catch (err) {
    return { ok: false, id, name, failure: classifyFailure(err) };
  }
  const entries = groupByLabel(runs);
  const first = runs[0]?.spec;
  return {
    ok: true,
    id,
    name,
    identities: first?.identities ?? 'ephemeral',
    limits: first?.limits ?? { maxModelCallsPerBot: 0, wallClockMsPerRun: 0 },
    entries,
    totals: {
      entries: entries.length,
      totalRuns: runs.length,
      maxModelSessions: entries.reduce((total, entry) => total + entry.maxModelSessions, 0),
    },
  };
}
