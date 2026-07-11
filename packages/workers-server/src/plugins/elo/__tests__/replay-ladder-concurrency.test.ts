import { computeMultiplayerElo, type LadderPlacement } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import { LadderPersistenceError, recordReplayLadderMatch } from '../index.js';
import { type LadderFakeStore, makeLadderFakeD1 } from './ladder-d1-fake.js';

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await gate;
  };
}

const FIRST: readonly LadderPlacement[] = [
  { playerId: 'alice', rank: 1 },
  { playerId: 'bob', rank: 2 },
];
const SECOND: readonly LadderPlacement[] = [
  { playerId: 'alice', rank: 2 },
  { playerId: 'bob', rank: 1 },
];

function applySerial(
  ratings: ReadonlyMap<string, number>,
  placements: readonly LadderPlacement[],
): Map<string, number> {
  return new Map(
    computeMultiplayerElo({
      participants: [...ratings].map(([playerId, rating]) => ({ playerId, rating })),
      placements,
    }).map((update) => [update.playerId, update.ratingAfter]),
  );
}

function ratingSignature(ratings: ReadonlyMap<string, number>): string {
  return [...ratings]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([playerId, rating]) => `${playerId}:${rating}`)
    .join('|');
}

describe('recordReplayLadderMatch concurrency', () => {
  it('Given two distinct games pre-read one ladder version, when both ingest, then both contribute exactly once in a serial order', async () => {
    // Given
    const state: LadderFakeStore = {
      players: [
        { id: 'alice', handle: 'Alice' },
        { id: 'bob', handle: 'Bob' },
      ],
      versions: [],
      ratings: [],
      results: [],
      audit: [],
      beforeRatingRead: twoPartyBarrier(),
    };
    const db = makeLadderFakeD1(state);

    // When
    const receipts = await Promise.all([
      recordReplayLadderMatch(db, {
        gameId: 'game-1',
        gameType: 'capture-the-lobster',
        replayHash: `0x${'11'.repeat(32)}`,
        resultHash: `0x${'21'.repeat(32)}`,
        placements: FIRST,
        recordedAt: '2026-07-11T12:00:00.000Z',
      }),
      recordReplayLadderMatch(db, {
        gameId: 'game-2',
        gameType: 'capture-the-lobster',
        replayHash: `0x${'12'.repeat(32)}`,
        resultHash: `0x${'22'.repeat(32)}`,
        placements: SECOND,
        recordedAt: '2026-07-11T12:00:01.000Z',
      }),
    ]);

    // Then
    expect(receipts.map((receipt) => receipt.recorded)).toEqual([true, true]);
    expect(state.versions).toEqual([
      expect.objectContaining({ game_type: 'capture-the-lobster', version: 2 }),
    ]);
    expect(state.batchAttempts).toBe(3);
    expect(state.staleVersionFailures).toBe(1);
    expect(state.results).toHaveLength(2);
    expect(state.audit.filter((row) => row.game_id === 'game-1')).toHaveLength(2);
    expect(state.audit.filter((row) => row.game_id === 'game-2')).toHaveLength(2);
    expect(state.ratings.map((row) => row.games_played)).toEqual([2, 2]);

    const initial = new Map([
      ['alice', 1000],
      ['bob', 1000],
    ]);
    const serialOrders = [
      applySerial(applySerial(initial, FIRST), SECOND),
      applySerial(applySerial(initial, SECOND), FIRST),
    ].map(ratingSignature);
    const observed = ratingSignature(
      new Map(state.ratings.map((row) => [row.player_id, row.rating])),
    );
    expect(serialOrders).toContain(observed);
  });

  it('Given every version claim is stale, when retry capacity is exhausted, then a typed persistence error rolls back every attempt', async () => {
    // Given
    const state: LadderFakeStore = {
      players: [
        { id: 'alice', handle: 'Alice' },
        { id: 'bob', handle: 'Bob' },
      ],
      versions: [],
      ratings: [],
      results: [],
      audit: [],
      forceStaleVersion: true,
    };
    const db = makeLadderFakeD1(state);

    // When
    const recording = recordReplayLadderMatch(db, {
      gameId: 'game-stale',
      gameType: 'capture-the-lobster',
      replayHash: `0x${'31'.repeat(32)}`,
      resultHash: `0x${'41'.repeat(32)}`,
      placements: FIRST,
      recordedAt: '2026-07-11T12:00:00.000Z',
    });

    // Then
    await expect(recording).rejects.toBeInstanceOf(LadderPersistenceError);
    expect(state.batchAttempts).toBe(3);
    expect(state.staleVersionFailures).toBe(3);
    expect(state.versions).toEqual([]);
    expect(state.results).toEqual([]);
    expect(state.audit).toEqual([]);
    expect(state.ratings).toEqual([]);
  });
});
