import {
  createInMemoryEasGateway,
  createPromiseOutcomeAnchor,
  createPromiseOutcomeAttestation,
} from './index.js';

const EVENT = {
  eventVersion: 'promise-outcome/v1',
  schemaVersion: 'trust-schema/v1',
  algorithmVersion: 'reliability/v1',
  actorDid: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  subjectDid: 'did:plc:abcdefghijklmnopqrstuvwx',
  outcome: 'kept',
  gameId: 'tragedy:sample-20260716',
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

const gateway = createInMemoryEasGateway(CONFIG);
const anchor = createPromiseOutcomeAnchor(gateway);
const anchored = await anchor.anchor(EVENT, '2026-07-16T12:01:00.000Z');

if (anchored.kind !== 'anchored') throw new TypeError('Sample event did not anchor');

const verified = await anchor.query(anchored.record.attestationUid);
const broken = createPromiseOutcomeAttestation({ ...EVENT, outcome: 'broken' });
const changedEvidence = createPromiseOutcomeAttestation({
  ...EVENT,
  evidence: {
    ...EVENT.evidence,
    cid: 'bafybeibwzif4qsi6fc6p2z32d27zrifnnzvkzgy6qpqyr2e6bsqigvtsqe',
  },
});

if (broken.kind !== 'created' || changedEvidence.kind !== 'created') {
  throw new TypeError('Sample tamper events did not encode');
}

gateway.tamper(anchored.record.attestationUid, { data: broken.attestation.encodedData });
const outcomeTamper = await anchor.query(anchored.record.attestationUid);
gateway.tamper(anchored.record.attestationUid, { data: changedEvidence.attestation.encodedData });
const evidenceTamper = await anchor.query(anchored.record.attestationUid);

process.stdout.write(
  `${JSON.stringify({ anchored, verified, outcomeTamper, evidenceTamper }, null, 2)}\n`,
);
