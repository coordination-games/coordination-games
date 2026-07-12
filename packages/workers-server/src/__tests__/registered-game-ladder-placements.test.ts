import type { LadderPlacement } from '@coordination-games/engine';
import { getGame } from '@coordination-games/engine';
import { CaptureTheLobsterPlugin, type CtlOutcome } from '@coordination-games/game-ctl';
import { GENIUS_GAME_ID, type GeniusOutcome, GeniusPlugin } from '@coordination-games/game-genius';
import { OathbreakerPlugin, type OathOutcome } from '@coordination-games/game-oathbreaker';
import {
  TRAGEDY_GAME_ID,
  TragedyOfTheCommonsPlugin,
  TragedyOfTheCommonsV2Plugin,
  type TragedyOutcome,
  type TragedyV2Outcome,
} from '@coordination-games/game-tragedy-of-the-commons';
import { describe, expect, it } from 'vitest';

function placements(
  plugin: object,
  outcome: unknown,
  playerIds: readonly string[],
): readonly LadderPlacement[] {
  const adapter = Reflect.get(plugin, 'getLadderPlacements');
  if (typeof adapter !== 'function') {
    throw new TypeError('registered game does not expose getLadderPlacements');
  }
  return adapter(outcome, playerIds);
}

const CTL_STATS: CtlOutcome['playerStats'] = {
  alpha: { team: 'A', kills: 0, deaths: 0, flagCarries: 0, flagCaptures: 1 },
  beta: { team: 'A', kills: 0, deaths: 0, flagCarries: 0, flagCaptures: 0 },
  gamma: { team: 'B', kills: 0, deaths: 0, flagCarries: 0, flagCaptures: 0 },
  delta: { team: 'B', kills: 0, deaths: 0, flagCarries: 0, flagCaptures: 0 },
};

describe('registered game ladder placement adapters', () => {
  it('Given a CtL team winner, when placements are derived, then winners tie at rank one and losers tie at rank two', () => {
    // Given
    const outcome: CtlOutcome = {
      winner: 'A',
      score: { A: 1, B: 0 },
      turnCount: 8,
      playerStats: CTL_STATS,
    };

    // When
    const result = placements(CaptureTheLobsterPlugin, outcome, [
      'delta',
      'alpha',
      'gamma',
      'beta',
    ]);

    // Then
    expect(result).toEqual([
      { playerId: 'delta', rank: 2 },
      { playerId: 'alpha', rank: 1 },
      { playerId: 'gamma', rank: 2 },
      { playerId: 'beta', rank: 1 },
    ]);
  });

  it('Given a CtL draw, when placements are derived, then every participant ties at rank one', () => {
    // Given
    const outcome: CtlOutcome = {
      winner: null,
      score: { A: 0, B: 0 },
      turnCount: 30,
      playerStats: CTL_STATS,
    };

    // When
    const result = placements(CaptureTheLobsterPlugin, outcome, ['alpha', 'gamma']);

    // Then
    expect(result).toEqual([
      { playerId: 'alpha', rank: 1 },
      { playerId: 'gamma', rank: 1 },
    ]);
  });

  it('Given an Oathbreaker canonical outcome, when placements are derived, then ranking order maps to one-based ranks', () => {
    // Given
    const outcome: OathOutcome = {
      rankings: [
        { id: 'beta', finalBalance: 130, oathsKept: 3, oathsBroken: 1 },
        { id: 'alpha', finalBalance: 130, oathsKept: 4, oathsBroken: 0 },
        { id: 'gamma', finalBalance: 80, oathsKept: 1, oathsBroken: 3 },
      ],
      roundsPlayed: 4,
      totalPrinted: 10,
      totalBurned: 5,
      finalSupply: 340,
    };

    // When
    const result = placements(OathbreakerPlugin, outcome, ['alpha', 'beta', 'gamma']);

    // Then
    expect(result).toEqual([
      { playerId: 'beta', rank: 1 },
      { playerId: 'alpha', rank: 2 },
      { playerId: 'gamma', rank: 3 },
    ]);
  });

  it.each([
    ['v0', TragedyOfTheCommonsPlugin],
    ['v2', TragedyOfTheCommonsV2Plugin],
  ])('Given a Tragedy %s canonical outcome, when placements are derived, then ranking order maps deterministically', (_version, plugin) => {
    // Given
    const base: TragedyOutcome = {
      rankings: [
        { id: 'gamma', vp: 12, influence: 5 },
        { id: 'alpha', vp: 12, influence: 5 },
        { id: 'beta', vp: 8, influence: 9 },
      ],
      roundsPlayed: 6,
      flourishingEcosystems: 2,
      collapsedEcosystems: 1,
      commonsHealthPercent: 67,
    };
    const outcome: TragedyOutcome | TragedyV2Outcome =
      plugin === TragedyOfTheCommonsV2Plugin ? { ...base, averageTileHealthPercent: 67 } : base;

    // When
    const result = placements(plugin, outcome, ['alpha', 'beta', 'gamma']);

    // Then
    expect(result).toEqual([
      { playerId: 'gamma', rank: 1 },
      { playerId: 'alpha', rank: 2 },
      { playerId: 'beta', rank: 3 },
    ]);
  });

  it('Given the registered Tragedy game id, when resolved, then the V2 plugin exposes the placement adapter', () => {
    // Given
    const plugin = getGame(TRAGEDY_GAME_ID);

    // When
    const adapter = plugin?.getLadderPlacements;

    // Then
    expect(plugin).toBe(TragedyOfTheCommonsV2Plugin);
    expect(adapter).toBeTypeOf('function');
  });

  it('Given a Genius outcome with tied leaders, when placements are derived, then ties and registry identity are preserved', () => {
    // Given
    const outcome: GeniusOutcome = {
      winnerIds: ['alpha', 'beta'],
      roundsPlayed: 4,
      rankings: [
        { playerId: 'alpha', score: 4, active: true, eliminatedRound: null },
        { playerId: 'beta', score: 4, active: true, eliminatedRound: null },
        { playerId: 'gamma', score: 1, active: false, eliminatedRound: 2 },
      ],
    };

    // When
    const result = placements(GeniusPlugin, outcome, ['alpha', 'beta', 'gamma']);

    // Then
    expect(result).toEqual([
      { playerId: 'alpha', rank: 1 },
      { playerId: 'beta', rank: 1 },
      { playerId: 'gamma', rank: 3 },
    ]);
    expect(getGame(GENIUS_GAME_ID)).toBe(GeniusPlugin);
  });
});
