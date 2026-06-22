/**
 * Spec parser and seat expansion for the Unified Model Harness.
 *
 * loadCampaign(path) → CampaignRun[]: parses a YAML (or JSON) spec file in the
 * single `{ globals?, games[] }` format, validates the scope partition, applies
 * defaults, and flattens `repeats` into one CampaignRun per run.
 *
 * expandSeatPlan(spec) → SeatPlan[]: cycles personas across seat counts and
 * resolves backend via backendForModel. Identity minting (wallet creation/pool
 * lookup) is the orchestrator's responsibility — this layer only produces the
 * logical seat plan without private keys.
 *
 * Reference: docs/plans/unified-model-harness.md §6, §7, §12.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type Backend,
  backendForModel,
  type CampaignRun,
  type RunLimits,
  type RunSpec,
  type SeatSpec,
} from './types.js';

// ---------------------------------------------------------------------------
// Defaults (§6 / §12 locked decisions)
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS: RunLimits = {
  maxModelCallsPerBot: 80,
  wallClockMsPerRun: 600_000, // 10 minutes
};

const DEFAULT_SERVER = process.env.GAME_SERVER ?? 'http://localhost:8787';

// ---------------------------------------------------------------------------
// loadSpec
// ---------------------------------------------------------------------------

/**
 * Load a spec file → the list of runs it describes. ONE format:
 *
 *   globals?: { server, identities, output, limits, analysis }   # campaign-wide
 *   games:    [ { game, rounds, params, seats, repeats?, label? }, ... ]
 *
 * Scope is a STRICT PARTITION: every field lives in exactly one section, and a
 * misplaced field is a hard error (the payoff of no-overrides — we can tell you
 * exactly where a field belongs). A single run is just a one-entry `games` list;
 * there is no separate flat shape.
 */
export async function loadCampaign(filePath: string): Promise<CampaignRun[]> {
  const { obj, abs } = await readYamlObject(filePath);

  if (!('games' in obj)) {
    throw new Error(
      `spec at ${abs}: missing "games". A spec is { globals?, games: [...] } — ` +
        'a single run is just one entry in "games".',
    );
  }

  const globals = parseGlobals(obj.globals, abs);
  const rawGames = obj.games;
  if (!Array.isArray(rawGames) || rawGames.length === 0) {
    throw new Error(`spec at ${abs}: "games" must be a non-empty array`);
  }

  const runs: CampaignRun[] = [];
  const labelCounts = new Map<string, number>();

  rawGames.forEach((entry: unknown, idx: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`spec at ${abs}: games[${idx}] must be an object`);
    }
    const g = entry as Record<string, unknown>;
    assertKeysAllowed(g, GAME_KEYS, `games[${idx}]`, abs);

    // Strict partition: globals (campaign-wide) + entry (per-game). No key is in
    // both, so this is a partition merge, not an override.
    const merged: Record<string, unknown> = { ...globals, ...g };
    const spec = parseRunSpecObject(merged, abs);

    // Label: explicit `label:` else the game slug; de-dupe (same game twice).
    let baseLabel = typeof g.label === 'string' && g.label.trim() ? g.label.trim() : spec.game;
    const seen = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, seen);
    if (seen > 1) baseLabel = `${baseLabel}-${seen}`;

    const repeats = parseRepeats(g.repeats, idx, abs);
    for (let r = 1; r <= repeats; r++) {
      const label = repeats > 1 ? `${baseLabel}-r${r}` : baseLabel;
      runs.push({ spec: { ...spec, label }, baseLabel, repeatIndex: r, repeatTotal: repeats });
    }
  });

  return runs;
}

// ---------------------------------------------------------------------------
// Internal parse machinery (shared by loadSpec + loadCampaign)
// ---------------------------------------------------------------------------

/** Campaign scope partition — the single source of truth for which field lives where. */
const GLOBAL_KEYS = ['server', 'identities', 'output', 'limits', 'analysis'] as const;
const GAME_KEYS = [
  'game',
  'rounds',
  'params',
  'seats',
  'repeats',
  'label',
  'disablePlugins',
] as const;

async function readYamlObject(
  filePath: string,
): Promise<{ obj: Record<string, unknown>; abs: string }> {
  const abs = path.resolve(filePath);
  const raw = await fs.readFile(abs, 'utf8');
  // yaml.parse handles both YAML and JSON (JSON is valid YAML).
  const data: unknown = parseYaml(raw);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`spec at ${abs}: expected a YAML/JSON object at root`);
  }
  return { obj: data as Record<string, unknown>, abs };
}

/** Parse a plain object into a validated, defaulted RunSpec. */
function parseRunSpecObject(obj: Record<string, unknown>, abs: string): RunSpec {
  const game = requireString(obj, 'game', abs);
  const rounds = requirePositiveInt(obj, 'rounds', abs);
  const seats = requireSeats(obj, abs);

  const server: string =
    typeof obj.server === 'string' && obj.server.trim() ? obj.server.trim() : DEFAULT_SERVER;
  const identities: RunSpec['identities'] = obj.identities === 'pool' ? 'pool' : 'ephemeral';
  const output: string =
    typeof obj.output === 'string' && obj.output.trim() ? obj.output.trim() : './runs/out';
  const params: Record<string, unknown> =
    typeof obj.params === 'object' && obj.params !== null && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {};
  const limits: RunLimits = parseRunLimits(obj.limits);
  const analysis = parseAnalysis(obj.analysis);
  const disablePlugins =
    Array.isArray(obj.disablePlugins) && obj.disablePlugins.every((p) => typeof p === 'string')
      ? (obj.disablePlugins as string[])
      : undefined;

  return {
    game,
    rounds,
    params,
    server,
    identities,
    output,
    seats,
    limits,
    ...(analysis ? { analysis } : {}),
    ...(disablePlugins ? { disablePlugins } : {}),
  };
}

function assertKeysAllowed(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  abs: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `campaign at ${abs}: "${key}" is not allowed in ${where} — allowed here: ${allowed.join(', ')}. ` +
          `Campaign scope is a strict partition (globals vs per-game); this field likely belongs in the other section.`,
      );
    }
  }
}

function parseGlobals(raw: unknown, abs: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`campaign at ${abs}: "globals" must be an object`);
  }
  const g = raw as Record<string, unknown>;
  assertKeysAllowed(g, GLOBAL_KEYS, 'globals', abs);
  return g;
}

function parseRepeats(raw: unknown, idx: number, abs: string): number {
  if (raw === undefined) return 1;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `campaign at ${abs}: games[${idx}].repeats must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Seat plan expansion (without identity / wallet resolution)
// ---------------------------------------------------------------------------

export interface SeatPlan {
  /** Which persona directory path to load (as specified in spec). */
  persona: string;
  /** Backend-specific model id. */
  model: string;
  /** Resolved backend. */
  backend: Backend;
  /** 1-based seat index across all expanded seats. */
  seatIndex: number;
}

/**
 * Expand the spec's `seats` array into a flat list of concrete seat plans.
 * Personas cycle if `count > 1`. Backend is derived from the model string via
 * backendForModel. No wallets / private keys — that is the orchestrator's job.
 *
 * @param spec - A parsed RunSpec (from loadSpec).
 * @returns Ordered list of seat plans (one per bot slot in the lobby).
 */
export function expandSeatPlan(spec: RunSpec): SeatPlan[] {
  const plans: SeatPlan[] = [];
  let globalIndex = 1;

  for (const seatSpec of spec.seats) {
    const count = seatSpec.count ?? 1;
    for (let i = 0; i < count; i++) {
      plans.push({
        persona: seatSpec.persona,
        model: seatSpec.model,
        backend: backendForModel(seatSpec.model),
        seatIndex: globalIndex++,
      });
    }
  }

  return plans;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function requireString(obj: Record<string, unknown>, key: string, filePath: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`run-spec at ${filePath}: missing or empty required field "${key}"`);
  }
  return val.trim();
}

function requirePositiveInt(obj: Record<string, unknown>, key: string, filePath: string): number {
  const val = obj[key];
  if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
    throw new Error(
      `run-spec at ${filePath}: "${key}" must be a positive integer, got ${JSON.stringify(val)}`,
    );
  }
  return val;
}

function requireSeats(obj: Record<string, unknown>, filePath: string): SeatSpec[] {
  const raw = obj.seats;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`run-spec at ${filePath}: "seats" must be a non-empty array`);
  }
  return raw.map((entry: unknown, idx: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`run-spec at ${filePath}: seats[${idx}] must be an object`);
    }
    const s = entry as Record<string, unknown>;

    if (typeof s.persona !== 'string' || !(s.persona as string).trim()) {
      throw new Error(`run-spec at ${filePath}: seats[${idx}].persona is required`);
    }
    if (typeof s.model !== 'string' || !(s.model as string).trim()) {
      throw new Error(`run-spec at ${filePath}: seats[${idx}].model is required`);
    }

    const count =
      typeof s.count === 'number' && Number.isInteger(s.count) && (s.count as number) > 0
        ? (s.count as number)
        : 1;

    return {
      persona: (s.persona as string).trim(),
      model: (s.model as string).trim(),
      count,
    } satisfies SeatSpec;
  });
}

function parseRunLimits(raw: unknown): RunLimits {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_LIMITS };
  }
  const obj = raw as Record<string, unknown>;
  const maxModelCallsPerBot =
    typeof obj.maxModelCallsPerBot === 'number' && obj.maxModelCallsPerBot > 0
      ? (obj.maxModelCallsPerBot as number)
      : DEFAULT_LIMITS.maxModelCallsPerBot;
  const wallClockMsPerRun =
    typeof obj.wallClockMsPerRun === 'number' && obj.wallClockMsPerRun > 0
      ? (obj.wallClockMsPerRun as number)
      : DEFAULT_LIMITS.wallClockMsPerRun;
  return { maxModelCallsPerBot, wallClockMsPerRun };
}

function parseAnalysis(raw: unknown): RunSpec['analysis'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled !== false; // default true if object present
  const model =
    typeof obj.model === 'string' && obj.model.trim()
      ? obj.model.trim()
      : 'anthropic/claude-sonnet';
  return { enabled, model };
}
