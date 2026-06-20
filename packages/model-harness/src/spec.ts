/**
 * Spec parser and seat expansion for the Unified Model Harness.
 *
 * loadSpec(path) → RunSpec: parses a YAML (or JSON) run-spec file, validates
 * required fields, and applies defaults.
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
 * Parse a YAML or JSON run-spec file. Applies defaults for optional fields.
 * Throws with a clear message if required fields are missing or invalid.
 *
 * @param filePath - Absolute or relative path to the run-spec YAML/JSON file.
 * @returns Validated, defaulted RunSpec.
 */
export async function loadSpec(filePath: string): Promise<RunSpec> {
  const abs = path.resolve(filePath);
  const raw = await fs.readFile(abs, 'utf8');
  // yaml.parse handles both YAML and JSON (JSON is valid YAML).
  const data: unknown = parseYaml(raw);

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`run-spec at ${abs}: expected a YAML/JSON object at root`);
  }
  const obj = data as Record<string, unknown>;

  // --- Required fields ---
  const game = requireString(obj, 'game', abs);
  const rounds = requirePositiveInt(obj, 'rounds', abs);
  const seats = requireSeats(obj, abs);

  // --- Optional fields with defaults ---
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

  const spec: RunSpec = {
    game,
    rounds,
    params,
    server,
    identities,
    output,
    seats,
    limits,
    ...(analysis ? { analysis } : {}),
  };

  return spec;
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
  const lenses =
    Array.isArray(obj.lenses) && obj.lenses.every((l) => typeof l === 'string')
      ? (obj.lenses as string[])
      : undefined;
  return { enabled, model, ...(lenses ? { lenses } : {}) };
}
