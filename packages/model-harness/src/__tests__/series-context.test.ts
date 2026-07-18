import { describe, expect, it } from 'vitest';
import type { SeriesGameHistory } from '../series-context.js';
import { buildSeriesContext } from '../series-context.js';

describe('buildSeriesContext', () => {
  it('Given completed public and direct messages, when building a later-game context for each seat, then each seat receives public history plus only its own DMs', () => {
    // Given
    const history = [
      {
        gameId: 'game-1',
        outcome: { phase: 'finished', winnerLabel: 'bot-a' },
        standings: [{ playerId: 'player-a', rank: 1 }],
        relay: [
          {
            gameId: 'game-1',
            index: 0,
            type: 'messaging',
            pluginId: 'basic-chat',
            sender: 'player-a',
            scope: { kind: 'all' },
            turn: 1,
            body: 'public-agreement',
          },
          {
            gameId: 'game-1',
            index: 1,
            type: 'messaging',
            pluginId: 'basic-chat',
            sender: 'player-a',
            scope: { kind: 'dm', recipientHandle: 'bot-b' },
            turn: 1,
            body: 'a-to-b-private',
          },
          {
            gameId: 'game-1',
            index: 2,
            type: 'messaging',
            pluginId: 'basic-chat',
            sender: 'player-b',
            scope: { kind: 'dm', recipientHandle: 'player-c' },
            turn: 2,
            body: 'b-to-c-private',
          },
        ],
      },
    ] satisfies readonly SeriesGameHistory[];

    // When
    const contextA = buildSeriesContext({
      currentGameId: 'game-2',
      viewerPlayerId: 'player-a',
      history,
    });
    const contextB = buildSeriesContext({
      currentGameId: 'game-2',
      viewerPlayerId: 'player-b',
      viewerHandle: 'bot-b',
      history,
    });
    const contextC = buildSeriesContext({
      currentGameId: 'game-2',
      viewerPlayerId: 'player-c',
      history,
    });

    // Then
    expect(contextA).toContain('public-agreement');
    expect(contextB).toContain('public-agreement');
    expect(contextC).toContain('public-agreement');
    expect(contextA).toContain('a-to-b-private');
    expect(contextB).toContain('a-to-b-private');
    expect(contextC).not.toContain('a-to-b-private');
    expect(contextA).not.toContain('b-to-c-private');
    expect(contextB).toContain('b-to-c-private');
    expect(contextC).toContain('b-to-c-private');
  });
});
