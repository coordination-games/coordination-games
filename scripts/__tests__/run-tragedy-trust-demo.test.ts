import { verifyTragedyPromiseEvidence } from '@coordination-games/plugin-trust-projector-tragedy';
import { describe, expect, it } from 'vitest';
import { cidForCanonicalArtifact } from '../lib/tragedy-trust-evidence.js';
import {
  buildTragedyTrustDemoArtifact,
  serializeTragedyTrustDemoArtifact,
} from '../run-tragedy-trust-demo.js';

describe('Tragedy portable trust demo', () => {
  it('runs a deterministic settled Tragedy fixture through event, projection, anchor, and verified query', async () => {
    const first = await buildTragedyTrustDemoArtifact();
    const replay = await buildTragedyTrustDemoArtifact();

    expect(serializeTragedyTrustDemoArtifact(replay)).toBe(
      serializeTragedyTrustDemoArtifact(first),
    );
    expect(first.demoVersion).toBe('tragedy-portable-trust-demo/v2');
    expect(first.events.map((event) => event.outcome)).toEqual(['kept', 'broken']);
    expect(new Set(first.events.map((event) => event.gameId)).size).toBe(2);
    expect(new Set(first.events.map((event) => event.subjectDid)).size).toBe(2);
    expect(first.projections).toHaveLength(2);
    expect(first.projections.map((projection) => projection.result.reliability)).toEqual([
      { representation: 'ratio', value: 1 },
      { representation: 'ratio', value: 0 },
    ]);
    expect(first.attestations).toHaveLength(2);
    expect(first.attestations.every((attestation) => attestation.query.kind === 'verified')).toBe(
      true,
    );
    expect(first.promiseEvidence).toHaveLength(2);
    expect(
      first.promiseEvidence.every((evidence) => evidence.uri.includes('tragedy-settlement')),
    ).toBe(true);
    expect(
      first.promiseEvidence.every(
        (evidence) => evidence.cid === cidForCanonicalArtifact(evidence.artifact),
      ),
    ).toBe(true);
    expect(
      first.ordering.promiseCommitments.every(
        (entry) => entry.order < first.ordering.tournamentRunOrder,
      ),
    ).toBe(true);
    expect(
      first.promiseEvidence.every(
        (evidence) => verifyTragedyPromiseEvidence(evidence.artifact).kind === 'verified',
      ),
    ).toBe(true);
    expect(serializeTragedyTrustDemoArtifact(first.promiseEvidence)).not.toMatch(
      /secret|root|entropy/i,
    );
  });

  it('rejects independently tampered promise, action, and source evidence', async () => {
    const artifact = await buildTragedyTrustDemoArtifact();
    const evidence = artifact.promiseEvidence[0]?.artifact;
    if (evidence === undefined) throw new Error('evidence fixture missing');
    const tampered = [
      {
        ...evidence,
        commitment: {
          ...evidence.commitment,
          promise: { ...evidence.commitment.promise, expectedActionType: 'build_road' },
        },
      },
      { ...evidence, observation: { ...evidence.observation, actionType: 'build_road' } },
      {
        ...evidence,
        transcript: {
          ...evidence.transcript,
          settlement: { ...evidence.transcript.settlement, treasuryDelta: '999' },
        },
      },
    ];

    for (const candidate of tampered) {
      expect(verifyTragedyPromiseEvidence(candidate)).toMatchObject({ kind: 'rejected' });
    }
  });
});
