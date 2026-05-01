import type {
  AttestationV1,
  TrustCardV1,
  TrustEvidenceEnvelopeV1,
} from '@coordination-games/engine';

export const TRUST_PROJECTOR_TRAGEDY_PLUGIN_ID = 'trust-projector-tragedy' as const;
export const ATTESTATION_RELAY_TYPE = 'attestation' as const;
export const TRAGEDY_GAME_ID = 'tragedy-of-the-commons' as const;

export type TragedyAttestation = AttestationV1;

export interface TrustProjectorMeta {
  readonly gameId: string;
  readonly gameType: string;
  readonly handleMap?: Record<string, string>;
  readonly progressCounter?: number | null;
  readonly finished?: boolean;
}

export interface TrustProjectionInput {
  readonly state: unknown;
  readonly meta?: TrustProjectorMeta;
  readonly attestations?: readonly TragedyAttestation[];
  readonly relayMessages?: readonly unknown[];
}

export interface TrustProjectionArtifacts {
  readonly cards: TrustCardV1[];
  readonly envelopes: TrustEvidenceEnvelopeV1[];
}

export interface VisibleTragedyPlayerSnapshot {
  readonly playerId: string;
  readonly displayName?: string;
  readonly influence: number;
  readonly victoryPoints: number;
  readonly totalResources: number;
  readonly regionsControlled: number;
  readonly lastAction?: string;
}
