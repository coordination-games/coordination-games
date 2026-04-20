/**
 * Relay type validation registry (Phase 4.2).
 *
 * Plugins declare a Zod schema for each `RelayEnvelope.type` they emit. The
 * inbound publish path (`DOStorageRelayClient.publish`) calls
 * `validateRelay(env)` before persisting; on success it returns a branded
 * `ValidatedRelayEnvelope<T>` whose `data` has been parsed/coerced by Zod, on
 * failure it throws.
 *
 * Registry policy:
 *   - One schema per `type` string, registered ONCE at boot.
 *   - Re-registering the same `type` (same plugin re-init or two plugins
 *     claiming the same name) throws — collisions are loud, not silent.
 *   - Unregistered types thrown as `RelayUnknownTypeError`. Plugins MUST
 *     declare a schema for every type they publish (failsafe — see plan
 *     Phase 4.2 "Loud failure > silent drift").
 *   - `clearRelayRegistry()` is the only escape hatch and exists for tests
 *     and plugin teardown.
 */

import type { ZodType } from 'zod';
import type { RelayEnvelope } from './types.js';

// ---------------------------------------------------------------------------
// Branded validated envelope — narrows the type without changing wire shape
// ---------------------------------------------------------------------------

declare const validatedBrand: unique symbol;

/**
 * A `RelayEnvelope` whose `data` has been parsed against the schema
 * registered for its `type`. The brand is a phantom field — there is no
 * runtime cost — but it forces consumers that want a "validated" envelope to
 * go through `validateRelay`.
 */
export type ValidatedRelayEnvelope<T = unknown> = RelayEnvelope<T> & {
  readonly [validatedBrand]: true;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when no schema is registered for an envelope's `type`. */
export class RelayUnknownTypeError extends Error {
  constructor(public readonly type: string) {
    super(`Unknown relay type: ${type}`);
    this.name = 'RelayUnknownTypeError';
  }
}

/** Thrown when an envelope's `data` fails its registered Zod schema. */
export class RelayValidationError extends Error {
  constructor(
    public readonly type: string,
    public readonly zodIssues: unknown,
  ) {
    super(`Relay validation failed for ${type}`);
    this.name = 'RelayValidationError';
  }
}

// ---------------------------------------------------------------------------
// Registry — module-global singleton (matches `registry.ts` for games)
// ---------------------------------------------------------------------------

const schemas = new Map<string, ZodType>();

/** Register a Zod schema for a relay envelope `type`. Throws on collision. */
export function registerRelayType(type: string, schema: ZodType): void {
  if (schemas.has(type)) {
    throw new Error(`Relay type collision at registration: ${type}`);
  }
  schemas.set(type, schema);
}

/** True if a schema is registered for `type`. */
export function isRelayTypeRegistered(type: string): boolean {
  return schemas.has(type);
}

/**
 * Validate an inbound `RelayEnvelope` against its registered schema.
 * Returns a NEW envelope (not the input) with `data` replaced by the parsed
 * (and possibly coerced) value, branded `ValidatedRelayEnvelope<T>`.
 *
 * Throws `RelayUnknownTypeError` if no schema is registered for `env.type`,
 * or `RelayValidationError` if the body fails parsing.
 */
export function validateRelay<T = unknown>(env: RelayEnvelope): ValidatedRelayEnvelope<T> {
  const schema = schemas.get(env.type);
  if (!schema) throw new RelayUnknownTypeError(env.type);
  const result = schema.safeParse(env.data);
  if (!result.success) throw new RelayValidationError(env.type, result.error.issues);
  // Return a NEW object with the parsed/coerced data — don't mutate input.
  return { ...env, data: result.data as T } as ValidatedRelayEnvelope<T>;
}

/**
 * Validate just the `(type, data)` body without requiring a full envelope.
 * Used at the publish entry point where `index` and `timestamp` are not yet
 * assigned. Returns the parsed `data`. Throws on unknown type or invalid body.
 */
export function validateRelayBody<T = unknown>(type: string, data: unknown): T {
  const schema = schemas.get(type);
  if (!schema) throw new RelayUnknownTypeError(type);
  const result = schema.safeParse(data);
  if (!result.success) throw new RelayValidationError(type, result.error.issues);
  return result.data as T;
}

/**
 * Walk a plugin's `relayTypes` map and register each schema.
 *
 * Idempotent for the *same schema reference*: the basic-chat module
 * self-registers at import time AND the CLI's PluginLoader.register also
 * walks `plugin.relayTypes`; both call-sites pass the same `Record` object,
 * so the second call is a no-op. A second plugin (or a re-export with a
 * fresh schema object) claiming the same `type` throws — that's the
 * boot-time collision check.
 */
export function registerPluginRelayTypes(plugin: {
  id: string;
  relayTypes?: Record<string, ZodType>;
}): void {
  if (!plugin.relayTypes) return;
  for (const [type, schema] of Object.entries(plugin.relayTypes)) {
    const existing = schemas.get(type);
    if (existing === schema) continue; // identical re-registration — fine
    if (existing) {
      throw new Error(`Relay type collision at registration: ${type}`);
    }
    schemas.set(type, schema);
  }
}

/** Reset the registry. For tests + plugin teardown only. */
export function clearRelayRegistry(): void {
  schemas.clear();
}
