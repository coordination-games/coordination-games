import { z } from 'zod';
import { LadderPersistenceError, type RecordReplayLadderInput } from './ladder-types.js';

const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const placementSchema = z
  .object({
    playerId: z.string().min(1),
    rank: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const replayInputSchema = z
  .object({
    gameId: z.string().min(1),
    gameType: z.string().min(1),
    replayHash: bytes32Schema,
    resultHash: bytes32Schema,
    placements: z
      .array(placementSchema)
      .min(2)
      .refine(
        (placements) =>
          new Set(placements.map((placement) => placement.playerId)).size === placements.length,
        'placement playerIds must be unique',
      ),
    recordedAt: z.string().min(1).optional(),
  })
  .strict();

export function parseRecordReplayLadderInput(input: unknown): RecordReplayLadderInput {
  const parsed = replayInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new LadderPersistenceError('invalid replay ladder input');
  }
  const { gameId, gameType, replayHash, resultHash, placements, recordedAt } = parsed.data;
  const required = { gameId, gameType, replayHash, resultHash, placements };
  return recordedAt === undefined ? required : { ...required, recordedAt };
}
