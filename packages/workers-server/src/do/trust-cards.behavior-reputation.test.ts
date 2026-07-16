import { describe, expect, it } from 'vitest';
import { buildBehaviorReputationInput, buildVisibleTrustArtifacts } from './trust-cards.js';

describe('behavior reputation publication artifacts', () => {
  it('creates one canonical input for a new reveal and suppresses equivalent replay snapshots', () => {
    const previous = { tiles: [], structures: [] };
    const current = {
      ...previous,
      lastRoundReveal: { round: 1, actions: [{ playerId: 'alpha', action: { type: 'pass' } }] },
    };
    const first = buildBehaviorReputationInput({
      gameId: 'game-1',
      previousPublicSnapshot: previous,
      postRevealSnapshot: current,
      snapshotIndex: 1,
      observedAt: '2026-07-16T12:00:00.000Z',
    });
    const repeated = buildBehaviorReputationInput({
      gameId: 'game-1',
      previousPublicSnapshot: current,
      postRevealSnapshot: {
        ...current,
        lastRoundReveal: { actions: [{ action: { type: 'pass' }, playerId: 'alpha' }], round: 1 },
      },
      snapshotIndex: 2,
      observedAt: '2026-07-16T12:00:01.000Z',
    });
    const later = buildBehaviorReputationInput({
      gameId: 'game-1',
      previousPublicSnapshot: current,
      postRevealSnapshot: {
        ...current,
        lastRoundReveal: { round: 2, actions: [{ playerId: 'alpha', action: { type: 'pass' } }] },
      },
      snapshotIndex: 3,
      observedAt: '2026-07-16T12:00:02.000Z',
    });
    expect(first).toBeDefined();
    expect(first?.revealArtifact.digest).not.toMatch(/^0x0+$/);
    expect(repeated).toBeUndefined();
    expect(later).toBeDefined();
  });
  it('publishes only post-reveal behavior envelopes while preserving existing trust-card fields', () => {
    const postRevealSnapshot = {
      tiles: [],
      structures: [
        {
          id: 'alpha-solar-farm-north',
          ownerId: 'alpha',
          intersectionId: 'north',
          type: 'solar-farm',
        },
      ],
      lastRoundReveal: {
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
    };
    const behavior = buildBehaviorReputationInput({
      gameId: 'game-1',
      previousPublicSnapshot: { tiles: [], structures: [] },
      postRevealSnapshot,
      snapshotIndex: 1,
      observedAt: '2026-07-16T12:00:02.000Z',
    });
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
      behavior,
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
