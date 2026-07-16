import { describe, expect, it } from 'vitest';
import {
  createInMemoryEasGateway,
  createInMemoryPromiseOutcomeAnchorStore,
  createPromiseOutcomeAnchor,
} from '../index.js';

const EVENT = {
  eventVersion: 'promise-outcome/v1',
  schemaVersion: 'trust-schema/v1',
  algorithmVersion: 'reliability/v1',
  actorDid: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  subjectDid: 'did:plc:abcdefghijklmnopqrstuvwx',
  outcome: 'kept',
  gameId: 'tragedy:shared-store',
  sequence: 3,
  evidence: {
    uri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/trust.event/3',
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

describe('promise outcome anchor store', () => {
  it('keeps idempotency across independently constructed anchor services', async () => {
    // Given two anchor services sharing one durable-like typed store
    const store = createInMemoryPromiseOutcomeAnchorStore();
    const gateway = createInMemoryEasGateway(CONFIG);
    const firstService = createPromiseOutcomeAnchor(gateway, store);
    const restartedService = createPromiseOutcomeAnchor(gateway, store);

    // When a restarted service receives an identical event
    const first = await firstService.anchor(EVENT, '2026-07-16T12:01:00.000Z');
    const duplicate = await restartedService.anchor(EVENT, '2026-07-16T12:02:00.000Z');

    // Then it returns the durable first record rather than resubmitting
    expect(duplicate).toEqual(first);
  });
});
