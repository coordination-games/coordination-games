/**
 * Run/campaign inspection — parses `campaign.json`, `manifest.json`,
 * `analysis.json` and counts `relay.jsonl` / `bots/*.jsonl` events for the
 * audit surface. Every read is size-capped, every string redacted, and every
 * parse failure is RECORDED (surfaced as provenance) rather than thrown.
 */

import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ARTIFACT_ROOTS, type BoundedRoot, displayPath, resolvePathId } from './paths.js';
import { redactText, redactValue } from './redact.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_JSONL_LINES = 200_000;
const MAX_PREVIEW_BYTES = 128 * 1024;
const ALLOWED_PREVIEW_RE =
  /^(campaign\.json|manifest\.json|analysis\.json|relay\.jsonl|bots\/[A-Za-z0-9._-]+\.jsonl)$/;

export interface ParseIssue {
  file: string;
  message: string;
}

export interface JsonlCount {
  file: string;
  lines: number;
  truncated: boolean;
}

export interface SeatSummary {
  bot: string;
  persona: string;
  model: string;
  backend: string;
}

export interface RunAudit {
  id: string;
  name: string;
  path: string;
  modifiedAt: string;
  identifiers: {
    runId: string | null;
    lobbyId: string | null;
    gameId: string | null;
    game: string | null;
    label: string | null;
  };
  seats: SeatSummary[];
  outcome: { phase: string | null; winnerLabel: string | null; round: number | null } | null;
  relay: JsonlCount | null;
  bots: JsonlCount[];
  analysis: { present: boolean; sections: Record<string, number> } | null;
  campaign: unknown;
  errors: ParseIssue[];
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v ? v : null;
}

function num(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

async function readJsonCapped(abs: string, errors: ParseIssue[], label: string): Promise<unknown> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return null; // absent file is a normal state, not an issue
  }
  if (stat.size > MAX_JSON_BYTES) {
    errors.push({
      file: label,
      message: `file exceeds the ${MAX_JSON_BYTES / 1024 / 1024} MiB parse cap`,
    });
    return null;
  }
  try {
    return JSON.parse(await fsp.readFile(abs, 'utf8'));
  } catch (err) {
    errors.push({
      file: label,
      message: redactText(err instanceof Error ? err.message : String(err)),
    });
    return null;
  }
}

async function countJsonl(
  abs: string,
  label: string,
  errors: ParseIssue[],
): Promise<JsonlCount | null> {
  try {
    await fsp.access(abs);
  } catch {
    return null;
  }
  try {
    const rl = readline.createInterface({ input: createReadStream(abs, { encoding: 'utf8' }) });
    let lines = 0;
    let truncated = false;
    for await (const line of rl) {
      if (line.trim() === '') continue;
      lines++;
      if (lines >= MAX_JSONL_LINES) {
        truncated = true;
        rl.close();
        break;
      }
    }
    return { file: label, lines, truncated };
  } catch (err) {
    errors.push({
      file: label,
      message: redactText(err instanceof Error ? err.message : String(err)),
    });
    return null;
  }
}

function seatSummaries(manifest: Record<string, unknown>): SeatSummary[] {
  const seats = manifest.seats;
  if (!Array.isArray(seats)) return [];
  return seats.slice(0, 64).flatMap((raw) => {
    const seat = rec(raw);
    if (!seat) return [];
    return [
      {
        bot: str(seat, 'bot') ?? '(unknown)',
        persona: path.basename(str(seat, 'persona') ?? '(unknown)'),
        model: str(seat, 'model') ?? '(unknown)',
        backend: str(seat, 'backend') ?? '(unknown)',
      },
    ];
  });
}

function analysisSections(analysis: Record<string, unknown>): Record<string, number> {
  const sections: Record<string, number> = {};
  for (const [key, value] of Object.entries(analysis)) {
    if (Array.isArray(value)) sections[key] = value.length;
  }
  return sections;
}

/** Full audit of one artifact dir (run dir or campaign dir). */
export async function inspectArtifact(
  id: string,
  roots: readonly BoundedRoot[] = ARTIFACT_ROOTS,
): Promise<RunAudit> {
  const { abs } = await resolvePathId(id, roots);
  const stat = await fsp.stat(abs);
  if (!stat.isDirectory()) throw new Error('artifact id must point at a directory');
  const errors: ParseIssue[] = [];

  const campaignRaw = await readJsonCapped(
    path.join(abs, 'campaign.json'),
    errors,
    'campaign.json',
  );
  const manifestRaw = rec(
    await readJsonCapped(path.join(abs, 'manifest.json'), errors, 'manifest.json'),
  );
  const analysisRaw = rec(
    await readJsonCapped(path.join(abs, 'analysis.json'), errors, 'analysis.json'),
  );
  const relay = await countJsonl(path.join(abs, 'relay.jsonl'), 'relay.jsonl', errors);

  const bots: JsonlCount[] = [];
  try {
    const names = (await fsp.readdir(path.join(abs, 'bots')))
      .filter((n) => n.endsWith('.jsonl'))
      .sort();
    for (const name of names.slice(0, 64)) {
      const count = await countJsonl(path.join(abs, 'bots', name), `bots/${name}`, errors);
      if (count) bots.push(count);
    }
  } catch {
    // no bots/ dir — normal for campaign dirs and dry runs
  }

  const spec = manifestRaw ? rec(manifestRaw.spec) : null;
  const outcome = manifestRaw ? rec(manifestRaw.outcome) : null;

  return {
    id,
    name: path.basename(abs),
    path: displayPath(abs),
    modifiedAt: stat.mtime.toISOString(),
    identifiers: {
      runId: manifestRaw ? str(manifestRaw, 'runId') : null,
      lobbyId: manifestRaw ? str(manifestRaw, 'lobbyId') : null,
      gameId: manifestRaw ? str(manifestRaw, 'gameId') : null,
      game: spec ? str(spec, 'game') : null,
      label: spec ? str(spec, 'label') : null,
    },
    seats: manifestRaw ? seatSummaries(manifestRaw) : [],
    outcome: outcome
      ? {
          phase: str(outcome, 'phase'),
          winnerLabel: str(outcome, 'winnerLabel') ?? str(outcome, 'winnerHandle'),
          round: num(outcome, 'round'),
        }
      : null,
    relay,
    bots,
    analysis: analysisRaw ? { present: true, sections: analysisSections(analysisRaw) } : null,
    campaign: campaignRaw ? redactValue(campaignRaw) : null,
    errors,
  };
}

export interface FilePreview {
  id: string;
  file: string;
  text: string;
  truncated: boolean;
}

/** Redacted, size-capped preview of one whitelisted artifact file. */
export async function previewArtifactFile(
  id: string,
  file: string,
  roots: readonly BoundedRoot[] = ARTIFACT_ROOTS,
): Promise<FilePreview> {
  if (!ALLOWED_PREVIEW_RE.test(file)) throw new Error('file is not previewable');
  const { decoded } = await resolvePathId(id, roots);
  const { abs: fileAbs } = await resolvePathId(`${decoded.root.key}:${decoded.rel}/${file}`, roots);
  const fh = await fsp.open(fileAbs, 'r');
  try {
    const buf = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const truncated = bytesRead > MAX_PREVIEW_BYTES;
    const text = redactText(
      buf.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES)).toString('utf8'),
    );
    return { id, file, text, truncated };
  } finally {
    await fh.close();
  }
}
