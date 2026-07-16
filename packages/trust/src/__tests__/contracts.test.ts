import { describe, expect, it } from 'vitest';
import type {
  DidPlc,
  EvmAddress,
  PromiseOutcomeEvent,
  TrustProjectionResult,
  WalletBindingRecord,
} from '../index.js';
import {
  TRUST_ALGORITHM_VERSION,
  TRUST_EVENT_SCHEMA_VERSION,
  TRUST_INTERFACE_VERSION,
  TRUST_PROJECTION_VERSION,
  TRUST_SCHEMA_VERSION,
  WALLET_BINDING_RECORD_VERSION,
} from '../index.js';

describe('trust interface contract', () => {
  it('exports stable runtime interface versions', () => {
    expect(TRUST_INTERFACE_VERSION).toBe('trust-interface/v1');
    expect(TRUST_EVENT_SCHEMA_VERSION).toBe('promise-outcome/v1');
  });

  it('preserves the scaffold binding exports before verification behavior is added', () => {
    expect(WALLET_BINDING_RECORD_VERSION).toBe('wallet-binding/v1');
    expect(TRUST_SCHEMA_VERSION).toBe('trust-schema/v1');
    expect(TRUST_ALGORITHM_VERSION).toBe('reliability/v1');
    expect(TRUST_PROJECTION_VERSION).toBe('trust-projection/v1');
  });

  it('accepts the PLC binding and deterministic outcome contracts', () => {
    const did: DidPlc = 'did:plc:alice';
    const address: EvmAddress = '0xabc123';
    const binding: WalletBindingRecord = {
      recordVersion: 'wallet-binding/v1',
      did,
      address,
      domain: 'games.coop',
      uri: 'https://games.coop/trust/bind',
      chainId: 11155420,
      nonce: 'nonce-1',
      issuedAt: '2026-07-10T00:00:00.000Z',
      signature: '0xsignature',
      signatureType: 'eip191',
      lifecycle: { status: 'active' },
    };
    const event: PromiseOutcomeEvent = {
      eventVersion: 'promise-outcome/v1',
      schemaVersion: 'trust-schema/v1',
      algorithmVersion: 'reliability/v1',
      actorDid: did,
      subjectDid: did,
      outcome: 'kept',
      gameId: 'game-1',
      sequence: 1,
      evidence: { uri: 'at://did:plc:authority/trust.event/1', cid: 'bafyfixture' },
      observedAt: '2026-07-10T00:00:01.000Z',
    };

    expect(binding.address).toBe(address);
    expect(event.outcome).toBe('kept');

    const projection: TrustProjectionResult = {
      projectionVersion: 'trust-projection/v1',
      eventSchemaVersion: 'promise-outcome/v1',
      algorithmVersion: 'reliability/v1',
      subjectDid: did,
      outcomes: { kept: 1, broken: 0 },
      reliability: { representation: 'ratio', value: 1 },
    };

    expect(projection.outcomes).toEqual({ kept: 1, broken: 0 });
    expect(projection.eventSchemaVersion).toBe(TRUST_EVENT_SCHEMA_VERSION);
    expect(projection.reliability.representation).toBe('ratio');
  });

  it('rejects invalid template literals and discriminants', () => {
    // @ts-expect-error DID must start with did:plc:
    const invalidDid: DidPlc = 'did:web:alice';
    // @ts-expect-error EVM address must start with 0x
    const invalidAddress: EvmAddress = 'address';
    // @ts-expect-error outcomes are kept or broken only
    const invalidOutcome: PromiseOutcomeEvent['outcome'] = 'unknown';
    // @ts-expect-error signature type is explicitly versioned
    const invalidSignatureType: WalletBindingRecord['signatureType'] = 'eip712';

    expect([invalidDid, invalidAddress, invalidOutcome, invalidSignatureType]).toHaveLength(4);
  });
});
