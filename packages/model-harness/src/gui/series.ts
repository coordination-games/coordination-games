/**
 * Private-safe series inspection — surfaces the Todo 9 series artifacts the
 * console may show: series-manifest.json, resolved-config.json, per-game
 * manifest.json, and errors.jsonl. games/N/bots/*.jsonl are the ONLY files
 * carrying DM bodies and are never read (or previewable) here.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { ARTIFACT_ROOTS, type BoundedRoot, resolvePathId } from './paths.js';
import { redactText } from './redact.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_GAMES = 64;
const MAX_ERRORS = 50;
const MAX_STANDINGS = 64;

export interface SeriesSeat {
  bot: string;
  persona: string;
  model: string;
  provider: string;
}

export interface SeriesStanding {
  playerId: string;
  rank?: number;
}

export interface SeriesGameProgress {
  gameIndex: number;
  gameId: string | null;
  outcome: { phase?: string; winnerLabel?: string };
  standings: SeriesStanding[];
  relayCount: number | null;
}

export interface SeriesIssue {
  name: string;
  message: string;
}

export interface SeriesAudit {
  id: string;
  kind: 'tournament';
  status: string;
  gameIds: string[];
  seriesLength: number | null;
  standings: SeriesStanding[];
  usage: Record<string, number>;
  seats: SeriesSeat[];
  games: SeriesGameProgress[];
  errors: SeriesIssue[];
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Absent, oversized, or unparsable files are a null value on this surface. */
async function readJsonCapped(abs: string): Promise<unknown> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return null;
  }
  if (stat.size > MAX_JSON_BYTES) return null;
  try {
    return JSON.parse(await fsp.readFile(abs, 'utf8'));
  } catch {
    return null;
  }
}

function parseStandings(value: unknown): SeriesStanding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_STANDINGS).flatMap((entry) => {
    const standing = rec(entry);
    const playerId = standing ? str(standing.playerId) : null;
    if (!playerId) return [];
    const rank = standing ? num(standing.rank) : null;
    return [{ playerId, ...(rank !== null ? { rank } : {}) }];
  });
}

function parseOutcome(value: unknown): SeriesGameProgress['outcome'] {
  const outcome = rec(value);
  const phase = outcome ? str(outcome.phase) : null;
  const winnerLabel = outcome ? str(outcome.winnerLabel) : null;
  return { ...(phase ? { phase } : {}), ...(winnerLabel ? { winnerLabel } : {}) };
}

function parseUsage(value: unknown): Record<string, number> {
  const usage = rec(value);
  if (!usage) return {};
  return Object.fromEntries(
    Object.entries(usage).filter((entry): entry is [string, number] => num(entry[1]) !== null),
  );
}

function parseSeats(value: unknown): SeriesSeat[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_STANDINGS).flatMap((entry) => {
    const seat = rec(entry);
    if (!seat) return [];
    const modelConfig = rec(seat.modelConfig);
    return [
      {
        bot: str(seat.bot) ?? '(unknown)',
        persona: path.basename(str(seat.persona) ?? '(unknown)'),
        model: str(seat.model) ?? '(unknown)',
        provider:
          (modelConfig ? str(modelConfig.provider) : null) ?? str(seat.backend) ?? '(unknown)',
      },
    ];
  });
}

async function readGames(abs: string): Promise<SeriesGameProgress[]> {
  let names: string[];
  try {
    names = await fsp.readdir(path.join(abs, 'games'));
  } catch {
    return [];
  }
  const indexes = names
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b)
    .slice(0, MAX_GAMES);
  const games: SeriesGameProgress[] = [];
  for (const index of indexes) {
    const manifest = rec(
      await readJsonCapped(path.join(abs, 'games', String(index), 'manifest.json')),
    );
    if (!manifest) continue;
    games.push({
      gameIndex: num(manifest.gameIndex) ?? index,
      gameId: str(manifest.gameId),
      outcome: parseOutcome(manifest.outcome),
      standings: parseStandings(manifest.standings),
      relayCount: num(manifest.relayCount),
    });
  }
  return games;
}

async function readErrors(abs: string): Promise<SeriesIssue[]> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return [];
  }
  if (stat.size > MAX_JSON_BYTES) return [];
  const text = await fsp.readFile(abs, 'utf8');
  const issues: SeriesIssue[] = [];
  for (const line of text.split('\n')) {
    if (issues.length >= MAX_ERRORS) break;
    if (!line.trim()) continue;
    try {
      const parsed = rec(JSON.parse(line));
      if (!parsed) continue;
      issues.push({
        name: str(parsed.name) ?? 'Error',
        message: redactText(str(parsed.message) ?? ''),
      });
    } catch {
      // torn tail line during a live append — skip
    }
  }
  return issues;
}

/**
 * Audit one artifact dir as a tournament series. Returns null when the dir has
 * no series-manifest.json (an ordinary single-run dir).
 */
export async function inspectSeries(
  id: string,
  roots: readonly BoundedRoot[] = ARTIFACT_ROOTS,
): Promise<SeriesAudit | null> {
  const { abs } = await resolvePathId(id, roots);
  const manifest = rec(await readJsonCapped(path.join(abs, 'series-manifest.json')));
  if (!manifest) return null;
  const config = rec(await readJsonCapped(path.join(abs, 'resolved-config.json')));
  const policy = rec(rec(config?.tournament)?.policy);
  const gameIds = Array.isArray(manifest.gameIds)
    ? manifest.gameIds.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    id,
    kind: 'tournament',
    status: str(manifest.status) ?? 'unknown',
    gameIds,
    seriesLength: policy ? num(policy.seriesLength) : null,
    standings: parseStandings(manifest.standings),
    usage: parseUsage(manifest.usage),
    seats: parseSeats(config?.seats),
    games: await readGames(abs),
    errors: await readErrors(path.join(abs, 'errors.jsonl')),
  };
}
