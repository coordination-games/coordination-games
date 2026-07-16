import { getAddress, isAddress } from 'ethers';
import { parseEasAttestation } from './eas-attestation-parse.js';
import { createPromiseOutcomeAttestation, decodePromiseOutcomeEasData } from './promise-outcome.js';
import {
  type Bytes32,
  type EasGateway,
  type EasGatewayConfig,
  type PromiseOutcomeAnchorRecord,
  type PromiseOutcomeAnchorResult,
  type PromiseOutcomeAnchorStore,
  type PromiseOutcomeQueryResult,
  ZERO_ADDRESS,
  ZERO_BYTES32,
} from './promise-outcome-types.js';

function isBytes32(value: unknown): value is Bytes32 {
  return typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isAddressValue(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && isAddress(value) && getAddress(value) === value;
}

function isGatewayConfig(value: EasGatewayConfig): boolean {
  return (
    Number.isSafeInteger(value.chainId) &&
    value.chainId > 0 &&
    isAddressValue(value.easContract) &&
    isAddressValue(value.attester) &&
    isBytes32(value.schemaUid)
  );
}

function anchorRecord(
  config: EasGatewayConfig,
  attestationUid: Bytes32,
  txHash: Bytes32,
  eventIdentity: Bytes32,
  eventDigest: Bytes32,
  anchoredAt: string,
): PromiseOutcomeAnchorRecord {
  return {
    chainId: config.chainId,
    easContract: config.easContract,
    schemaUid: config.schemaUid,
    attestationUid,
    attester: config.attester,
    txHash,
    eventIdentity,
    eventDigest,
    anchoredAt,
  };
}

export type PromiseOutcomeAnchor = {
  anchor(input: unknown, anchoredAt: string): Promise<PromiseOutcomeAnchorResult>;
  query(uid: string): Promise<PromiseOutcomeQueryResult>;
};

export function createInMemoryPromiseOutcomeAnchorStore(): PromiseOutcomeAnchorStore {
  const recordsByDigest = new Map<Bytes32, PromiseOutcomeAnchorRecord>();
  const recordsByUid = new Map<Bytes32, PromiseOutcomeAnchorRecord>();
  return {
    async getByEventDigest(eventDigest: Bytes32): Promise<PromiseOutcomeAnchorRecord | null> {
      return recordsByDigest.get(eventDigest) ?? null;
    },
    async getByAttestationUid(attestationUid: Bytes32): Promise<PromiseOutcomeAnchorRecord | null> {
      return recordsByUid.get(attestationUid) ?? null;
    },
    async save(record: PromiseOutcomeAnchorRecord): Promise<void> {
      recordsByDigest.set(record.eventDigest, record);
      recordsByUid.set(record.attestationUid, record);
    },
  };
}

function isoFromUnixSeconds(time: bigint): string | null {
  const maximumDateSeconds = 8_640_000_000_000n;
  if (time > maximumDateSeconds) return null;
  return new Date(Number(time) * 1000).toISOString();
}

export function createPromiseOutcomeAnchor(
  gateway: EasGateway,
  store: PromiseOutcomeAnchorStore = createInMemoryPromiseOutcomeAnchorStore(),
): PromiseOutcomeAnchor {
  return {
    async anchor(input: unknown, anchoredAt: string): Promise<PromiseOutcomeAnchorResult> {
      const created = createPromiseOutcomeAttestation(input);
      if (created.kind === 'rejected') return created;
      if (!isInstant(anchoredAt) || !isGatewayConfig(gateway.config)) {
        return { kind: 'rejected', reason: 'invalid-anchor' };
      }
      const cached = await store.getByEventDigest(created.attestation.eventDigest);
      if (cached !== null) return { kind: 'anchored', record: cached };
      const submitted = await gateway.attest({
        schema: gateway.config.schemaUid,
        recipient: ZERO_ADDRESS,
        expirationTime: 0n,
        revocable: true,
        refUid: ZERO_BYTES32,
        data: created.attestation.encodedData,
        value: 0n,
        anchoredAt,
      });
      if (submitted.kind === 'rejected') return submitted;
      const record = anchorRecord(
        gateway.config,
        submitted.attestationUid,
        submitted.txHash,
        created.attestation.eventIdentity,
        created.attestation.eventDigest,
        anchoredAt,
      );
      await store.save(record);
      return { kind: 'anchored', record };
    },
    async query(uid: string): Promise<PromiseOutcomeQueryResult> {
      if (!isBytes32(uid)) return { kind: 'rejected', reason: 'invalid-uid' };
      if (!isGatewayConfig(gateway.config))
        return { kind: 'rejected', reason: 'invalid-attestation' };
      let raw: unknown;
      try {
        raw = await gateway.getAttestation(uid);
      } catch (error) {
        if (error instanceof Error) return { kind: 'rejected', reason: 'invalid-attestation' };
        throw error;
      }
      if (raw === null) return { kind: 'not-found' };
      const attestation = parseEasAttestation(raw);
      if (attestation === null || attestation.uid === ZERO_BYTES32) {
        return { kind: 'not-found' };
      }
      if (
        attestation.uid !== uid ||
        attestation.refUid !== ZERO_BYTES32 ||
        !attestation.revocable
      ) {
        return { kind: 'rejected', reason: 'invalid-attestation' };
      }
      if (attestation.schema !== gateway.config.schemaUid) {
        return { kind: 'rejected', reason: 'schema-mismatch' };
      }
      if (attestation.recipient !== ZERO_ADDRESS) {
        return { kind: 'rejected', reason: 'recipient-mismatch' };
      }
      if (attestation.attester !== gateway.config.attester) {
        return { kind: 'rejected', reason: 'attester-mismatch' };
      }
      if (attestation.revocationTime !== 0n) return { kind: 'rejected', reason: 'revoked' };
      if (attestation.expirationTime !== 0n) return { kind: 'rejected', reason: 'expired' };
      const decoded = decodePromiseOutcomeEasData(attestation.data);
      if (decoded.kind === 'rejected') return decoded;
      const recomputed = createPromiseOutcomeAttestation(decoded.decoded.event);
      if (recomputed.kind === 'rejected') return { kind: 'rejected', reason: 'invalid-data' };
      if (recomputed.attestation.eventDigest !== decoded.decoded.eventDigest) {
        return { kind: 'rejected', reason: 'digest-mismatch' };
      }
      const cached = await store.getByAttestationUid(uid);
      if (cached !== null && cached.eventDigest !== recomputed.attestation.eventDigest) {
        return { kind: 'rejected', reason: 'digest-mismatch' };
      }
      const anchoredAt = isoFromUnixSeconds(attestation.time);
      if (anchoredAt === null) return { kind: 'rejected', reason: 'invalid-attestation' };
      const record =
        cached ??
        anchorRecord(
          gateway.config,
          uid,
          ZERO_BYTES32,
          recomputed.attestation.eventIdentity,
          recomputed.attestation.eventDigest,
          anchoredAt,
        );
      return { kind: 'verified', record };
    },
  };
}
