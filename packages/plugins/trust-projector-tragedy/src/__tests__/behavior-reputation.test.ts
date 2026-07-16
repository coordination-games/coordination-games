import { describe, expect, it } from 'vitest';
import { deriveTragedyBehaviorReputation } from '../behavior-reputation.js';

const artifacts = {
  before: {
    id: 'snapshot:round-1:before',
    digest: '0x1111111111111111111111111111111111111111111111111111111111111111',
    observedAt: '2026-07-16T12:00:00.000Z',
  },
  reveal: {
    id: 'reveal:round-1',
    digest: '0x2222222222222222222222222222222222222222222222222222222222222222',
    observedAt: '2026-07-16T12:00:01.000Z',
  },
  after: {
    id: 'snapshot:round-1:after',
    digest: '0x3333333333333333333333333333333333333333333333333333333333333333',
    observedAt: '2026-07-16T12:00:02.000Z',
  },
} as const;

const publicSnapshots = {
  previous: {
    tiles: [{ id: 'tile-1', health: 10, maxHealth: 20 }],
    structures: [],
  },
  current: {
    tiles: [{ id: 'tile-1', health: 4, maxHealth: 20 }],
    structures: [
      {
        id: 'alpha-solar-farm-north',
        ownerId: 'alpha',
        intersectionId: 'north',
        type: 'solar-farm',
      },
    ],
  },
} as const;

const reveal = {
  round: 1,
  actions: [
    {
      playerId: 'alpha',
      action: { type: 'build_structure', intersectionId: 'north', structureType: 'solar-farm' },
    },
    {
      playerId: 'beta',
      action: { type: 'extract_tile', tileId: 'tile-1', resource: 'water', level: 'high' },
    },
  ],
} as const;

function derive(input: {
  readonly reveal?: unknown;
  readonly current?: unknown;
  readonly previous?: unknown;
}) {
  return deriveTragedyBehaviorReputation({
    gameId: 'game-1',
    revealArtifact: artifacts.reveal,
    postRevealArtifact: artifacts.after,
    previousSnapshotArtifact: artifacts.before,
    reveal: input.reveal,
    postRevealSnapshot: input.current,
    previousPublicSnapshot: input.previous,
  });
}

describe('Tragedy behavior reputation', () => {
  it('Given equivalent public reveal and snapshot artifacts, when submission order changes, then events are byte-identical', () => {
    const canonical = derive({
      reveal,
      previous: publicSnapshots.previous,
      current: publicSnapshots.current,
    });
    const reordered = derive({
      reveal: { ...reveal, actions: [...reveal.actions].reverse() },
      previous: publicSnapshots.previous,
      current: publicSnapshots.current,
    });

    expect(JSON.stringify(reordered)).toBe(JSON.stringify(canonical));
    expect(canonical.events).toEqual([
      expect.objectContaining({ subjectPlayerId: 'alpha', outcome: 'positive' }),
      expect.objectContaining({ subjectPlayerId: 'beta', outcome: 'negative' }),
    ]);
    expect(canonical.events[0]?.evidence.reveal.digest).not.toBe(artifacts.reveal.digest);
    expect(canonical.events[0]?.evidence.postRevealSnapshot.digest).not.toBe(
      artifacts.after.digest,
    );
  });

  it('Given pending actions without a Task 17 reveal, when reputation is derived, then it remains neutral', () => {
    const result = derive({
      current: {
        ...publicSnapshots.current,
        submittedActions: { alpha: reveal.actions[0]?.action, beta: null },
      },
      previous: publicSnapshots.previous,
    });

    expect(result).toEqual({ version: 'tragedy-behavior-reputation/v1', events: [] });
  });

  it('Given duplicate or malformed public reveal entries, when reputation is derived, then it creates no claims', () => {
    const duplicate = derive({
      reveal: { ...reveal, actions: [reveal.actions[0], reveal.actions[0]] },
      previous: publicSnapshots.previous,
      current: publicSnapshots.current,
    });
    const malformed = derive({
      reveal: { round: 1, actions: [{ playerId: 'alpha', action: { type: 'extract_tile' } }] },
      previous: publicSnapshots.previous,
      current: publicSnapshots.current,
    });

    expect(duplicate.events).toEqual([]);
    expect(malformed.events).toEqual([]);
  });

  it('Given a pass or unproven action, when no observable effect supports it, then it remains neutral', () => {
    const result = derive({
      reveal: { round: 1, actions: [{ playerId: 'alpha', action: { type: 'pass' } }] },
      previous: publicSnapshots.previous,
      current: publicSnapshots.previous,
    });

    expect(result.events).toEqual([]);
  });

  it('Given a non-canonical timestamp or a reused semantic solar structure, when evidence is derived, then it remains neutral', () => {
    const malformed = deriveTragedyBehaviorReputation({
      gameId: 'game-1',
      revealArtifact: { ...artifacts.reveal, observedAt: '2026-07-16T12:00:01Z' },
      postRevealArtifact: artifacts.after,
      previousSnapshotArtifact: artifacts.before,
      reveal: { round: 1, actions: [reveal.actions[0]] },
      previousPublicSnapshot: publicSnapshots.current,
      postRevealSnapshot: {
        ...publicSnapshots.current,
        structures: [{ ...publicSnapshots.current.structures[0], id: 'caller-changed-id' }],
      },
    });

    expect(malformed.events).toEqual([]);
  });
});
