import { describe, expect, it } from 'vitest';
import {
  createPromiseOutcomeAttestation,
  getPromiseOutcomeSchemaUid,
  PROMISE_OUTCOME_EAS_SCHEMA,
} from '../index.js';

const EVENT = {
  eventVersion: 'promise-outcome/v1',
  schemaVersion: 'trust-schema/v1',
  algorithmVersion: 'reliability/v1',
  actorDid: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  subjectDid: 'did:plc:abcdefghijklmnopqrstuvwx',
  outcome: 'kept',
  gameId: 'tragedy:match-20260716',
  sequence: 7,
  evidence: {
    uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/trust.event/7',
    cid: 'bafybeigdyrzt6ic3b7q4tf6h3y2x4cn27lu5ps5h7izngyztby6cd3k6da',
  },
  observedAt: '2026-07-16T12:00:00.000Z',
} as const;

describe('promise outcome attestation', () => {
  it('derives a stable identity and digest from canonical public fields', () => {
    // Given equivalent events with different object insertion order
    const first = createPromiseOutcomeAttestation(EVENT);
    const reordered = createPromiseOutcomeAttestation({
      sequence: EVENT.sequence,
      observedAt: EVENT.observedAt,
      evidence: EVENT.evidence,
      gameId: EVENT.gameId,
      outcome: EVENT.outcome,
      subjectDid: EVENT.subjectDid,
      actorDid: EVENT.actorDid,
      algorithmVersion: EVENT.algorithmVersion,
      schemaVersion: EVENT.schemaVersion,
      eventVersion: EVENT.eventVersion,
    });

    // When both public records are canonicalized
    expect(first.kind).toBe('created');
    expect(reordered.kind).toBe('created');
    if (first.kind !== 'created' || reordered.kind !== 'created') return;

    // Then their identity, digest, and EAS payload are identical
    expect(first.attestation.eventIdentity).toBe(reordered.attestation.eventIdentity);
    expect(first.attestation.eventDigest).toBe(reordered.attestation.eventDigest);
    expect(first.attestation.encodedData).toBe(reordered.attestation.encodedData);
  });

  it('encodes kept and broken as the only finite outcomes', () => {
    // Given a canonical kept event and its broken counterpart
    const kept = createPromiseOutcomeAttestation(EVENT);
    const broken = createPromiseOutcomeAttestation({ ...EVENT, outcome: 'broken' });

    // When both are encoded for EAS
    expect(kept.kind).toBe('created');
    expect(broken.kind).toBe('created');
    if (kept.kind !== 'created' || broken.kind !== 'created') return;

    // Then their explicit outcome encodings yield distinct public digests
    expect(kept.attestation.outcomeCode).toBe(1);
    expect(broken.attestation.outcomeCode).toBe(2);
    expect(kept.attestation.eventDigest).not.toBe(broken.attestation.eventDigest);
  });

  it('fails closed for malformed public event fields and unknown outcomes', () => {
    // Given malformed event inputs at the untrusted boundary
    const invalidOutcome = createPromiseOutcomeAttestation({ ...EVENT, outcome: 'unclear' });
    const invalidSequence = createPromiseOutcomeAttestation({ ...EVENT, sequence: 0 });
    const invalidEvidence = createPromiseOutcomeAttestation({
      ...EVENT,
      evidence: { ...EVENT.evidence, cid: 'not-a-cid' },
    });

    // When each input is parsed
    // Then every case is rejected without creating an attestation
    expect(invalidOutcome).toEqual({ kind: 'rejected', reason: 'invalid-event' });
    expect(invalidSequence).toEqual({ kind: 'rejected', reason: 'invalid-event' });
    expect(invalidEvidence).toEqual({ kind: 'rejected', reason: 'invalid-event' });
  });

  it('publishes one ordered EAS schema with a deterministic UID helper', () => {
    // Given the public promise-outcome schema configuration
    const resolver = '0x0000000000000000000000000000000000000000';

    // When its UID is derived twice from the same EAS inputs
    const first = getPromiseOutcomeSchemaUid(resolver, true);
    const second = getPromiseOutcomeSchemaUid(resolver, true);

    // Then field order and UID derivation remain stable for external consumers
    expect(PROMISE_OUTCOME_EAS_SCHEMA).toBe(
      'string actorDid,string subjectDid,uint8 outcome,string gameId,uint64 sequence,string evidenceUri,string evidenceCid,uint64 observedAtMs,string eventVersion,string schemaVersion,string algorithmVersion,bytes32 eventDigest',
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^0x[a-f0-9]{64}$/);
  });
});
