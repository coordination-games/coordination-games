import type { D1Database, DurableObjectStorage } from '@cloudflare/workers-types';
import type { RelayEnvelope } from '@coordination-games/engine';
import { describe, expect, it, vi } from 'vitest';
import {
  type Capabilities,
  NamespacedStorage,
  type RelayClient,
  type SpectatorViewer,
} from '../../capabilities.js';
import { ServerPluginRuntime } from '../../runtime.js';
import { createEloServerPlugin } from '../index.js';
import { type LadderFakeStore, makeLadderFakeD1 } from './ladder-d1-fake.js';

function capabilities(d1: D1Database): Capabilities {
  const relay: RelayClient = {
    publish: vi.fn(async () => {}),
    visibleTo: vi.fn(async () => [] as RelayEnvelope[]),
    since: vi.fn(async () => [] as RelayEnvelope[]),
    getTip: vi.fn(async () => 0),
  };
  return {
    storage: new NamespacedStorage({} as DurableObjectStorage, '__elo_game_calls__'),
    relay,
    alarms: { scheduleAt: vi.fn(async () => {}), cancel: vi.fn(async () => {}) },
    d1,
    chain: {} as Capabilities['chain'],
  };
}

async function runtime(store: LadderFakeStore): Promise<ServerPluginRuntime> {
  const result = new ServerPluginRuntime(capabilities(makeLadderFakeD1(store)), {
    gameId: '__worker__',
  });
  await result.register(createEloServerPlugin());
  return result;
}

const SPECTATOR: SpectatorViewer = { kind: 'spectator' };
const ALICE: SpectatorViewer = { kind: 'player', playerId: 'alice' };

function store(): LadderFakeStore {
  return {
    players: [
      { id: 'alice', handle: 'Alice' },
      { id: 'bob', handle: 'Bob' },
    ],
    versions: [],
    ratings: [
      {
        game_type: 'capture-the-lobster',
        player_id: 'alice',
        rating: 1016,
        games_played: 1,
        updated_at: '2026-07-11T12:00:00.000Z',
      },
      {
        game_type: 'capture-the-lobster',
        player_id: 'bob',
        rating: 984,
        games_played: 1,
        updated_at: '2026-07-11T12:00:00.000Z',
      },
      {
        game_type: 'oathbreaker',
        player_id: 'alice',
        rating: 970,
        games_played: 2,
        updated_at: '2026-07-11T13:00:00.000Z',
      },
    ],
    results: [
      {
        game_id: 'game-1',
        game_type: 'capture-the-lobster',
        replay_hash: `0x${'11'.repeat(32)}`,
        result_hash: `0x${'22'.repeat(32)}`,
        claim_token: 'claim-1',
        recorded_at: '2026-07-11T12:00:00.000Z',
        version_guard: 1,
      },
    ],
    audit: [
      {
        game_id: 'game-1',
        player_id: 'alice',
        rank: 1,
        rating_before: 1000,
        rating_after: 1016,
        delta: 16,
      },
    ],
  };
}

describe('ELO per-game calls', () => {
  it('Given multiple game ladders, when game-leaderboard is called, then only the selected game is returned', async () => {
    // Given
    const plugin = await runtime(store());

    // When
    const rows = await plugin.handleCall(
      'elo',
      'game-leaderboard',
      { gameType: 'capture-the-lobster', limit: 50, offset: 0 },
      SPECTATOR,
    );

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

  it('Given a player has one CtL replay, when my-stats selects CtL, then per-game rating and history are returned', async () => {
    // Given
    const plugin = await runtime(store());

    // When
    const stats = await plugin.handleCall(
      'elo',
      'my-stats',
      { gameType: 'capture-the-lobster', matchLimit: 20 },
      ALICE,
    );

    // Then
    expect(stats).toEqual({
      playerId: 'alice',
      handle: 'Alice',
      gameType: 'capture-the-lobster',
      rating: 1016,
      gamesPlayed: 1,
      recentMatches: [
        {
          gameId: 'game-1',
          rank: 1,
          ratingBefore: 1000,
          ratingAfter: 1016,
          delta: 16,
          recordedAt: '2026-07-11T12:00:00.000Z',
        },
      ],
    });
  });
});
