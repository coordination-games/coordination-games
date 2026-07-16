import type {
  AtprotoStrongRef,
  DidPlc,
  PromiseOutcome,
  PromiseOutcomeEvent,
  TrustProjectionResult,
} from '@coordination-games/trust';
import {
  createPromiseOutcomeAttestation,
  TRUST_ALGORITHM_VERSION,
  TRUST_EVENT_SCHEMA_VERSION,
  TRUST_PROJECTION_VERSION,
} from '@coordination-games/trust';
import { TRAGEDY_GAME_ID } from './types.js';

const RESOLUTION_VERSION = 'tragedy-promise-resolution/v1' as const;
const SETTLEMENT_COLLECTION = 'app.coordination-games.tragedy-settlement' as const;

type RecordValue = Readonly<Record<string, unknown>>;

export type TragedySettledPromiseResolution = Readonly<{
  readonly resolutionVersion: typeof RESOLUTION_VERSION;
  readonly visibility: 'public';
  readonly gameId: string;
  readonly sequence: number;
  readonly actorPlayerId: string;
  readonly subjectPlayerId: string;
  readonly outcome: PromiseOutcome;
  readonly observedAt: string;
  readonly evidence: AtprotoStrongRef;
}>;

export type TragedyPromiseOutcomeInput = Readonly<{
  readonly gameType: typeof TRAGEDY_GAME_ID;
  readonly didByPlayerId: Readonly<Record<string, DidPlc>>;
  readonly resolutions: readonly TragedySettledPromiseResolution[];
}>;

type TragedyPromiseOutcomeRejected = Readonly<{
  readonly kind: 'rejected';
  readonly reason:
    | 'ambiguous-or-private-resolution'
    | 'invalid-input'
    | 'invalid-event'
    | 'missing-did-mapping';
}>;

export type TragedyPromiseOutcomeMapping =
  | Readonly<{ readonly kind: 'mapped'; readonly events: readonly PromiseOutcomeEvent[] }>
  | TragedyPromiseOutcomeRejected;

export type TragedyPromiseTrustProjection =
  | Readonly<{ readonly kind: 'projected'; readonly result: TrustProjectionResult }>
  | Readonly<{
      readonly kind: 'rejected';
      readonly reason: 'event-identity-collision' | 'invalid-event' | 'subject-drift';
    }>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSettlementEvidence(
  evidence: unknown,
  gameId: string,
  sequence: number,
): evidence is AtprotoStrongRef {
  return (
    isRecord(evidence) &&
    hasOnlyKeys(evidence, ['uri', 'cid']) &&
    typeof evidence.uri === 'string' &&
    evidence.uri.includes(`/${SETTLEMENT_COLLECTION}/`) &&
    evidence.uri.endsWith(`/${gameId}-${sequence}`) &&
    typeof evidence.cid === 'string'
  );
}

function reject(reason: TragedyPromiseOutcomeRejected['reason']): TragedyPromiseOutcomeRejected {
  return { kind: 'rejected', reason };
}

function parseResolution(
  value: unknown,
): TragedySettledPromiseResolution | TragedyPromiseOutcomeMapping {
  if (!isRecord(value)) return reject('invalid-input');
  const sequence = value.sequence;
  if (
    !hasOnlyKeys(value, [
      'resolutionVersion',
      'visibility',
      'gameId',
      'sequence',
      'actorPlayerId',
      'subjectPlayerId',
      'outcome',
      'observedAt',
      'evidence',
    ]) ||
    value.resolutionVersion !== RESOLUTION_VERSION ||
    !isNonEmptyString(value.gameId) ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !isNonEmptyString(value.actorPlayerId) ||
    !isNonEmptyString(value.subjectPlayerId) ||
    !isNonEmptyString(value.observedAt)
  ) {
    return reject('invalid-input');
  }
  if (value.visibility !== 'public' || (value.outcome !== 'kept' && value.outcome !== 'broken')) {
    return reject('ambiguous-or-private-resolution');
  }
  if (!isSettlementEvidence(value.evidence, value.gameId, sequence)) {
    return reject('invalid-input');
  }
  return {
    resolutionVersion: RESOLUTION_VERSION,
    visibility: 'public',
    gameId: value.gameId,
    sequence,
    actorPlayerId: value.actorPlayerId,
    subjectPlayerId: value.subjectPlayerId,
    outcome: value.outcome,
    observedAt: value.observedAt,
    evidence: value.evidence,
  };
}

export function mapSettledTragedyPromiseOutcomes(input: unknown): TragedyPromiseOutcomeMapping {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['gameType', 'didByPlayerId', 'resolutions']) ||
    input.gameType !== TRAGEDY_GAME_ID ||
    !isRecord(input.didByPlayerId) ||
    !Array.isArray(input.resolutions)
  ) {
    return reject('invalid-input');
  }
  const events: PromiseOutcomeEvent[] = [];
  for (const candidate of input.resolutions) {
    const resolution = parseResolution(candidate);
    if ('kind' in resolution) return resolution;
    const actorDid = input.didByPlayerId[resolution.actorPlayerId];
    const subjectDid = input.didByPlayerId[resolution.subjectPlayerId];
    if (!isNonEmptyString(actorDid) || !isNonEmptyString(subjectDid))
      return reject('missing-did-mapping');
    const created = createPromiseOutcomeAttestation({
      eventVersion: TRUST_EVENT_SCHEMA_VERSION,
      schemaVersion: 'trust-schema/v1',
      algorithmVersion: TRUST_ALGORITHM_VERSION,
      actorDid,
      subjectDid,
      outcome: resolution.outcome,
      gameId: resolution.gameId,
      sequence: resolution.sequence,
      evidence: resolution.evidence,
      observedAt: resolution.observedAt,
    });
    if (created.kind === 'rejected') return reject('invalid-event');
    events.push(created.attestation.event);
  }
  return { kind: 'mapped', events };
}

export function projectTragedyPromiseTrust(input: {
  readonly subjectDid: DidPlc;
  readonly events: readonly PromiseOutcomeEvent[];
}): TragedyPromiseTrustProjection {
  const canonical = new Map<
    string,
    { readonly digest: string; readonly event: PromiseOutcomeEvent }
  >();
  for (const candidate of input.events) {
    const created = createPromiseOutcomeAttestation(candidate);
    if (created.kind === 'rejected') return { kind: 'rejected', reason: 'invalid-event' };
    const event = created.attestation.event;
    if (event.subjectDid !== input.subjectDid) return { kind: 'rejected', reason: 'subject-drift' };
    const prior = canonical.get(created.attestation.eventIdentity);
    if (prior !== undefined && prior.digest !== created.attestation.eventDigest) {
      return { kind: 'rejected', reason: 'event-identity-collision' };
    }
    canonical.set(created.attestation.eventIdentity, {
      digest: created.attestation.eventDigest,
      event,
    });
  }
  const events = [...canonical.values()]
    .sort(
      (left, right) =>
        left.event.gameId.localeCompare(right.event.gameId) ||
        left.event.sequence - right.event.sequence,
    )
    .map((entry) => entry.event);
  let kept = 0;
  let broken = 0;
  for (const event of events) {
    if (event.outcome === 'kept') kept += 1;
    else broken += 1;
  }
  const total = kept + broken;
  return {
    kind: 'projected',
    result: {
      projectionVersion: TRUST_PROJECTION_VERSION,
      eventSchemaVersion: TRUST_EVENT_SCHEMA_VERSION,
      algorithmVersion: TRUST_ALGORITHM_VERSION,
      subjectDid: input.subjectDid,
      outcomes: { kept, broken },
      reliability:
        total === 0
          ? { representation: 'unavailable' }
          : { representation: 'ratio', value: kept / total },
    },
  };
}
