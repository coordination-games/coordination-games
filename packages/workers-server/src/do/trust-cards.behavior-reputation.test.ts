import { describe, expect, it } from 'vitest';
import { buildVisibleTrustArtifacts } from './trust-cards.js';

const artifact = (id: string, digit: string, observedAt: string) => ({
  id,
  digest: `0x${digit.repeat(64)}`,
  observedAt,
});

describe('behavior reputation publication artifacts', () => {
  it('publishes only post-reveal behavior envelopes while preserving existing trust-card fields', () => {
    const artifacts = buildVisibleTrustArtifacts(
      {
        round: 2,
        phase: 'playing',
        players: [{ id: 'alpha', influence: 0, vp: 0 }],
      },
      {
        gameId: 'game-1',
        gameType: 'tragedy-of-the-commons',
        handleMap: { alpha: 'Alpha' },
        finished: false,
      },
      2,
      [],
      {
        gameId: 'game-1',
        revealArtifact: artifact('reveal-1', '1', '2026-07-16T12:00:01.000Z'),
        postRevealArtifact: artifact('snapshot-1', '2', '2026-07-16T12:00:02.000Z'),
        previousSnapshotArtifact: artifact('snapshot-0', '3', '2026-07-16T12:00:00.000Z'),
        reveal: {
          round: 1,
          actions: [
            {
              playerId: 'alpha',
              action: {
                type: 'build_structure',
                intersectionId: 'north',
                structureType: 'solar-farm',
              },
            },
          ],
        },
        previousPublicSnapshot: { tiles: [], structures: [] },
        postRevealSnapshot: {
          tiles: [],
          structures: [
            {
              id: 'alpha-solar-farm-north',
              ownerId: 'alpha',
              intersectionId: 'north',
              type: 'solar-farm',
            },
          ],
        },
      },
    );

    expect(artifacts.cards[0]).toMatchObject({ schemaVersion: 'trust-card/v1', agentId: 'alpha' });
    expect(artifacts.envelopes).toContainEqual(
      expect.objectContaining({
        category: 'behavior',
        eventType: 'renewable-infrastructure',
        privacy: expect.objectContaining({
          containsPrivateChat: false,
          containsHiddenState: false,
        }),
      }),
    );
  });
});
