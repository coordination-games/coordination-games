import { describe, expect, it, vi } from 'vitest';

import { makeMemoryStorage } from '../__tests__/test-helpers.js';
import { buildVisibleTrustArtifacts } from './trust-cards.js';
import {
  publishTrustEvidenceBundle,
  type TrustPublishRecord,
  trustEvidenceBundleKey,
  trustPublishRecordKey,
} from './trust-publisher.js';

const meta = {
  gameId: 'game-1',
  gameType: 'tragedy-of-the-commons',
  handleMap: { alice: 'Alicia Commons' },
  finished: false,
};

function buildEnvelopes() {
  return buildVisibleTrustArtifacts(
    {
      round: 2,
      phase: 'playing',
      players: [
        {
          id: 'alice',
          influence: 2,
          vp: 5,
          resources: { timber: 3, ore: 4 },
          regionsControlled: ['forest'],
          lastAction: 'build_settlement',
        },
      ],
    },
    meta,
    9,
  ).envelopes;
}

describe('trust evidence publisher', () => {
  it('prepares and stores canonical trust evidence when Lighthouse is not enabled', async () => {
    const storage = makeMemoryStorage();
    const result = await publishTrustEvidenceBundle({
      storage,
      env: {},
      gameId: meta.gameId,
      gameType: meta.gameType,
      progressCounter: 9,
      envelopes: buildEnvelopes(),
      now: '2026-04-28T16:30:00.000Z',
    });

    expect(result.record).toMatchObject({
      status: 'prepared',
      publisher: 'none',
      gameId: 'game-1',
      progressCounter: 9,
      envelopeCount: 1,
    });
    expect(result.record.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.record.byteLength).toBeGreaterThan(0);

    const storedRecord = await storage.get<TrustPublishRecord>(trustPublishRecordKey(9));
    const storedBundle = await storage.get(trustEvidenceBundleKey(9));
    expect(storedRecord?.digest).toBe(result.record.digest);
    expect(storedBundle).toBeTruthy();
  });

  it('uploads through Lighthouse when enabled and a key is present', async () => {
    const storage = makeMemoryStorage();
    let capturedInit: Parameters<typeof fetch>[1];
    const fetcherMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        capturedInit = init;
        return Response.json({ Hash: 'bafkreiworkertrustcid' }, { status: 200 });
      },
    );

    const result = await publishTrustEvidenceBundle({
      storage,
      env: {
        TRUST_IPFS_PUBLISH_ENABLED: 'true',
        LIGHTHOUSE_API_KEY: 'test-key',
      },
      gameId: meta.gameId,
      gameType: meta.gameType,
      progressCounter: 10,
      envelopes: buildEnvelopes(),
      now: '2026-04-28T16:31:00.000Z',
      fetcher: fetcherMock as unknown as typeof fetch,
    });

    expect(fetcherMock).toHaveBeenCalledTimes(1);
    expect(capturedInit).toMatchObject({ method: 'POST' });
    expect(result.record).toMatchObject({
      status: 'uploaded',
      publisher: 'lighthouse',
      cid: 'bafkreiworkertrustcid',
      uri: 'ipfs://bafkreiworkertrustcid',
      gatewayStatus: 'pending',
    });
  });

  it('marks the record available when optional gateway verification succeeds', async () => {
    const storage = makeMemoryStorage();
    const fetcherMock = vi
      .fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        Response.json({ Hash: 'bafkreiavailable' }, { status: 200 }),
      )
      .mockResolvedValueOnce(Response.json({ Hash: 'bafkreiavailable' }, { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await publishTrustEvidenceBundle({
      storage,
      env: {
        TRUST_IPFS_PUBLISH_ENABLED: 'true',
        TRUST_IPFS_VERIFY_GATEWAY: 'true',
        LIGHTHOUSE_API_KEY: 'test-key',
      },
      gameId: meta.gameId,
      gameType: meta.gameType,
      progressCounter: 11,
      envelopes: buildEnvelopes(),
      now: '2026-04-28T16:32:00.000Z',
      fetcher: fetcherMock as unknown as typeof fetch,
    });

    expect(fetcherMock).toHaveBeenCalledTimes(2);
    expect(result.record).toMatchObject({
      status: 'available',
      gatewayStatus: 'available',
      cid: 'bafkreiavailable',
    });
    expect(result.record.gatewayVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
