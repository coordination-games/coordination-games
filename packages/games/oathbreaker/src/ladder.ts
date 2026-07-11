import type { LadderPlacement } from '@coordination-games/engine';
import type { OathOutcome } from './types.js';

export function getOathLadderPlacements(
  outcome: OathOutcome,
  _playerIds: readonly string[],
): readonly LadderPlacement[] {
  return outcome.rankings.map((ranking, index) => ({
    playerId: ranking.id,
    rank: index + 1,
  }));
}
