import { verifyMessage } from 'ethers';
import { WALLET_BINDING_RECORD_VERSION } from './index.js';
import { buildWalletBindingMessage } from './wallet-binding-message.js';
import {
  parseWalletBindingRecord,
  parseWalletBindingSigningRequest,
} from './wallet-binding-parse.js';
import type {
  NonceConsumer,
  WalletBindingCreationResult,
  WalletBindingExpectation,
  WalletBindingSigner,
  WalletBindingVerificationResult,
} from './wallet-binding-types.js';

export function createMemoryNonceConsumer(): NonceConsumer {
  const consumed = new Set<string>();
  return {
    consume(nonce: string): { readonly accepted: boolean } {
      if (consumed.has(nonce)) return { accepted: false };
      consumed.add(nonce);
      return { accepted: true };
    },
  };
}

export async function createWalletBindingRecord(
  request: unknown,
  signer: WalletBindingSigner,
): Promise<WalletBindingCreationResult> {
  const parsed = parseWalletBindingSigningRequest(request, await signer.getAddress());
  if (parsed.kind === 'rejected') return parsed;
  const message = buildWalletBindingMessage(parsed.statement);
  if (message.kind === 'rejected') return message;
  const signature = await signer.signMessage(message.message);
  const record = parseWalletBindingRecord({
    recordVersion: WALLET_BINDING_RECORD_VERSION,
    ...parsed.request,
    address: parsed.statement.address,
    signature,
    signatureType: 'eip191',
  });
  if (record.kind === 'rejected') return record;
  return { kind: 'created', record: record.record };
}

export function verifyWalletBindingRecord(
  input: unknown,
  expected: WalletBindingExpectation,
  nonceConsumer: NonceConsumer,
): WalletBindingVerificationResult {
  const parsed = parseWalletBindingRecord(input);
  if (parsed.kind === 'rejected') return parsed;
  const { record } = parsed;
  if (record.did !== expected.did) return { kind: 'rejected', reason: 'expected-did' };
  if (record.domain !== expected.domain) return { kind: 'rejected', reason: 'expected-domain' };
  if (record.uri !== expected.uri) return { kind: 'rejected', reason: 'expected-uri' };
  if (record.chainId !== expected.chainId) return { kind: 'rejected', reason: 'expected-chain-id' };
  if (record.nonce !== expected.nonce) return { kind: 'rejected', reason: 'expected-nonce' };
  if (record.lifecycle.status !== 'active')
    return { kind: 'rejected', reason: 'inactive-lifecycle' };
  const ageMs = expected.now.getTime() - Date.parse(record.issuedAt);
  if (ageMs > expected.maxAgeMs) return { kind: 'rejected', reason: 'stale' };
  if (ageMs < -expected.maxFutureSkewMs) return { kind: 'rejected', reason: 'future' };
  if (record.signatureType === 'eip1271')
    return { kind: 'rejected', reason: 'unsupported-signature-type' };
  const message = buildWalletBindingMessage({
    did: record.did,
    address: record.address,
    domain: record.domain,
    uri: record.uri,
    chainId: record.chainId,
    nonce: record.nonce,
    issuedAt: record.issuedAt,
  });
  if (message.kind === 'rejected') return message;
  let recoveredAddress: string;
  try {
    recoveredAddress = verifyMessage(message.message, record.signature);
  } catch (error) {
    if (error instanceof Error) return { kind: 'rejected', reason: 'invalid-signature' };
    return { kind: 'rejected', reason: 'invalid-signature' };
  }
  if (recoveredAddress !== record.address) return { kind: 'rejected', reason: 'signer-mismatch' };
  if (!nonceConsumer.consume(record.nonce).accepted)
    return { kind: 'rejected', reason: 'nonce-reused' };
  return { kind: 'verified', record };
}
