import type { PromiseOutcome, PromiseOutcomeEvent } from './index.js';

export const PROMISE_OUTCOME_ATTESTATION_VERSION = 'promise-outcome-attestation/v1' as const;
export const PROMISE_OUTCOME_EAS_SCHEMA =
  'string actorDid,string subjectDid,uint8 outcome,string gameId,uint64 sequence,string evidenceUri,string evidenceCid,uint64 observedAtMs,string eventVersion,string schemaVersion,string algorithmVersion,bytes32 eventDigest' as const;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

export type Bytes32 = `0x${string}`;
export type HexData = `0x${string}`;

export type PromiseOutcomeCode = 1 | 2;

export type PromiseOutcomeAttestation = {
  readonly attestationVersion: typeof PROMISE_OUTCOME_ATTESTATION_VERSION;
  readonly event: PromiseOutcomeEvent;
  readonly outcomeCode: PromiseOutcomeCode;
  readonly eventIdentity: Bytes32;
  readonly eventDigest: Bytes32;
  readonly encodedData: HexData;
};

export type PromiseOutcomeRejected = {
  readonly kind: 'rejected';
  readonly reason: 'invalid-event';
};

export type PromiseOutcomeCreationResult =
  | { readonly kind: 'created'; readonly attestation: PromiseOutcomeAttestation }
  | PromiseOutcomeRejected;

export type DecodedPromiseOutcome = {
  readonly event: PromiseOutcomeEvent;
  readonly eventDigest: Bytes32;
};

export type DecodedPromiseOutcomeResult =
  | { readonly kind: 'decoded'; readonly decoded: DecodedPromiseOutcome }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-data' };

export type EasGatewayConfig = {
  readonly chainId: number;
  readonly easContract: `0x${string}`;
  readonly schemaUid: Bytes32;
  readonly attester: `0x${string}`;
};

export type EasAttestationRequest = {
  readonly schema: Bytes32;
  readonly recipient: typeof ZERO_ADDRESS;
  readonly expirationTime: bigint;
  readonly revocable: true;
  readonly refUid: typeof ZERO_BYTES32;
  readonly data: HexData;
  readonly value: bigint;
  readonly anchoredAt: string;
};

export type EasGatewaySubmission =
  | { readonly kind: 'submitted'; readonly attestationUid: Bytes32; readonly txHash: Bytes32 }
  | { readonly kind: 'rejected'; readonly reason: 'gateway-rejected' };

export interface EasGateway {
  readonly config: EasGatewayConfig;
  attest(request: EasAttestationRequest): Promise<EasGatewaySubmission>;
  getAttestation(uid: Bytes32): Promise<unknown>;
}

export type EasAttestation = {
  readonly uid: Bytes32;
  readonly schema: Bytes32;
  readonly time: bigint;
  readonly expirationTime: bigint;
  readonly revocationTime: bigint;
  readonly refUid: Bytes32;
  readonly recipient: `0x${string}`;
  readonly attester: `0x${string}`;
  readonly revocable: boolean;
  readonly data: HexData;
};

export type PromiseOutcomeAnchorRecord = {
  readonly chainId: number;
  readonly easContract: `0x${string}`;
  readonly schemaUid: Bytes32;
  readonly attestationUid: Bytes32;
  readonly attester: `0x${string}`;
  readonly txHash: Bytes32;
  readonly eventIdentity: Bytes32;
  readonly eventDigest: Bytes32;
  readonly anchoredAt: string;
};

export interface PromiseOutcomeAnchorStore {
  getByEventDigest(eventDigest: Bytes32): Promise<PromiseOutcomeAnchorRecord | null>;
  getByAttestationUid(attestationUid: Bytes32): Promise<PromiseOutcomeAnchorRecord | null>;
  save(record: PromiseOutcomeAnchorRecord): Promise<void>;
}

export type PromiseOutcomeAnchorResult =
  | { readonly kind: 'anchored'; readonly record: PromiseOutcomeAnchorRecord }
  | PromiseOutcomeRejected
  | { readonly kind: 'rejected'; readonly reason: 'invalid-anchor' | 'gateway-rejected' };

export type PromiseOutcomeQueryResult =
  | { readonly kind: 'verified'; readonly record: PromiseOutcomeAnchorRecord }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-uid'
        | 'invalid-attestation'
        | 'schema-mismatch'
        | 'recipient-mismatch'
        | 'attester-mismatch'
        | 'revoked'
        | 'expired'
        | 'invalid-data'
        | 'digest-mismatch';
    };

export type EthersEasAttestationRequest = {
  readonly schema: string;
  readonly data: {
    readonly recipient: string;
    readonly expirationTime: bigint;
    readonly revocable: boolean;
    readonly refUID: string;
    readonly data: string;
    readonly value: bigint;
  };
};

export interface EthersEasContract {
  attest(request: EthersEasAttestationRequest): Promise<EthersEasTransaction>;
  getAttestation(uid: string): Promise<unknown>;
}

export interface EthersEasTransaction {
  readonly hash: string;
  wait(): Promise<EthersEasReceipt | null>;
}

export interface EthersEasReceipt {
  readonly logs: readonly { readonly topics: readonly string[]; readonly data: string }[];
}

export type EthersEasGateway = EasGateway;
export type PromiseOutcomeEventInput = PromiseOutcomeEvent;
export type PromiseOutcomeValue = PromiseOutcome;
