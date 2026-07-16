import type { AtprotoStrongRef, DidPlc, PromiseOutcomeEvent } from '@coordination-games/trust';

export const TRAGEDY_BEHAVIOR_REPUTATION_VERSION = 'tragedy-behavior-reputation/v1' as const;

export type PublicTragedyArtifact = Readonly<{
  readonly id: string;
  readonly digest: `0x${string}`;
  readonly observedAt: string;
}>;

export type TragedyBehaviorOutcome = 'positive' | 'negative';

export type TragedyBehaviorEvent = Readonly<{
  readonly version: typeof TRAGEDY_BEHAVIOR_REPUTATION_VERSION;
  readonly id: string;
  readonly gameId: string;
  readonly round: number;
  readonly subjectPlayerId: string;
  readonly outcome: TragedyBehaviorOutcome;
  readonly behavior: 'renewable-infrastructure' | 'ecological-decline';
  readonly evidence: Readonly<{
    readonly reveal: PublicTragedyArtifact;
    readonly postRevealSnapshot: PublicTragedyArtifact;
    readonly previousPublicSnapshot: PublicTragedyArtifact;
  }>;
}>;

export type TragedyBehaviorReputation = Readonly<{
  readonly version: typeof TRAGEDY_BEHAVIOR_REPUTATION_VERSION;
  readonly events: readonly TragedyBehaviorEvent[];
}>;

export type TragedyBehaviorReputationInput = Readonly<{
  readonly gameId: string;
  readonly revealArtifact: unknown;
  readonly postRevealArtifact: unknown;
  readonly previousSnapshotArtifact: unknown;
  readonly reveal: unknown;
  readonly postRevealSnapshot: unknown;
  readonly previousPublicSnapshot: unknown;
}>;

export type TragedyBehaviorTrustMapping =
  | Readonly<{ readonly kind: 'mapped'; readonly events: readonly PromiseOutcomeEvent[] }>
  | Readonly<{
      readonly kind: 'rejected';
      readonly reason: 'invalid-event' | 'invalid-input' | 'missing-did-mapping';
    }>;

export type TragedyBehaviorTrustMappingInput = Readonly<{
  readonly derived: TragedyBehaviorReputation;
  readonly didByPlayerId: Readonly<Record<string, unknown>>;
  readonly evidence: unknown;
  readonly observedAt: string;
}>;

export type ValidatedBehaviorTrustInput = Readonly<{
  readonly evidence: AtprotoStrongRef;
  readonly didByPlayerId: Readonly<Record<string, DidPlc>>;
}>;
