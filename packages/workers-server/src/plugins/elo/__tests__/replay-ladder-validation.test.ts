import { LadderPolicyError } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import {
  LadderPersistenceError,
  type RecordReplayLadderInput,
  recordReplayLadderMatch,
} from '../index.js';
import { type LadderFakeStore, makeLadderFakeD1 } from './ladder-d1-fake.js';

const VALID: RecordReplayLadderInput = {
  gameId: 'game-1',
  gameType: 'capture-the-lobster',
  replayHash: `0x${'11'.repeat(32)}`,
  resultHash: `0x${'22'.repeat(32)}`,
  placements: [
    { playerId: 'alice', rank: 1 },
    { playerId: 'bob', rank: 2 },
  ],
  recordedAt: '2026-07-11T12:00:00.000Z',
};

function store(): LadderFakeStore {
  return {
    players: [
      { id: 'alice', handle: 'Alice' },
      { id: 'bob', handle: 'Bob' },
    ],
    versions: [],
    ratings: [],
    results: [],
    audit: [],
  };
}

describe('recordReplayLadderMatch service boundary', () => {
  it.each([
    ['empty gameId', { ...VALID, gameId: '' }],
    ['empty gameType', { ...VALID, gameType: '' }],
    ['invalid replay hash', { ...VALID, replayHash: 'not-bytes32' }],
    ['invalid result hash', { ...VALID, resultHash: 'not-bytes32' }],
    ['fewer than two placements', { ...VALID, placements: [{ playerId: 'alice', rank: 1 }] }],
    [
      'duplicate player ids',
      {
        ...VALID,
        placements: [
          { playerId: 'alice', rank: 1 },
          { playerId: 'alice', rank: 2 },
        ],
      },
    ],
    [
      'rank below one',
      {
        ...VALID,
        placements: [
          { playerId: 'alice', rank: 0 },
          { playerId: 'bob', rank: 2 },
        ],
      },
    ],
  ] satisfies ReadonlyArray<
    readonly [string, RecordReplayLadderInput]
  >)('Given %s, when exported ingestion is called, then a typed error occurs before SQL preparation', async (_label, malformed) => {
    // Given
    const state = store();
    const db = makeLadderFakeD1(state);

    // When
    const recording = recordReplayLadderMatch(db, malformed);

    // Then
    await expect(recording).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof LadderPersistenceError || error instanceof LadderPolicyError,
    );
    expect(state.prepareCount ?? 0).toBe(0);
    expect(state.results).toEqual([]);
    expect(state.ratings).toEqual([]);
  });
});
