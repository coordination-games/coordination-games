import { Interface } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  createEthersEasGateway,
  createInMemoryEasGateway,
  createPromiseOutcomeAnchor,
  createPromiseOutcomeAttestation,
  EAS_CONTRACT_ABI,
  ZERO_ADDRESS,
} from '../index.js';
import type { EthersEasAttestationRequest } from '../promise-outcome-types.js';

const EVENT = {
  eventVersion: 'promise-outcome/v1',
  schemaVersion: 'trust-schema/v1',
  algorithmVersion: 'reliability/v1',
  actorDid: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  subjectDid: 'did:plc:abcdefghijklmnopqrstuvwx',
  outcome: 'kept',
  gameId: 'tragedy:match-20260716',
  sequence: 7,
  evidence: {
    uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/trust.event/7',
    cid: 'bafybeigdyrzt6ic3b7q4tf6h3y2x4cn27lu5ps5h7izngyztby6cd3k6da',
  },
  observedAt: '2026-07-16T12:00:00.000Z',
} as const;

const GATEWAY_CONFIG = {
  chainId: 11155420,
  easContract: '0x4200000000000000000000000000000000000021',
  schemaUid: '0x16d2be53c55b4fd4d608144892ebeb1102b181ad099c06dc7536d3517dd5ba99',
  attester: '0x14791697260E4c9A71f18484C9f997B308e59325',
} as const;

describe('EAS promise-outcome anchor', () => {
  it('anchors then verifies a deterministic event by attestation UID', async () => {
    // Given a configured in-memory EAS contract and a canonical event
    const gateway = createInMemoryEasGateway(GATEWAY_CONFIG);
    const anchor = createPromiseOutcomeAnchor(gateway);

    // When the event is anchored and later queried by its EAS UID
    const anchored = await anchor.anchor(EVENT, '2026-07-16T12:01:00.000Z');
    expect(anchored.kind).toBe('anchored');
    if (anchored.kind !== 'anchored') return;
    const queried = await anchor.query(anchored.record.attestationUid);

    // Then every immutable chain and canonical-event invariant is proved
    expect(anchored.record.chainId).toBe(GATEWAY_CONFIG.chainId);
    expect(anchored.record.easContract).toBe(GATEWAY_CONFIG.easContract);
    expect(anchored.record.attester).toBe(GATEWAY_CONFIG.attester);
    expect(anchored.record.anchoredAt).toBe('2026-07-16T12:01:00.000Z');
    expect(queried).toMatchObject({ kind: 'verified', record: anchored.record });
  });

  it('returns the first anchor deterministically for duplicate events', async () => {
    // Given one long-lived anchor service and an event
    const anchor = createPromiseOutcomeAnchor(createInMemoryEasGateway(GATEWAY_CONFIG));

    // When an identical event is submitted twice at different wall-clock times
    const first = await anchor.anchor(EVENT, '2026-07-16T12:01:00.000Z');
    const duplicate = await anchor.anchor(EVENT, '2026-07-16T12:02:00.000Z');

    // Then no second attestation is minted and the original record is returned
    expect(duplicate).toEqual(first);
  });

  it('submits the deployed EAS attest tuple through the ethers-compatible adapter', async () => {
    // Given an ethers-compatible contract that records the typed EAS request
    const easInterface = new Interface(EAS_CONTRACT_ABI);
    const uid = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    let captured: EthersEasAttestationRequest | undefined;
    const gateway = createEthersEasGateway(GATEWAY_CONFIG, {
      async attest(request) {
        captured = request;
        const log = easInterface.encodeEventLog('Attested', [
          uid,
          GATEWAY_CONFIG.schemaUid,
          ZERO_ADDRESS,
          GATEWAY_CONFIG.attester,
        ]);
        return {
          hash: txHash,
          async wait() {
            return { logs: [log] };
          },
        };
      },
      async getAttestation() {
        return null;
      },
    });
    const anchor = createPromiseOutcomeAnchor(gateway);

    // When a canonical event is anchored
    const result = await anchor.anchor(EVENT, '2026-07-16T12:01:00.000Z');

    // Then the actual EAS nested tuple carries only canonical data and zero value
    expect(result).toMatchObject({ kind: 'anchored', record: { attestationUid: uid, txHash } });
    expect(captured).toMatchObject({
      schema: GATEWAY_CONFIG.schemaUid,
      data: {
        recipient: ZERO_ADDRESS,
        expirationTime: 0n,
        revocable: true,
        refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
        value: 0n,
      },
    });
  });

  it('normalizes the deployed EAS getAttestation tuple before query verification', async () => {
    // Given a contract response in the actual positional EAS tuple shape
    const encoded = createPromiseOutcomeAttestation(EVENT);
    expect(encoded.kind).toBe('created');
    if (encoded.kind !== 'created') return;
    const uid = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const gateway = createEthersEasGateway(GATEWAY_CONFIG, {
      async attest() {
        throw new Error('not used by query');
      },
      async getAttestation() {
        return [
          uid,
          GATEWAY_CONFIG.schemaUid,
          1_784_265_660n,
          0n,
          0n,
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          ZERO_ADDRESS,
          GATEWAY_CONFIG.attester,
          true,
          encoded.attestation.encodedData,
        ];
      },
    });

    // When the attestation is queried by UID through the narrow gateway port
    const result = await createPromiseOutcomeAnchor(gateway).query(uid);

    // Then the decoded canonical event is independently verified
    expect(result).toMatchObject({
      kind: 'verified',
      record: { attestationUid: uid, eventDigest: encoded.attestation.eventDigest },
    });
  });

  it('returns a typed rejection when an ethers gateway refuses submission', async () => {
    // Given a configured contract surface whose transaction submission rejects
    const gateway = createEthersEasGateway(GATEWAY_CONFIG, {
      async attest() {
        throw new Error('reverted');
      },
      async getAttestation() {
        return null;
      },
    });

    // When the anchor service submits an otherwise valid deterministic event
    const result = await createPromiseOutcomeAnchor(gateway).anchor(
      EVENT,
      '2026-07-16T12:01:00.000Z',
    );

    // Then provider failure does not become a misleading successful anchor
    expect(result).toEqual({ kind: 'rejected', reason: 'gateway-rejected' });
  });

  it('rejects tampered payload, recipient, revoked, expired, and unknown attestation states', async () => {
    // Given a correctly anchored canonical event
    const gateway = createInMemoryEasGateway(GATEWAY_CONFIG);
    const anchor = createPromiseOutcomeAnchor(gateway);
    const anchored = await anchor.anchor(EVENT, '2026-07-16T12:01:00.000Z');
    expect(anchored.kind).toBe('anchored');
    if (anchored.kind !== 'anchored') return;
    const changed = createPromiseOutcomeAttestation({ ...EVENT, outcome: 'broken' });
    expect(changed.kind).toBe('created');
    if (changed.kind !== 'created') return;

    // When each EAS invariant is adversarially modified
    gateway.tamper(anchored.record.attestationUid, { data: changed.attestation.encodedData });
    const tampered = await anchor.query(anchored.record.attestationUid);
    gateway.tamper(anchored.record.attestationUid, { recipient: GATEWAY_CONFIG.attester });
    const wrongRecipient = await anchor.query(anchored.record.attestationUid);
    gateway.tamper(anchored.record.attestationUid, { recipient: ZERO_ADDRESS, revocationTime: 1n });
    const revoked = await anchor.query(anchored.record.attestationUid);
    gateway.tamper(anchored.record.attestationUid, { revocationTime: 0n, expirationTime: 1n });
    const expired = await anchor.query(anchored.record.attestationUid);
    const absent = await anchor.query(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );

    // Then verification fails closed with typed outcomes rather than a projection
    expect(tampered).toEqual({ kind: 'rejected', reason: 'digest-mismatch' });
    expect(wrongRecipient).toEqual({ kind: 'rejected', reason: 'recipient-mismatch' });
    expect(revoked).toEqual({ kind: 'rejected', reason: 'revoked' });
    expect(expired).toEqual({ kind: 'rejected', reason: 'expired' });
    expect(absent).toEqual({ kind: 'not-found' });
  });
});
