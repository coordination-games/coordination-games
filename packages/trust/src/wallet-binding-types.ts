import type { DidPlc, EvmAddress, WalletBindingLifecycle, WalletBindingRecord } from './index.js';

export const WALLET_BINDING_PURPOSE = 'urn:coordination-games:wallet-binding:v1' as const;

export interface WalletBindingSigningRequest {
  readonly did: DidPlc;
  readonly domain: string;
  readonly uri: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly lifecycle: WalletBindingLifecycle;
}

export interface WalletBindingSigner {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
}

export interface WalletBindingExpectation {
  readonly did: DidPlc;
  readonly domain: string;
  readonly uri: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly now: Date;
  readonly maxAgeMs: number;
  readonly maxFutureSkewMs: number;
}

export type WalletBindingStatement = {
  readonly did: DidPlc;
  readonly address: EvmAddress;
  readonly domain: string;
  readonly uri: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
};

export type WalletBindingRejectionReason =
  | 'invalid-record'
  | 'record-version'
  | 'expected-did'
  | 'expected-domain'
  | 'expected-uri'
  | 'expected-chain-id'
  | 'expected-nonce'
  | 'stale'
  | 'future'
  | 'inactive-lifecycle'
  | 'unsupported-signature-type'
  | 'invalid-signature'
  | 'signer-mismatch'
  | 'nonce-reused';

export type WalletBindingRejected = {
  readonly kind: 'rejected';
  readonly reason: WalletBindingRejectionReason;
};

export type WalletBindingVerificationResult =
  | { readonly kind: 'verified'; readonly record: WalletBindingRecord }
  | WalletBindingRejected;

export type WalletBindingCreationResult =
  | { readonly kind: 'created'; readonly record: WalletBindingRecord }
  | WalletBindingRejected;

export type WalletBindingMessageResult =
  | { readonly kind: 'built'; readonly message: string }
  | WalletBindingRejected;

export interface NonceConsumer {
  consume(nonce: string): { readonly accepted: boolean };
}
