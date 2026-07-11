import { describe, expect, it } from 'vitest';
import { computeMultiplayerElo } from '../index.js';

type PolicyInput = {
  readonly participants: readonly {
    readonly playerId: string;
    readonly rating?: number;
  }[];
  readonly placements: readonly {
    readonly playerId: string;
    readonly rank: number;
  }[];
};

type PolicyUpdate = {
  readonly playerId: string;
  readonly rank: number;
  readonly ratingBefore: number;
  readonly ratingAfter: number;
  readonly delta: number;
};

describe('computeMultiplayerElo', () => {
  it('Given two unrated players, when one wins, then defaults produce symmetric K=32 updates', () => {
    // Given
    const input: PolicyInput = {
      participants: [{ playerId: 'alice' }, { playerId: 'bob' }],
      placements: [
        { playerId: 'alice', rank: 1 },
        { playerId: 'bob', rank: 2 },
      ],
    };

    // When
    const updates: readonly PolicyUpdate[] = computeMultiplayerElo(input);

    // Then
    expect(updates).toEqual([
      { playerId: 'alice', rank: 1, ratingBefore: 1000, ratingAfter: 1016, delta: 16 },
      { playerId: 'bob', rank: 2, ratingBefore: 1000, ratingAfter: 984, delta: -16 },
    ]);
  });

  it('Given a three-player finish, when pairwise updates are normalized, then deltas are integer zero-sum', () => {
    // Given
    const input: PolicyInput = {
      participants: [{ playerId: 'alice' }, { playerId: 'bob' }, { playerId: 'carol' }],
      placements: [
        { playerId: 'alice', rank: 1 },
        { playerId: 'bob', rank: 2 },
        { playerId: 'carol', rank: 3 },
      ],
    };

    // When
    const updates: readonly PolicyUpdate[] = computeMultiplayerElo(input);

    // Then
    expect(updates.map(({ playerId, delta }) => ({ playerId, delta }))).toEqual([
      { playerId: 'alice', delta: 16 },
      { playerId: 'bob', delta: 0 },
      { playerId: 'carol', delta: -16 },
    ]);
    expect(updates.every((update) => Number.isSafeInteger(update.delta))).toBe(true);
    expect(updates.reduce((sum, update) => sum + update.delta, 0)).toBe(0);
  });

  it('Given tied ranks, when ratings are equal, then every actual score is one half and ratings stay fixed', () => {
    // Given
    const input: PolicyInput = {
      participants: [{ playerId: 'alice' }, { playerId: 'bob' }, { playerId: 'carol' }],
      placements: [
        { playerId: 'alice', rank: 1 },
        { playerId: 'bob', rank: 1 },
        { playerId: 'carol', rank: 1 },
      ],
    };

    // When
    const updates: readonly PolicyUpdate[] = computeMultiplayerElo(input);

    // Then
    expect(updates.map((update) => update.delta)).toEqual([0, 0, 0]);
  });

  it('Given rounded deltas with a positive residual, when allocated, then lexicographic order absorbs it deterministically', () => {
    // Given
    const input: PolicyInput = {
      participants: [
        { playerId: 'charlie', rating: 800 },
        { playerId: 'alpha', rating: 800 },
        { playerId: 'bravo', rating: 1100 },
      ],
      placements: [
        { playerId: 'charlie', rank: 1 },
        { playerId: 'alpha', rank: 2 },
        { playerId: 'bravo', rank: 3 },
      ],
    };

    // When
    const forward: readonly PolicyUpdate[] = computeMultiplayerElo(input);
    const reversed: readonly PolicyUpdate[] = computeMultiplayerElo({
      participants: [...input.participants].reverse(),
      placements: [...input.placements].reverse(),
    });

    // Then
    expect(forward.map(({ playerId, delta }) => ({ playerId, delta }))).toEqual([
      { playerId: 'alpha', delta: 5 },
      { playerId: 'bravo', delta: -27 },
      { playerId: 'charlie', delta: 22 },
    ]);
    expect(reversed).toEqual(forward);
  });

  it.each([
    {
      label: 'fewer than two participants',
      input: {
        participants: [{ playerId: 'alice' }],
        placements: [{ playerId: 'alice', rank: 1 }],
      },
    },
    {
      label: 'duplicate participant ids',
      input: {
        participants: [{ playerId: 'alice' }, { playerId: 'alice' }],
        placements: [
          { playerId: 'alice', rank: 1 },
          { playerId: 'bob', rank: 2 },
        ],
      },
    },
    {
      label: 'a non-safe-integer rating',
      input: {
        participants: [
          { playerId: 'alice', rating: Number.MAX_SAFE_INTEGER + 1 },
          { playerId: 'bob' },
        ],
        placements: [
          { playerId: 'alice', rank: 1 },
          { playerId: 'bob', rank: 2 },
        ],
      },
    },
    {
      label: 'a rank below one',
      input: {
        participants: [{ playerId: 'alice' }, { playerId: 'bob' }],
        placements: [
          { playerId: 'alice', rank: 0 },
          { playerId: 'bob', rank: 2 },
        ],
      },
    },
    {
      label: 'placements that do not exactly match participants',
      input: {
        participants: [{ playerId: 'alice' }, { playerId: 'bob' }],
        placements: [
          { playerId: 'alice', rank: 1 },
          { playerId: 'carol', rank: 2 },
        ],
      },
    },
  ])('Given $label, when ratings are computed, then the policy rejects the input', ({ input }) => {
    // Given
    const compute = () => computeMultiplayerElo(input);

    // Then
    expect(compute).toThrow();
  });
});
