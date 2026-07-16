import { writeFile } from 'node:fs/promises';
import type { WalletBindingRecord } from './index.js';
import { createMemoryNonceConsumer, verifyWalletBindingRecord } from './index.js';

const SAMPLE_RECORD: WalletBindingRecord = {
  recordVersion: 'wallet-binding/v1',
  did: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  address: '0x14791697260E4c9A71f18484C9f997B308e59325',
  domain: 'games.coop',
  uri: 'https://games.coop/trust/bind',
  chainId: 11155420,
  nonce: 'BindNonce20260716',
  issuedAt: '2026-07-16T11:59:00.000Z',
  signature:
    '0x0c907c8e23ad0ad14fc8853ebea7efd88cd4fc3ab644c83f13860736010de63726fab75b12c9ebc21daf2515916b345bc0d1e129e16ea088fa3aa6d609ab360a1c',
  signatureType: 'eip191',
  lifecycle: { status: 'active' },
};

const expectation = {
  did: SAMPLE_RECORD.did,
  domain: SAMPLE_RECORD.domain,
  uri: SAMPLE_RECORD.uri,
  chainId: SAMPLE_RECORD.chainId,
  nonce: SAMPLE_RECORD.nonce,
  now: new Date('2026-07-16T12:00:00.000Z'),
  maxAgeMs: 5 * 60_000,
  maxFutureSkewMs: 10_000,
};
const nonceConsumer = createMemoryNonceConsumer();
const verification = verifyWalletBindingRecord(SAMPLE_RECORD, expectation, nonceConsumer);
const replayVerification = verifyWalletBindingRecord(SAMPLE_RECORD, expectation, nonceConsumer);
const output = `${JSON.stringify({ record: SAMPLE_RECORD, verification, replayVerification }, null, 2)}\n`;
const target = process.argv[2];

if (target === undefined) {
  process.stdout.write(output);
} else {
  await writeFile(target, output, 'utf8');
}
