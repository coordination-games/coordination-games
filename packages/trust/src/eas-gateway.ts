import { getAddress, Interface, isAddress, keccak256, solidityPacked } from 'ethers';
import type {
  Bytes32,
  EasAttestationRequest,
  EasGateway,
  EasGatewayConfig,
  EasGatewaySubmission,
  EthersEasContract,
  EthersEasGateway,
  EthersEasReceipt,
  HexData,
} from './promise-outcome-types.js';

export const EAS_CONTRACT_ABI = [
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)',
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data) attestation)',
  'event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)',
] as const;

const EAS_INTERFACE = new Interface(EAS_CONTRACT_ABI);

function isBytes32(value: unknown): value is Bytes32 {
  return typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
}

function isAddressValue(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && isAddress(value) && getAddress(value) === value;
}

function isHexData(value: unknown): value is HexData {
  return typeof value === 'string' && /^0x[0-9a-f]*$/.test(value);
}

function submitRejected(): EasGatewaySubmission {
  return { kind: 'rejected', reason: 'gateway-rejected' };
}

function getAttestationUid(
  receipt: EthersEasReceipt | null,
  request: EasAttestationRequest,
  config: EasGatewayConfig,
): Bytes32 | null {
  if (receipt === null) return null;
  for (const log of receipt.logs) {
    try {
      const parsed = EAS_INTERFACE.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name !== 'Attested') continue;
      const uid = parsed.args.uid;
      const recipient = parsed.args.recipient;
      const attester = parsed.args.attester;
      const schemaUid = parsed.args.schemaUID;
      if (
        isBytes32(uid) &&
        isAddressValue(recipient) &&
        isAddressValue(attester) &&
        isBytes32(schemaUid) &&
        recipient === request.recipient &&
        attester === config.attester &&
        schemaUid === request.schema &&
        request.schema === config.schemaUid
      ) {
        return uid;
      }
    } catch (error) {
      if (error instanceof Error) continue;
      throw error;
    }
  }
  return null;
}

function normalizeEthersAttestation(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const tuple = value.length === 1 && Array.isArray(value[0]) ? value[0] : value;
  if (tuple.length !== 10) return value;
  return {
    uid: tuple[0],
    schema: tuple[1],
    time: tuple[2],
    expirationTime: tuple[3],
    revocationTime: tuple[4],
    refUid: tuple[5],
    recipient: tuple[6],
    attester: tuple[7],
    revocable: tuple[8],
    data: tuple[9],
  };
}

export function createEthersEasGateway(
  config: EasGatewayConfig,
  contract: EthersEasContract,
): EthersEasGateway {
  return {
    config,
    async attest(request: EasAttestationRequest): Promise<EasGatewaySubmission> {
      try {
        const transaction = await contract.attest({
          schema: request.schema,
          data: {
            recipient: request.recipient,
            expirationTime: request.expirationTime,
            revocable: request.revocable,
            refUID: request.refUid,
            data: request.data,
            value: request.value,
          },
        });
        const uid = getAttestationUid(await transaction.wait(), request, config);
        return uid === null || !isBytes32(transaction.hash)
          ? submitRejected()
          : { kind: 'submitted', attestationUid: uid, txHash: transaction.hash };
      } catch (error) {
        if (error instanceof Error) return submitRejected();
        throw error;
      }
    },
    async getAttestation(uid: Bytes32): Promise<unknown> {
      return normalizeEthersAttestation(await contract.getAttestation(uid));
    },
  };
}

export type InMemoryEasGateway = EasGateway & {
  tamper(uid: Bytes32, changes: Readonly<Record<string, unknown>>): void;
};

type MutableAttestation = {
  uid: Bytes32;
  schema: Bytes32;
  time: bigint;
  expirationTime: bigint;
  revocationTime: bigint;
  refUid: Bytes32;
  recipient: `0x${string}`;
  attester: `0x${string}`;
  revocable: boolean;
  data: HexData;
};

function createUid(
  request: EasAttestationRequest,
  config: EasGatewayConfig,
  time: bigint,
): Bytes32 | null {
  const hash = keccak256(
    solidityPacked(
      ['bytes32', 'address', 'address', 'uint64', 'uint64', 'bool', 'bytes32', 'bytes', 'uint32'],
      [
        request.schema,
        request.recipient,
        config.attester,
        time,
        request.expirationTime,
        request.revocable,
        request.refUid,
        request.data,
        0,
      ],
    ),
  );
  return isBytes32(hash) ? hash : null;
}

export function createInMemoryEasGateway(config: EasGatewayConfig): InMemoryEasGateway {
  const records = new Map<Bytes32, MutableAttestation>();
  return {
    config,
    async attest(request: EasAttestationRequest): Promise<EasGatewaySubmission> {
      const time = BigInt(Math.floor(Date.parse(request.anchoredAt) / 1000));
      const uid = createUid(request, config, time);
      if (uid === null) return submitRejected();
      records.set(uid, {
        uid,
        schema: request.schema,
        time,
        expirationTime: request.expirationTime,
        revocationTime: 0n,
        refUid: request.refUid,
        recipient: request.recipient,
        attester: config.attester,
        revocable: request.revocable,
        data: request.data,
      });
      return { kind: 'submitted', attestationUid: uid, txHash: uid };
    },
    async getAttestation(uid: Bytes32): Promise<unknown> {
      const record = records.get(uid);
      return record === undefined ? null : { ...record };
    },
    tamper(uid: Bytes32, changes: Readonly<Record<string, unknown>>): void {
      const record = records.get(uid);
      if (record === undefined) return;
      if (isBytes32(changes.uid)) record.uid = changes.uid;
      if (isBytes32(changes.schema)) record.schema = changes.schema;
      if (typeof changes.time === 'bigint') record.time = changes.time;
      if (typeof changes.expirationTime === 'bigint')
        record.expirationTime = changes.expirationTime;
      if (typeof changes.revocationTime === 'bigint')
        record.revocationTime = changes.revocationTime;
      if (isBytes32(changes.refUid)) record.refUid = changes.refUid;
      if (isAddressValue(changes.recipient)) record.recipient = changes.recipient;
      if (isAddressValue(changes.attester)) record.attester = changes.attester;
      if (typeof changes.revocable === 'boolean') record.revocable = changes.revocable;
      if (isHexData(changes.data)) record.data = changes.data;
    },
  };
}
