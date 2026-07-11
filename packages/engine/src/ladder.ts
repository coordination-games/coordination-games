import type { LadderPlacement } from './types.js';

export const DEFAULT_LADDER_RATING = 1000;
export const DEFAULT_LADDER_K_FACTOR = 32;

export type LadderParticipantRating = {
  readonly playerId: string;
  readonly rating?: number;
};

export type MultiplayerEloInput = {
  readonly participants: readonly LadderParticipantRating[];
  readonly placements: readonly LadderPlacement[];
  readonly initialRating?: number;
  readonly kFactor?: number;
};

export type LadderRatingUpdate = LadderPlacement & {
  readonly ratingBefore: number;
  readonly ratingAfter: number;
  readonly delta: number;
};

export class LadderPolicyError extends Error {
  override readonly name = 'LadderPolicyError';
}

function safeInteger(value: number, label: string, minimum?: number): number {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new LadderPolicyError(
      `${label} must be a safe integer${minimum === undefined ? '' : ` >= ${minimum}`}`,
    );
  }
  return value;
}

function expectedScore(rating: number, opponentRating: number): number {
  const exponent = ((opponentRating - rating) * Math.LN10) / 400;
  if (exponent >= 0) {
    const inverse = Math.exp(-exponent);
    return inverse / (1 + inverse);
  }
  return 1 / (1 + Math.exp(exponent));
}

function actualScore(rank: number, opponentRank: number): number {
  if (rank < opponentRank) return 1;
  if (rank > opponentRank) return 0;
  return 0.5;
}

export function computeMultiplayerElo(input: MultiplayerEloInput): readonly LadderRatingUpdate[] {
  const initialRating = safeInteger(input.initialRating ?? DEFAULT_LADDER_RATING, 'initialRating');
  const kFactor = safeInteger(input.kFactor ?? DEFAULT_LADDER_K_FACTOR, 'kFactor', 0);
  if (input.participants.length < 2) {
    throw new LadderPolicyError('at least two participants are required');
  }

  const ratings = new Map<string, number>();
  for (const participant of input.participants) {
    if (participant.playerId.length === 0 || ratings.has(participant.playerId)) {
      throw new LadderPolicyError('participant ids must be non-empty and unique');
    }
    ratings.set(
      participant.playerId,
      safeInteger(participant.rating ?? initialRating, `rating for ${participant.playerId}`),
    );
  }

  if (input.placements.length !== ratings.size) {
    throw new LadderPolicyError('placements must exactly match participant ids');
  }
  const ranks = new Map<string, number>();
  for (const placement of input.placements) {
    if (!ratings.has(placement.playerId) || ranks.has(placement.playerId)) {
      throw new LadderPolicyError('placements must exactly match participant ids');
    }
    ranks.set(placement.playerId, safeInteger(placement.rank, `rank for ${placement.playerId}`, 1));
  }

  const playerIds = [...ratings.keys()].sort((left, right) => left.localeCompare(right));
  const rawDeltas = new Map(playerIds.map((playerId) => [playerId, 0]));
  const pairScale = kFactor / (playerIds.length - 1);
  for (let leftIndex = 0; leftIndex < playerIds.length; leftIndex += 1) {
    const leftId = playerIds[leftIndex];
    if (leftId === undefined) continue;
    const leftRating = ratings.get(leftId);
    const leftRank = ranks.get(leftId);
    if (leftRating === undefined || leftRank === undefined) {
      throw new LadderPolicyError(`missing ladder data for ${leftId}`);
    }
    for (let rightIndex = leftIndex + 1; rightIndex < playerIds.length; rightIndex += 1) {
      const rightId = playerIds[rightIndex];
      if (rightId === undefined) continue;
      const rightRating = ratings.get(rightId);
      const rightRank = ranks.get(rightId);
      if (rightRating === undefined || rightRank === undefined) {
        throw new LadderPolicyError(`missing ladder data for ${rightId}`);
      }
      const pairDelta =
        pairScale * (actualScore(leftRank, rightRank) - expectedScore(leftRating, rightRating));
      rawDeltas.set(leftId, (rawDeltas.get(leftId) ?? 0) + pairDelta);
      rawDeltas.set(rightId, (rawDeltas.get(rightId) ?? 0) - pairDelta);
    }
  }

  const deltas = new Map(
    playerIds.map((playerId) => [playerId, Math.round(rawDeltas.get(playerId) ?? 0)]),
  );
  let residual = -[...deltas.values()].reduce((sum, delta) => sum + delta, 0);
  for (let index = 0; residual !== 0; index = (index + 1) % playerIds.length) {
    const playerId = playerIds[index];
    if (playerId === undefined) continue;
    const adjustment = residual > 0 ? 1 : -1;
    deltas.set(playerId, (deltas.get(playerId) ?? 0) + adjustment);
    residual -= adjustment;
  }

  return playerIds.map((playerId) => {
    const ratingBefore = ratings.get(playerId);
    const rank = ranks.get(playerId);
    const delta = deltas.get(playerId);
    if (ratingBefore === undefined || rank === undefined || delta === undefined) {
      throw new LadderPolicyError(`missing computed ladder data for ${playerId}`);
    }
    const ratingAfter = safeInteger(ratingBefore + delta, `updated rating for ${playerId}`);
    return { playerId, rank, ratingBefore, ratingAfter, delta };
  });
}
