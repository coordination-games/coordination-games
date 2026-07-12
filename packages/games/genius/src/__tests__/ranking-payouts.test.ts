import { describe, expect, it } from 'vitest';
import {
  computeGeniusPayouts,
  type GeniusOutcome,
  type GeniusPlayerState,
  getGeniusLadderPlacements,
  rankGeniusPlayers,
} from '../index.js';

const PLAYERS: readonly GeniusPlayerState[] = [
  { id: 'early', score: 2, active: false, eliminatedRound: 3 },
  { id: 'active', score: 2, active: true, eliminatedRound: null },
  { id: 'late', score: 2, active: false, eliminatedRound: 5 },
  { id: 'low', score: 1, active: true, eliminatedRound: null },
];

function outcome(winnerIds: readonly string[]): GeniusOutcome {
  return {
    winnerIds: [...winnerIds],
    roundsPlayed: 4,
    rankings: rankGeniusPlayers(PLAYERS, ['early', 'active', 'late', 'low']),
  };
}

describe('Genius deterministic ranking and ladder ties', () => {
  it('Given equal scores, when players are ranked, then active and later elimination keys decide before join order', () => {
    // Given / When
    const rankings = rankGeniusPlayers(PLAYERS, ['early', 'active', 'late', 'low']);

    // Then
    expect(rankings.map((ranking) => ranking.playerId)).toEqual(['active', 'late', 'early', 'low']);
  });

  it('Given competitive keys tie, when ladder placements are built, then the tied rank is preserved', () => {
    // Given
    const tied: GeniusOutcome = {
      winnerIds: ['zeta', 'alpha'],
      roundsPlayed: 3,
      rankings: [
        { playerId: 'zeta', score: 3, active: true, eliminatedRound: null },
        { playerId: 'alpha', score: 3, active: true, eliminatedRound: null },
        { playerId: 'beta', score: 2, active: false, eliminatedRound: 3 },
      ],
    };

    // When
    const placements = getGeniusLadderPlacements(tied, ['zeta', 'alpha', 'beta']);

    // Then
    expect(placements).toEqual([
      { playerId: 'zeta', rank: 1 },
      { playerId: 'alpha', rank: 1 },
      { playerId: 'beta', rank: 3 },
    ]);
  });

  it('Given tied active players arrive out of order, when ranked, then original join order is the serialization tie-break', () => {
    // Given
    const players: readonly GeniusPlayerState[] = [
      { id: 'zeta', score: 3, active: true, eliminatedRound: null },
      { id: 'alpha', score: 3, active: true, eliminatedRound: null },
    ];

    // When
    const rankings = rankGeniusPlayers(players, ['alpha', 'zeta']);

    // Then
    expect(rankings.map((ranking) => ranking.playerId)).toEqual(['alpha', 'zeta']);
  });
});

describe('Genius payouts', () => {
  it('Given tied winners and an indivisible pot, when payouts are computed, then join order receives the remainder and deltas are zero-sum', () => {
    // Given
    const ids = ['alpha', 'beta', 'gamma'];

    // When
    const payouts = computeGeniusPayouts(outcome(['alpha', 'beta']), ids, 1n);

    // Then
    expect([...payouts.entries()]).toEqual([
      ['alpha', 1n],
      ['beta', 0n],
      ['gamma', -1n],
    ]);
    expect([...payouts.values()].reduce((sum, value) => sum + value, 0n)).toBe(0n);
    expect([...payouts.values()].every((value) => value >= -1n)).toBe(true);
  });
});
