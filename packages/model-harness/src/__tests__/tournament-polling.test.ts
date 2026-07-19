import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTournamentBatchDependencies } from '../tournament-run.js';

describe('default tournament polling', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts to the encoded tick endpoint and parses the returned tournament state', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://worker/api/tournaments/lobby%3Aabc/tick');
      expect(init?.method).toBe('POST');
      return Response.json({
        status: 'completed',
        currentGameId: null,
        activePlayerIds: ['seat-1'],
        gameIds: ['game-1'],
        standings: [{ playerId: 'seat-1', rank: 1, cumulativeDelta: '10' }],
      });
    });

    const state = await createTournamentBatchDependencies().pollState('http://worker', 'lobby:abc');

    expect(state).toEqual({
      status: 'completed',
      currentGameId: null,
      activePlayerIds: ['seat-1'],
      gameIds: ['game-1'],
      standings: [{ playerId: 'seat-1', rank: 1, cumulativeDelta: '10' }],
    });
  });

  it('rejects a tick error instead of falling back to stale state', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'settlement pending' }, { status: 503 }),
    );

    await expect(
      createTournamentBatchDependencies().pollState('http://worker', 'lobby:abc'),
    ).rejects.toThrow('POST /api/tournaments/lobby%3Aabc/tick → 503');
  });
});
