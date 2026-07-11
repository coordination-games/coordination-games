import { type LadderPlacement, LadderPolicyError } from '@coordination-games/engine';

type CtlLadderOutcome = {
  readonly winner: 'A' | 'B' | null;
  readonly playerStats: Readonly<Record<string, { readonly team: 'A' | 'B' }>>;
};

export function getCtlLadderPlacements(
  outcome: CtlLadderOutcome,
  playerIds: readonly string[],
): readonly LadderPlacement[] {
  if (outcome.winner === null) {
    return playerIds.map((playerId) => ({ playerId, rank: 1 }));
  }
  return playerIds.map((playerId) => {
    const stats = outcome.playerStats[playerId];
    if (stats === undefined) {
      throw new LadderPolicyError(`CtL outcome is missing player ${playerId}`);
    }
    return { playerId, rank: stats.team === outcome.winner ? 1 : 2 };
  });
}
