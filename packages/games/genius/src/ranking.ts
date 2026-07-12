import type { LadderPlacement } from '@coordination-games/engine';
import type { GeniusOutcome, GeniusPlayerState, GeniusRanking } from './types.js';

export function sameCompetitiveRank(left: GeniusRanking, right: GeniusRanking): boolean {
  return (
    left.score === right.score &&
    left.active === right.active &&
    left.eliminatedRound === right.eliminatedRound
  );
}

export function rankGeniusPlayers(
  players: readonly GeniusPlayerState[],
  joinOrder: readonly string[],
): readonly GeniusRanking[] {
  const joinIndex = new Map(joinOrder.map((playerId, index) => [playerId, index]));
  return players
    .map((player) => ({
      playerId: player.id,
      score: player.score,
      active: player.active,
      eliminatedRound: player.eliminatedRound,
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      if (left.active !== right.active) return left.active ? -1 : 1;
      if (left.eliminatedRound !== right.eliminatedRound) {
        return (right.eliminatedRound ?? -1) - (left.eliminatedRound ?? -1);
      }
      const leftJoin = joinIndex.get(left.playerId) ?? Number.POSITIVE_INFINITY;
      const rightJoin = joinIndex.get(right.playerId) ?? Number.POSITIVE_INFINITY;
      if (leftJoin !== rightJoin) return leftJoin - rightJoin;
      return left.playerId.localeCompare(right.playerId);
    });
}

export function winnerIdsFromRankings(rankings: readonly GeniusRanking[]): readonly string[] {
  const first = rankings[0];
  if (first === undefined) return [];
  return rankings
    .filter((ranking) => sameCompetitiveRank(first, ranking))
    .map((ranking) => ranking.playerId);
}

export function getGeniusLadderPlacements(
  outcome: GeniusOutcome,
  _playerIds: readonly string[],
): readonly LadderPlacement[] {
  let rank = 1;
  return outcome.rankings.map((ranking, index) => {
    const previous = outcome.rankings[index - 1];
    if (previous !== undefined && !sameCompetitiveRank(previous, ranking)) rank = index + 1;
    return { playerId: ranking.playerId, rank };
  });
}

export function computeGeniusPayouts(
  outcome: GeniusOutcome,
  playerIds: readonly string[],
  entryCost: bigint,
): Map<string, bigint> {
  const winners = playerIds.filter((playerId) => outcome.winnerIds.includes(playerId));
  if (winners.length === 0) return new Map(playerIds.map((playerId) => [playerId, 0n]));
  const pot = entryCost * BigInt(playerIds.length);
  const baseShare = pot / BigInt(winners.length);
  const remainder = pot % BigInt(winners.length);
  const shares = new Map<string, bigint>();
  winners.forEach((playerId, index) => {
    shares.set(playerId, baseShare + (BigInt(index) < remainder ? 1n : 0n));
  });
  return new Map(playerIds.map((playerId) => [playerId, (shares.get(playerId) ?? 0n) - entryCost]));
}
