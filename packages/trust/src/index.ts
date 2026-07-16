export const TRUST_INTERFACE_VERSION = 'trust-interface/v1' as const;
export const WALLET_BINDING_RECORD_VERSION = 'wallet-binding/v1' as const;
export const TRUST_EVENT_SCHEMA_VERSION = 'promise-outcome/v1' as const;
export const TRUST_SCHEMA_VERSION = 'trust-schema/v1' as const;
export const TRUST_ALGORITHM_VERSION = 'reliability/v1' as const;
export const TRUST_PROJECTION_VERSION = 'trust-projection/v1' as const;

export type DidPlc = `did:plc:${string}`;
export type EvmAddress = `0x${string}`;

export interface AtprotoStrongRef {
  readonly uri: string;
  readonly cid: string;
}

export type WalletBindingSignatureType = 'eip191' | 'eip1271';

export type WalletBindingLifecycle =
  | {
      readonly status: 'active';
    }
  | {
      readonly status: 'revoked';
      readonly revokedAt: string;
      readonly revocation?: AtprotoStrongRef;
    }
  | {
      readonly status: 'superseded';
      readonly supersededAt: string;
      readonly supersededBy: AtprotoStrongRef;
    };

export interface WalletBindingRecord {
  readonly recordVersion: typeof WALLET_BINDING_RECORD_VERSION;
  readonly did: DidPlc;
  readonly address: EvmAddress;
  readonly domain: string;
  readonly uri: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly signature: string;
  readonly signatureType: WalletBindingSignatureType;
  readonly lifecycle: WalletBindingLifecycle;
}

export type PromiseOutcome = 'kept' | 'broken';

export type SerializableValue =
  | string
  | number
  | boolean
  | null
  | readonly SerializableValue[]
  | { readonly [key: string]: SerializableValue };

export interface SerializableExtension {
  readonly schema: string;
  readonly data: Readonly<Record<string, SerializableValue>>;
}

export interface PromiseOutcomeEvent {
  readonly eventVersion: typeof TRUST_EVENT_SCHEMA_VERSION;
  readonly schemaVersion: typeof TRUST_SCHEMA_VERSION;
  readonly algorithmVersion: typeof TRUST_ALGORITHM_VERSION;
  readonly actorDid: DidPlc;
  readonly subjectDid: DidPlc;
  readonly outcome: PromiseOutcome;
  readonly gameId: string;
  readonly sequence: number;
  readonly evidence: AtprotoStrongRef;
  readonly observedAt: string;
  readonly extension?: SerializableExtension;
}

export interface TrustProjectionQuery {
  readonly projectionVersion: typeof TRUST_PROJECTION_VERSION;
  readonly subjectDid: DidPlc;
  readonly algorithmVersion: typeof TRUST_ALGORITHM_VERSION;
}

export interface PromiseOutcomeCounts {
  readonly kept: number;
  readonly broken: number;
}

export type ReliabilityRepresentation =
  | {
      readonly representation: 'ratio';
      readonly value: number;
    }
  | {
      readonly representation: 'unavailable';
    };

export interface TrustProjectionResult {
  readonly projectionVersion: typeof TRUST_PROJECTION_VERSION;
  readonly eventSchemaVersion: typeof TRUST_EVENT_SCHEMA_VERSION;
  readonly algorithmVersion: typeof TRUST_ALGORITHM_VERSION;
  readonly subjectDid: DidPlc;
  readonly outcomes: PromiseOutcomeCounts;
  readonly reliability: ReliabilityRepresentation;
}

export {
  createMemoryNonceConsumer,
  createWalletBindingRecord,
  verifyWalletBindingRecord,
} from './wallet-binding.js';
export { buildWalletBindingMessage } from './wallet-binding-message.js';
export { parseWalletBindingRecord } from './wallet-binding-parse.js';
export type {
  NonceConsumer,
  WalletBindingCreationResult,
  WalletBindingExpectation,
  WalletBindingMessageResult,
  WalletBindingRejected,
  WalletBindingRejectionReason,
  WalletBindingSigner,
  WalletBindingSigningRequest,
  WalletBindingStatement,
  WalletBindingVerificationResult,
} from './wallet-binding-types.js';
export { WALLET_BINDING_PURPOSE } from './wallet-binding-types.js';
