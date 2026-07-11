import type { TragedyOutcome, TragedyPlayerRanking } from './types.js';

type RankingGroup = {
  readonly rankings: readonly TragedyPlayerRanking[];
  readonly weight: bigint;
};

function compareRankings(left: TragedyPlayerRanking, right: TragedyPlayerRanking): number {
  if (right.vp !== left.vp) return right.vp - left.vp;
  if (right.influence !== left.influence) return right.influence - left.influence;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validateRankingIntegrity(
  rankings: readonly TragedyPlayerRanking[],
  playerIds: readonly string[],
): void {
  const playerSet = new Set(playerIds);
  if (playerSet.size !== playerIds.length) {
    throw new Error('Tragedy payout player ids must include every player exactly once');
  }
  if (rankings.length !== playerIds.length) {
    throw new Error('Tragedy payout rankings must include every player exactly once');
  }

  const seen = new Set<string>();
  for (const ranking of rankings) {
    if (!playerSet.has(ranking.id)) {
      throw new Error(`Tragedy payout ranking contains unknown player: ${ranking.id}`);
    }
    if (seen.has(ranking.id)) {
      throw new Error(`Tragedy payout ranking contains duplicate player: ${ranking.id}`);
    }
    if (!Number.isSafeInteger(ranking.vp) || !Number.isSafeInteger(ranking.influence)) {
      throw new Error(
        `Tragedy payout ranking contains non-integer score for player: ${ranking.id}`,
      );
    }
    seen.add(ranking.id);
  }
}

function boundedHealthPercent(outcome: TragedyOutcome): bigint {
  if (!Number.isSafeInteger(outcome.commonsHealthPercent)) {
    throw new Error('Tragedy payout outcome contains non-integer commons health percent');
  }
  return BigInt(Math.max(0, Math.min(100, outcome.commonsHealthPercent)));
}

function reserveShares(playerIds: readonly string[], reservePool: bigint): Map<string, bigint> {
  const orderedIds = [...playerIds].sort();
  const playerCount = BigInt(orderedIds.length);
  const baseShare = reservePool / playerCount;
  const remainder = reservePool % playerCount;
  return new Map(
    orderedIds.map((id, index) => [id, baseShare + (BigInt(index) < remainder ? 1n : 0n)]),
  );
}

function rankingGroups(rankings: readonly TragedyPlayerRanking[]): readonly RankingGroup[] {
  const ordered = [...rankings].sort(compareRankings);
  const groups: RankingGroup[] = [];
  let start = 0;
  while (start < ordered.length) {
    const first = ordered[start];
    if (first === undefined) break;

    let end = start + 1;
    while (end < ordered.length) {
      const candidate = ordered[end];
      if (
        candidate === undefined ||
        candidate.vp !== first.vp ||
        candidate.influence !== first.influence
      ) {
        break;
      }
      end += 1;
    }

    let weight = 0n;
    for (let position = start; position < end; position += 1) {
      weight += BigInt(ordered.length - position);
    }
    groups.push({ rankings: ordered.slice(start, end), weight });
    start = end;
  }
  return groups;
}

function addCompetitiveShares(
  grossShares: Map<string, bigint>,
  groups: readonly RankingGroup[],
  competitivePool: bigint,
  playerCount: bigint,
): void {
  const totalWeight = (playerCount * (playerCount + 1n)) / 2n;
  const groupBases = groups.map((group) => (competitivePool * group.weight) / totalWeight);
  const allocated = groupBases.reduce((total, share) => total + share, 0n);
  const groupRemainder = competitivePool - allocated;

  for (const [groupIndex, group] of groups.entries()) {
    const base = groupBases[groupIndex];
    if (base === undefined) continue;

    // Group-level remainder follows rank order; higher-ranked groups receive it first.
    const groupShare = base + (BigInt(groupIndex) < groupRemainder ? 1n : 0n);
    const memberCount = BigInt(group.rankings.length);
    const memberBase = groupShare / memberCount;
    const memberRemainder = groupShare % memberCount;
    const remainderOrder = [...group.rankings].sort((left, right) => {
      const leftGross = grossShares.get(left.id) ?? 0n;
      const rightGross = grossShares.get(right.id) ?? 0n;
      if (leftGross !== rightGross) return leftGross < rightGross ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

    // Tied players with lower reserve receive the next unit; equal reserve breaks alphabetically.
    for (const [memberIndex, ranking] of remainderOrder.entries()) {
      const extra = BigInt(memberIndex) < memberRemainder ? 1n : 0n;
      grossShares.set(ranking.id, (grossShares.get(ranking.id) ?? 0n) + memberBase + extra);
    }
  }
}

export function computeCarrySafePayouts(
  outcome: TragedyOutcome,
  playerIds: string[],
  entryCost: bigint,
): Map<string, bigint> {
  if (entryCost < 0n) {
    throw new RangeError('Tragedy payout entry cost must be non-negative');
  }
  validateRankingIntegrity(outcome.rankings, playerIds);
  const healthPercent = boundedHealthPercent(outcome);
  if (playerIds.length === 0) return new Map();

  const playerCount = BigInt(playerIds.length);
  const potTotal = entryCost * playerCount;
  const competitivePool = (potTotal * healthPercent) / 200n;
  const grossShares = reserveShares(playerIds, potTotal - competitivePool);
  addCompetitiveShares(grossShares, rankingGroups(outcome.rankings), competitivePool, playerCount);

  return new Map(playerIds.map((id) => [id, (grossShares.get(id) ?? 0n) - entryCost]));
}
