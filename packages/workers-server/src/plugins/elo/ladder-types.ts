import type { LadderPlacement } from '@coordination-games/engine';

export type RecordReplayLadderInput = {
  readonly gameId: string;
  readonly gameType: string;
  readonly replayHash: string;
  readonly resultHash: string;
  readonly placements: readonly LadderPlacement[];
  readonly recordedAt?: string;
};

export type ReplayLadderReceipt = {
  readonly gameId: string;
  readonly gameType: string;
  readonly replayHash: string;
  readonly recorded: boolean;
  readonly players: readonly ReplayLadderPlayerReceipt[];
};

export type ReplayLadderPlayerReceipt = {
  readonly playerId: string;
  readonly rank: number;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
};

export type ReplayResultRow = {
  readonly game_id: string;
  readonly game_type: string;
  readonly replay_hash: string;
  readonly result_hash: string;
  readonly claim_token: string;
  readonly recorded_at: string;
};

export type RatingRow = {
  readonly player_id: string;
  readonly rating: number;
  readonly games_played: number;
};

export class LadderReplayConflictError extends Error {
  override readonly name = 'LadderReplayConflictError';

  constructor(readonly gameId: string) {
    super(`game ${gameId} already has different ladder evidence`);
  }
}

export class LadderPersistenceError extends Error {
  override readonly name = 'LadderPersistenceError';
}
