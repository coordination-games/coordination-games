import { describe, expect, it } from 'vitest';
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
    expect(first.events.map((event) => event.outcome)).toEqual(['kept', 'broken']);
    expect(first.projections).toHaveLength(1);
    expect(first.projections.map((projection) => projection.result.reliability)).toEqual([
      { representation: 'ratio', value: 0.5 },
    ]);
    expect(first.attestations).toHaveLength(2);
    expect(first.attestations.every((attestation) => attestation.query.kind === 'verified')).toBe(
      true,
    );
    expect(first.settlementEvidence).toHaveLength(2);
    expect(
      first.settlementEvidence.every((evidence) => evidence.uri.includes('tragedy-settlement')),
    ).toBe(true);
    expect(serializeTragedyTrustDemoArtifact(first.settlementEvidence)).not.toMatch(
      /secret|root|entropy/i,
    );
  });
});
