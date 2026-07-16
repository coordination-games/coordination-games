import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  buildWalletBindingMessage,
  createMemoryNonceConsumer,
  createWalletBindingRecord,
  verifyWalletBindingRecord,
  type WalletBindingExpectation,
  type WalletBindingSigningRequest,
} from '../index.js';

const PRIVATE_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const OTHER_DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const NOW = new Date('2026-07-16T12:00:00.000Z');

function request(): WalletBindingSigningRequest {
  return {
    did: DID,
    domain: 'games.coop',
    uri: 'https://games.coop/trust/bind',
    chainId: 11155420,
    nonce: 'BindNonce20260716',
    issuedAt: '2026-07-16T11:59:00.000Z',
    lifecycle: { status: 'active' },
  };
}

function expectation(overrides: Partial<WalletBindingExpectation> = {}): WalletBindingExpectation {
  return {
    did: DID,
    domain: 'games.coop',
    uri: 'https://games.coop/trust/bind',
    chainId: 11155420,
    nonce: 'BindNonce20260716',
    now: NOW,
    maxAgeMs: 5 * 60_000,
    maxFutureSkewMs: 10_000,
    ...overrides,
  };
}

describe('wallet binding', () => {
  it('signs and verifies a canonical EIP-191 SIWE binding exactly once', async () => {
    // Given a deterministic EOA and active PLC binding request
    const created = await createWalletBindingRecord(request(), new Wallet(PRIVATE_KEY));
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const { record } = created;
    const nonceConsumer = createMemoryNonceConsumer();
    const message = buildWalletBindingMessage({
      did: record.did,
      address: record.address,
      domain: record.domain,
      uri: record.uri,
      chainId: record.chainId,
      nonce: record.nonce,
      issuedAt: record.issuedAt,
    });

    // When the record is verified against its expected ceremony values
    const verified = verifyWalletBindingRecord(record, expectation(), nonceConsumer);

    // Then the signer, signed DID, and single-use nonce are accepted
    expect(verified.kind).toBe('verified');
    expect(record.address).toBe('0x14791697260E4c9A71f18484C9f997B308e59325');
    expect(message).toEqual({
      kind: 'built',
      message:
        'games.coop wants you to sign in with your Ethereum account:\n0x14791697260E4c9A71f18484C9f997B308e59325\n\nBind this Ethereum account to the listed DID.\n\nURI: https://games.coop/trust/bind\nVersion: 1\nChain ID: 11155420\nNonce: BindNonce20260716\nIssued At: 2026-07-16T11:59:00.000Z\nResources:\n- urn:coordination-games:wallet-binding:v1\n- did:plc:z72i7hdynmk6r22z27h6tvur',
    });
    expect(verifyWalletBindingRecord(record, expectation(), nonceConsumer)).toEqual({
      kind: 'rejected',
      reason: 'nonce-reused',
    });
  });

  it('rejects a DID changed after the EOA signature was created', async () => {
    // Given a valid record whose DID is replaced after signing
    const created = await createWalletBindingRecord(request(), new Wallet(PRIVATE_KEY));
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const { record } = created;
    const changedDidRecord = { ...record, did: OTHER_DID };

    // When the verifier reconstructs the message using the changed DID
    const verified = verifyWalletBindingRecord(
      changedDidRecord,
      expectation({ did: OTHER_DID }),
      createMemoryNonceConsumer(),
    );

    // Then signer recovery cannot validate the altered signed statement
    expect(verified).toEqual({ kind: 'rejected', reason: 'signer-mismatch' });
  });

  it('rejects adversarial records with typed reasons', async () => {
    // Given a valid deterministic record
    const created = await createWalletBindingRecord(request(), new Wallet(PRIVATE_KEY));
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const { record } = created;

    // When untrusted fields, lifecycle, freshness, or signature type are changed
    const cases: readonly [unknown, WalletBindingExpectation, string][] = [
      [{ ...record, address: record.address.toLowerCase() }, expectation(), 'invalid-record'],
      [
        { ...record, domain: 'evil.games.coop', uri: 'https://evil.games.coop/trust/bind' },
        expectation(),
        'expected-domain',
      ],
      [{ ...record, uri: 'https://games.coop/other' }, expectation(), 'expected-uri'],
      [{ ...record, chainId: 1 }, expectation(), 'expected-chain-id'],
      [{ ...record, nonce: 'OtherNonce202607' }, expectation(), 'expected-nonce'],
      [{ ...record, issuedAt: '2026-07-16T11:00:00.000Z' }, expectation(), 'stale'],
      [{ ...record, issuedAt: '2026-07-16T12:01:00.000Z' }, expectation(), 'future'],
      [
        { ...record, lifecycle: { status: 'revoked', revokedAt: '2026-07-16T12:00:00.000Z' } },
        expectation(),
        'inactive-lifecycle',
      ],
      [
        {
          ...record,
          lifecycle: {
            status: 'superseded',
            supersededAt: '2026-07-16T12:00:00.000Z',
            supersededBy: {
              uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/trust.binding/next',
              cid: 'bafynext',
            },
          },
        },
        expectation(),
        'inactive-lifecycle',
      ],
      [{ ...record, recordVersion: 'wallet-binding/v2' }, expectation(), 'record-version'],
      [{ ...record, signature: '0x1234' }, expectation(), 'invalid-record'],
      [{ ...record, signatureType: 'eip1271' }, expectation(), 'unsupported-signature-type'],
      [{ ...record, did: 'did:plc:not-valid' }, expectation(), 'invalid-record'],
    ];

    // Then each case is rejected without throwing or consuming the nonce
    for (const [candidate, expected, reason] of cases) {
      expect(
        verifyWalletBindingRecord(candidate, expected, createMemoryNonceConsumer()),
      ).toMatchObject({
        kind: 'rejected',
        reason,
      });
    }
  });
});
