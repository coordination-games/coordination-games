import type { LadderPlacement } from '@coordination-games/engine';
import type { TragedyOutcome } from './types.js';

export function getTragedyLadderPlacements(
  outcome: TragedyOutcome,
  _playerIds: readonly string[],
): readonly LadderPlacement[] {
  return outcome.rankings.map((ranking, index) => ({
    playerId: ranking.id,
    rank: index + 1,
  }));
}
