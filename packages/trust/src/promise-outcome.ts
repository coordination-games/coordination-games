import { AbiCoder, isHexString, keccak256, solidityPacked } from 'ethers';
import type { AtprotoStrongRef, DidPlc, PromiseOutcomeEvent } from './index.js';
import {
  TRUST_ALGORITHM_VERSION,
  TRUST_EVENT_SCHEMA_VERSION,
  TRUST_SCHEMA_VERSION,
} from './index.js';
import {
  type Bytes32,
  type DecodedPromiseOutcomeResult,
  type HexData,
  PROMISE_OUTCOME_ATTESTATION_VERSION,
  PROMISE_OUTCOME_EAS_SCHEMA,
  type PromiseOutcomeAttestation,
  type PromiseOutcomeCode,
  type PromiseOutcomeCreationResult,
  type PromiseOutcomeRejected,
} from './promise-outcome-types.js';

const CODER = AbiCoder.defaultAbiCoder();
const EVENT_TYPES = [
  'string',
  'string',
  'uint8',
  'string',
  'uint64',
  'string',
  'string',
  'uint64',
  'string',
  'string',
  'string',
] as const;

type ObjectValue = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: ObjectValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isDidPlc(value: unknown): value is DidPlc {
  return typeof value === 'string' && /^did:plc:[a-z2-7]{24}$/.test(value);
}

function isStrongRef(value: unknown): value is AtprotoStrongRef {
  return (
    isObject(value) &&
    hasOnlyKeys(value, ['uri', 'cid']) &&
    typeof value.uri === 'string' &&
    /^at:\/\/did:plc:[a-z2-7]{24}\/[a-z][a-z0-9.-]*\/[A-Za-z0-9._~:-]+$/.test(value.uri) &&
    typeof value.cid === 'string' &&
    /^b[a-z2-7]{20,}$/.test(value.cid)
  );
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isBytes32(value: unknown): value is Bytes32 {
  return typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
}

function isHexData(value: unknown): value is HexData {
  return typeof value === 'string' && isHexString(value);
}

function parseEvent(input: unknown): PromiseOutcomeEvent | null {
  if (
    !isObject(input) ||
    !hasOnlyKeys(input, [
      'eventVersion',
      'schemaVersion',
      'algorithmVersion',
      'actorDid',
      'subjectDid',
      'outcome',
      'gameId',
      'sequence',
      'evidence',
      'observedAt',
    ]) ||
    input.eventVersion !== TRUST_EVENT_SCHEMA_VERSION ||
    input.schemaVersion !== TRUST_SCHEMA_VERSION ||
    input.algorithmVersion !== TRUST_ALGORITHM_VERSION ||
    !isDidPlc(input.actorDid) ||
    !isDidPlc(input.subjectDid) ||
    (input.outcome !== 'kept' && input.outcome !== 'broken') ||
    typeof input.gameId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.gameId) ||
    typeof input.sequence !== 'number' ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    !isStrongRef(input.evidence) ||
    !isInstant(input.observedAt)
  ) {
    return null;
  }
  return {
    eventVersion: TRUST_EVENT_SCHEMA_VERSION,
    schemaVersion: TRUST_SCHEMA_VERSION,
    algorithmVersion: TRUST_ALGORITHM_VERSION,
    actorDid: input.actorDid,
    subjectDid: input.subjectDid,
    outcome: input.outcome,
    gameId: input.gameId,
    sequence: input.sequence,
    evidence: input.evidence,
    observedAt: input.observedAt,
  };
}

function outcomeCode(outcome: PromiseOutcomeEvent['outcome']): PromiseOutcomeCode {
  return outcome === 'kept' ? 1 : 2;
}

function createRejected(): PromiseOutcomeRejected {
  return { kind: 'rejected', reason: 'invalid-event' };
}

function eventValues(event: PromiseOutcomeEvent): readonly (string | number)[] {
  return [
    event.actorDid,
    event.subjectDid,
    outcomeCode(event.outcome),
    event.gameId,
    event.sequence,
    event.evidence.uri,
    event.evidence.cid,
    Date.parse(event.observedAt),
    event.eventVersion,
    event.schemaVersion,
    event.algorithmVersion,
  ];
}

function hashBytes32(value: string): Bytes32 | null {
  const digest = keccak256(value);
  return isBytes32(digest) ? digest : null;
}

export function getPromiseOutcomeSchemaUid(resolver: string, revocable: boolean): Bytes32 {
  const digest = hashBytes32(
    solidityPacked(
      ['string', 'address', 'bool'],
      [PROMISE_OUTCOME_EAS_SCHEMA, resolver, revocable],
    ),
  );
  if (digest === null) throw new TypeError('Unable to derive EAS schema UID');
  return digest;
}

export function createPromiseOutcomeAttestation(input: unknown): PromiseOutcomeCreationResult {
  const event = parseEvent(input);
  if (event === null) return createRejected();
  const encodedPublic = CODER.encode(EVENT_TYPES, eventValues(event));
  const eventDigest = hashBytes32(encodedPublic);
  const eventIdentity = hashBytes32(
    CODER.encode(['string', 'uint64'], [event.gameId, event.sequence]),
  );
  if (eventDigest === null || eventIdentity === null || !isHexData(encodedPublic))
    return createRejected();
  const encodedData = CODER.encode(
    [...EVENT_TYPES, 'bytes32'],
    [...eventValues(event), eventDigest],
  );
  if (!isHexData(encodedData)) return createRejected();
  const attestation: PromiseOutcomeAttestation = {
    attestationVersion: PROMISE_OUTCOME_ATTESTATION_VERSION,
    event,
    outcomeCode: outcomeCode(event.outcome),
    eventIdentity,
    eventDigest,
    encodedData,
  };
  return { kind: 'created', attestation };
}

export function decodePromiseOutcomeEasData(data: unknown): DecodedPromiseOutcomeResult {
  if (!isHexData(data)) return { kind: 'rejected', reason: 'invalid-data' };
  let decoded: ReturnType<typeof CODER.decode>;
  try {
    decoded = CODER.decode([...EVENT_TYPES, 'bytes32'], data);
  } catch (error) {
    if (error instanceof Error) return { kind: 'rejected', reason: 'invalid-data' };
    throw error;
  }
  const event = parseEvent({
    actorDid: decoded[0],
    subjectDid: decoded[1],
    outcome: decoded[2] === 1n ? 'kept' : decoded[2] === 2n ? 'broken' : 'invalid',
    gameId: decoded[3],
    sequence: typeof decoded[4] === 'bigint' ? Number(decoded[4]) : decoded[4],
    evidence: { uri: decoded[5], cid: decoded[6] },
    observedAt:
      typeof decoded[7] === 'bigint' && decoded[7] <= BigInt(Number.MAX_SAFE_INTEGER)
        ? new Date(Number(decoded[7])).toISOString()
        : '',
    eventVersion: decoded[8],
    schemaVersion: decoded[9],
    algorithmVersion: decoded[10],
  });
  if (event === null || !isBytes32(decoded[11]))
    return { kind: 'rejected', reason: 'invalid-data' };
  return { kind: 'decoded', decoded: { event, eventDigest: decoded[11] } };
}
