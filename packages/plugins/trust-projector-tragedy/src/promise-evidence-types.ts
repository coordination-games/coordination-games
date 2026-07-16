import type { PromiseOutcome } from '@coordination-games/trust';
import type {
  TRAGEDY_PROMISE_DERIVATION_VERSION,
  TragedyPromiseActionType,
  TragedyPromiseCommitment,
  TragedyPublicActionObservation,
  TragedyPublicPromise,
} from './promise-resolution-types.js';

export const TRAGEDY_ACTION_SOURCE_VERSION = 'tragedy-action-source/v1' as const;
export const TRAGEDY_PROMISE_TRANSCRIPT_VERSION = 'tragedy-promise-transcript/v1' as const;
export const TRAGEDY_PROMISE_EVIDENCE_VERSION = 'tragedy-promise-evidence/v1' as const;

export type TragedyBotDecisionSource = Readonly<{
  readonly eventIndex: number;
  readonly kind: 'bot_decision';
  readonly gameId: string;
  readonly playerId: string;
  readonly round: number;
  readonly actionType: TragedyPromiseActionType;
}>;

export type TragedyActionResultSource = Readonly<{
  readonly eventIndex: number;
  readonly kind: 'action_result';
  readonly gameId: string;
  readonly playerId: string;
  readonly actionType: TragedyPromiseActionType;
  readonly phase: 'waiting' | 'playing' | 'finished';
}>;

export type TragedySettlementSource = Readonly<{
  readonly eventIndex: number;
  readonly kind: 'settlement';
  readonly gameId: string;
  readonly treasuryDelta: string;
}>;

export type TragedyPromiseTranscriptProof = Readonly<{
  readonly version: typeof TRAGEDY_PROMISE_TRANSCRIPT_VERSION;
  readonly botDecision: TragedyBotDecisionSource;
  readonly actionResult: TragedyActionResultSource;
  readonly settlement: TragedySettlementSource;
  readonly digest: `0x${string}`;
}>;

export type TragedyPromiseEvidence = Readonly<{
  readonly version: typeof TRAGEDY_PROMISE_EVIDENCE_VERSION;
  readonly derivationVersion: typeof TRAGEDY_PROMISE_DERIVATION_VERSION;
  readonly commitment: TragedyPromiseCommitment;
  readonly observation: TragedyPublicActionObservation;
  readonly transcript: TragedyPromiseTranscriptProof;
  readonly resolvedOutcome: PromiseOutcome;
}>;

export type VerifiedTragedyPromiseEvidence = Readonly<{
  readonly promise: TragedyPublicPromise;
  readonly outcome: PromiseOutcome;
  readonly sourceEventHash: `0x${string}`;
  readonly transcriptDigest: `0x${string}`;
  readonly settlementEventIndex: number;
}>;

export type TragedyPromiseEvidenceVerification =
  | Readonly<{ readonly kind: 'verified'; readonly verified: VerifiedTragedyPromiseEvidence }>
  | Readonly<{
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-evidence'
        | 'commitment-mismatch'
        | 'observation-mismatch'
        | 'source-mismatch'
        | 'outcome-mismatch';
    }>;
