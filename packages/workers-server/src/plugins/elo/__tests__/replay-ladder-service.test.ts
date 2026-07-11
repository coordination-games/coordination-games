import type { D1Database } from '@cloudflare/workers-types';
import type { LadderPlacement } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import {
  getGameLeaderboard,
  LadderReplayConflictError,
  recordReplayLadderMatch,
} from '../index.js';
import { type LadderFakeStore, makeLadderFakeD1 } from './ladder-d1-fake.js';

type ReplayInput = {
  readonly gameId: string;
  readonly gameType: string;
  readonly replayHash: string;
  readonly resultHash: string;
  readonly placements: readonly LadderPlacement[];
  readonly recordedAt: string;
};

type Receipt = {
  readonly gameId: string;
  readonly gameType: string;
  readonly replayHash: string;
  readonly recorded: boolean;
  readonly players: readonly {
    readonly playerId: string;
    readonly before: number;
    readonly after: number;
    readonly delta: number;
    readonly rank: number;
  }[];
};

function service(): {
  readonly record: (db: D1Database, input: ReplayInput) => Promise<Receipt>;
  readonly leaderboard: (
    db: D1Database,
    gameType: string,
    limit: number,
    offset: number,
  ) => Promise<readonly unknown[]>;
  readonly conflict: new (gameId: string) => Error;
} {
  return {
    record: recordReplayLadderMatch,
    leaderboard: getGameLeaderboard,
    conflict: LadderReplayConflictError,
  };
}

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

function input(overrides: Partial<ReplayInput> = {}): ReplayInput {
  return {
    gameId: 'game-1',
    gameType: 'capture-the-lobster',
    replayHash: `0x${'11'.repeat(32)}`,
    resultHash: `0x${'22'.repeat(32)}`,
    placements: [
      { playerId: 'alice', rank: 1 },
      { playerId: 'bob', rank: 2 },
    ],
    recordedAt: '2026-07-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('recordReplayLadderMatch', () => {
  it('Given a completed first match, when recorded, then one atomic receipt and integer ratings are persisted', async () => {
    // Given
    const state = store();
    const db = makeLadderFakeD1(state);

    // When
    const receipt = await service().record(db, input());

    // Then
    expect(receipt).toEqual({
      gameId: 'game-1',
      gameType: 'capture-the-lobster',
      replayHash: `0x${'11'.repeat(32)}`,
      recorded: true,
      players: [
        { playerId: 'alice', rank: 1, before: 1000, after: 1016, delta: 16 },
        { playerId: 'bob', rank: 2, before: 1000, after: 984, delta: -16 },
      ],
    });
    expect(state.results).toHaveLength(1);
    expect(state.audit).toHaveLength(2);
    expect(
      state.ratings.map(({ game_type, player_id, rating }) => ({ game_type, player_id, rating })),
    ).toEqual([
      { game_type: 'capture-the-lobster', player_id: 'alice', rating: 1016 },
      { game_type: 'capture-the-lobster', player_id: 'bob', rating: 984 },
    ]);
  });

  it('Given ratings for one game type, when another game is recorded, then ladders remain isolated', async () => {
    // Given
    const state = store();
    const db = makeLadderFakeD1(state);
    const api = service();
    await api.record(db, input());

    // When
    await api.record(
      db,
      input({ gameId: 'game-2', gameType: 'oathbreaker', replayHash: `0x${'33'.repeat(32)}` }),
    );

    // Then
    expect(
      state.ratings
        .filter((row) => row.game_type === 'capture-the-lobster')
        .map((row) => row.rating),
    ).toEqual([1016, 984]);
    expect(
      state.ratings.filter((row) => row.game_type === 'oathbreaker').map((row) => row.rating),
    ).toEqual([1016, 984]);
  });

  it('Given an already recorded replay with identical evidence, when ingested again, then no rating changes occur', async () => {
    // Given
    const state = store();
    const db = makeLadderFakeD1(state);
    const api = service();
    await api.record(db, input());
    const before = structuredClone(state.ratings);

    // When
    const receipt = await api.record(db, input());

    // Then
    expect(receipt.recorded).toBe(false);
    expect(state.ratings).toEqual(before);
    expect(state.results).toHaveLength(1);
    expect(state.audit).toHaveLength(2);
  });

  it('Given an existing game id with different evidence, when ingested, then a typed conflict is rejected', async () => {
    // Given
    const state = store();
    const db = makeLadderFakeD1(state);
    const api = service();
    await api.record(db, input());

    // When
    const conflicting = api.record(db, input({ resultHash: `0x${'ff'.repeat(32)}` }));

    // Then
    await expect(conflicting).rejects.toBeInstanceOf(api.conflict);
    expect(state.results).toHaveLength(1);
  });

  it('Given D1 fails mid-batch, when recording, then result, audits, and ratings all roll back', async () => {
    // Given
    const state = store();
    state.failBatchAt = 2;
    const db = makeLadderFakeD1(state);

    // When
    const recording = service().record(db, input());

    // Then
    await expect(recording).rejects.toThrow('injected D1 batch failure');
    expect(state.batchAttempts).toBe(1);
    expect(state.results).toEqual([]);
    expect(state.audit).toEqual([]);
    expect(state.ratings).toEqual([]);
  });

  it('Given two recorded players, when the game leaderboard is read, then game rating order is deterministic', async () => {
    // Given
    const state = store();
    const db = makeLadderFakeD1(state);
    const api = service();
    await api.record(db, input());

    // When
    const rows = await api.leaderboard(db, 'capture-the-lobster', 50, 0);

    // Then
    expect(rows).toEqual([
      {
        playerId: 'alice',
        handle: 'Alice',
        gameType: 'capture-the-lobster',
        rating: 1016,
        gamesPlayed: 1,
      },
      {
        playerId: 'bob',
        handle: 'Bob',
        gameType: 'capture-the-lobster',
        rating: 984,
        gamesPlayed: 1,
      },
    ]);
  });
});
