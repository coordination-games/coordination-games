import type { AtprotoStrongRef, DidPlc, PromiseOutcomeEvent } from '@coordination-games/trust';
import {
  mapSettledTragedyPromiseOutcomes,
  type TragedyPromiseOutcomeMapping,
} from './portable-trust.js';
import type { VerifiedTragedyPromiseEvidence } from './promise-evidence.js';

export type VerifiedTragedyPromiseEvidenceReference = Readonly<{
  readonly verified: VerifiedTragedyPromiseEvidence;
  readonly evidence: AtprotoStrongRef;
}>;

export type TragedyDerivedPromiseOutcome =
  | Readonly<{ readonly kind: 'derived'; readonly events: readonly PromiseOutcomeEvent[] }>
  | Readonly<{
      readonly kind: 'rejected';
      readonly reason: 'invalid-input';
    }>;

export function deriveTragedyPromiseOutcomes(input: {
  readonly didByPlayerId: Readonly<Record<string, DidPlc>>;
  readonly evidence: readonly VerifiedTragedyPromiseEvidenceReference[];
  readonly observedAt: string;
}): TragedyDerivedPromiseOutcome {
  const resolutions = input.evidence.map((entry) => ({
    resolutionVersion: 'tragedy-promise-resolution/v1' as const,
    visibility: 'public' as const,
    gameId: entry.verified.promise.gameId,
    sequence: entry.verified.promise.round,
    actorPlayerId: entry.verified.promise.promisorPlayerId,
    subjectPlayerId: entry.verified.promise.promisorPlayerId,
    outcome: entry.verified.outcome,
    observedAt: input.observedAt,
    evidence: entry.evidence,
  }));
  const mapped: TragedyPromiseOutcomeMapping = mapSettledTragedyPromiseOutcomes({
    gameType: 'tragedy-of-the-commons',
    didByPlayerId: input.didByPlayerId,
    resolutions,
  });
  return mapped.kind === 'mapped'
    ? { kind: 'derived', events: mapped.events }
    : { kind: 'rejected', reason: 'invalid-input' };
}
