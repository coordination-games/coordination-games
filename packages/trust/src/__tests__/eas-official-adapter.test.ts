import { Interface } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  createEthersEasGateway,
  createPromiseOutcomeAnchor,
  createPromiseOutcomeAttestation,
  EAS_CONTRACT_ABI,
  ZERO_ADDRESS,
} from '../index.js';

const OFFICIAL_EAS_ABI = [
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) payable returns (bytes32)',
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data) attestation)',
  'event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)',
] as const;

const EVENT = {
  eventVersion: 'promise-outcome/v1',
  schemaVersion: 'trust-schema/v1',
  algorithmVersion: 'reliability/v1',
  actorDid: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  subjectDid: 'did:plc:abcdefghijklmnopqrstuvwx',
  outcome: 'kept',
  gameId: 'tragedy:official-eas',
  sequence: 7,
  evidence: {
    uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/trust.event/7',
    cid: 'bafybeigdyrzt6ic3b7q4tf6h3y2x4cn27lu5ps5h7izngyztby6cd3k6da',
  },
  observedAt: '2026-07-16T12:00:00.000Z',
} as const;

const CONFIG = {
  chainId: 11155420,
  easContract: '0x4200000000000000000000000000000000000021',
  schemaUid: '0x16d2be53c55b4fd4d608144892ebeb1102b181ad099c06dc7536d3517dd5ba99',
  attester: '0x14791697260E4c9A71f18484C9f997B308e59325',
} as const;

const UID = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OFFICIAL_INTERFACE = new Interface(OFFICIAL_EAS_ABI);

function officialLog(recipient: string, attester: string, schemaUid: string) {
  return OFFICIAL_INTERFACE.encodeEventLog('Attested', [recipient, attester, UID, schemaUid]);
}

describe('official EAS adapter surface', () => {
  it('extracts a UID from an official log after malformed and unrelated siblings', async () => {
    // Given independently encoded deployed-EAS logs with malformed siblings first
    const gateway = createEthersEasGateway(CONFIG, {
      async attest() {
        return {
          hash: TX_HASH,
          async wait() {
            return {
              logs: [
                { topics: [UID], data: '0x' },
                officialLog(ZERO_ADDRESS, CONFIG.attester, CONFIG.schemaUid),
              ],
            };
          },
        };
      },
      async getAttestation() {
        return null;
      },
    });

    // When the canonical event is anchored through the production adapter
    const result = await createPromiseOutcomeAnchor(gateway).anchor(
      EVENT,
      '2026-07-16T12:01:00.000Z',
    );

    // Then the later official event supplies the UID
    expect(result).toMatchObject({ kind: 'anchored', record: { attestationUid: UID } });
  });

  it('rejects official logs whose recipient, attester, or schema does not match', async () => {
    // Given independently encoded official events with one incompatible invariant each
    const mismatches = [
      officialLog(CONFIG.attester, CONFIG.attester, CONFIG.schemaUid),
      officialLog(ZERO_ADDRESS, ZERO_ADDRESS, CONFIG.schemaUid),
      officialLog(ZERO_ADDRESS, CONFIG.attester, UID),
    ];

    // When each receipt is submitted through the adapter
    const results = await Promise.all(
      mismatches.map(async (log) => {
        const gateway = createEthersEasGateway(CONFIG, {
          async attest() {
            return {
              hash: TX_HASH,
              async wait() {
                return { logs: [log] };
              },
            };
          },
          async getAttestation() {
            return null;
          },
        });
        return createPromiseOutcomeAnchor(gateway).anchor(EVENT, '2026-07-16T12:01:00.000Z');
      }),
    );

    // Then none can be misreported as a submitted attestation
    expect(results).toEqual([
      { kind: 'rejected', reason: 'gateway-rejected' },
      { kind: 'rejected', reason: 'gateway-rejected' },
      { kind: 'rejected', reason: 'gateway-rejected' },
    ]);
  });

  it('normalizes nested official structs and rejects an unrepresentable uint64 time', async () => {
    // Given an independently encoded event returned in ethers' nested tuple shape
    const created = createPromiseOutcomeAttestation(EVENT);
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    const tuple = [
      UID,
      CONFIG.schemaUid,
      1_784_265_660n,
      0n,
      0n,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      ZERO_ADDRESS,
      CONFIG.attester,
      true,
      created.attestation.encodedData,
    ];
    const officialResult = OFFICIAL_INTERFACE.encodeFunctionResult('getAttestation', [tuple]);
    const productionInterface = new Interface(EAS_CONTRACT_ABI);

    // When production decodes bytes encoded by the independent official fixture
    expect(productionInterface.decodeFunctionResult('getAttestation', officialResult)).toHaveLength(
      1,
    );
    const gateway = createEthersEasGateway(CONFIG, {
      async attest() {
        throw new Error('not used by query');
      },
      async getAttestation() {
        return [tuple];
      },
    });
    const anchor = createPromiseOutcomeAnchor(gateway);

    // When the tuple is queried, then its canonical event is verified
    expect(await anchor.query(UID)).toMatchObject({ kind: 'verified' });

    // When the untrusted uint64 timestamp exceeds JavaScript's Date range, then it fails closed
    tuple[2] = 18_446_744_073_709_551_615n;
    expect(await anchor.query(UID)).toEqual({ kind: 'rejected', reason: 'invalid-attestation' });
  });
});
