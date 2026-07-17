import { type NamedModelProfiles, resolveModelProfile } from './model-profiles.js';
import type { SeatSpec } from './types.js';

const SEAT_KEYS = ['persona', 'model', 'profile', 'count', 'overrides'] as const;

export function parseSeats(
  raw: unknown,
  filePath: string,
  profiles: NamedModelProfiles | undefined,
  seatLocation: string,
): SeatSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`run-spec at ${filePath}: "seats" must be a non-empty array`);
  }
  return raw.map((entry, index) => parseSeat(entry, index, filePath, profiles, seatLocation));
}

function parseSeat(
  entry: unknown,
  index: number,
  filePath: string,
  profiles: NamedModelProfiles | undefined,
  seatLocation: string,
): SeatSpec {
  const where = `${seatLocation}.seats[${index}]`;
  if (!isRecord(entry)) throw new Error(`run-spec at ${filePath}: ${where} must be an object`);
  assertKeys(entry, where, filePath);
  const persona = requiredString(entry.persona, `${where}.persona`, filePath);
  const model = optionalString(entry.model);
  const profile = optionalString(entry.profile);
  if (model && profile)
    throw new Error(
      `run-spec at ${filePath}: ${where} must specify exactly one of model or profile`,
    );
  if (!model && !profile)
    throw new Error(`run-spec at ${filePath}: ${where} must specify model or profile`);
  const count =
    entry.count === undefined ? 1 : positiveInt(entry.count, `${where}.count`, filePath);
  if (profile) {
    if (!profiles)
      throw new Error(`run-spec at ${filePath}: ${where}.profile requires root models`);
    if (entry.overrides !== undefined && !isRecord(entry.overrides)) {
      throw new Error(`run-spec at ${filePath}: ${where}.overrides must be an object`);
    }
    const modelConfig = resolveModelProfile(profiles, profile, entry.overrides ?? {}, where);
    return { persona, profile, model: modelConfig.model, count, modelConfig };
  }
  if (!model) throw new Error(`run-spec at ${filePath}: ${where}.model is required`);
  if (entry.overrides !== undefined)
    throw new Error(`run-spec at ${filePath}: ${where}.overrides requires profile`);
  return { persona, model, count };
}

function assertKeys(value: Record<string, unknown>, where: string, filePath: string): void {
  for (const key of Object.keys(value)) {
    if (!(SEAT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`campaign at ${filePath}: "${key}" is not allowed in ${where}`);
    }
  }
}

function requiredString(value: unknown, where: string, filePath: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`run-spec at ${filePath}: ${where} is required`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown, where: string, filePath: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`run-spec at ${filePath}: ${where} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
