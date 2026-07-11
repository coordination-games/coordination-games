import {
  buildActionMerkleTree,
  canonicalEncode,
  type MerkleLeafData,
} from '@coordination-games/engine';
import { keccak256 } from 'viem';
import { z } from 'zod';

const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const definedValueSchema = z.unknown().refine((value) => value !== undefined);
const actionEntrySchema = z
  .object({
    playerId: z.string().min(1).nullable(),
    action: definedValueSchema,
  })
  .strict();
const completedBundleSchema = z
  .object({
    gameId: z.string().min(1),
    gameType: z.string().min(1),
    finished: z.literal(true),
    playerIds: z
      .array(z.string().min(1))
      .min(2)
      .refine((ids) => new Set(ids).size === ids.length, 'playerIds must be unique'),
    config: definedValueSchema,
    actionLog: z.array(actionEntrySchema),
    result: z
      .object({
        outcome: definedValueSchema,
        movesRoot: bytes32Schema,
        configHash: bytes32Schema.optional(),
        turnCount: z.number().int().nonnegative().max(0xffff),
      })
      .loose(),
  })
  .loose();

export type CompletedLadderBundle = z.infer<typeof completedBundleSchema>;

export type LadderReplayEvidence = {
  readonly bundle: CompletedLadderBundle;
  readonly replayHash: `0x${string}`;
  readonly resultHash: `0x${string}`;
};

export class ReplayBundleValidationError extends Error {
  override readonly name = 'ReplayBundleValidationError';
}

export class ReplayBundleVerificationError extends Error {
  override readonly name = 'ReplayBundleVerificationError';
}

function hashCanonical(value: unknown): `0x${string}` {
  return keccak256(canonicalEncode(value));
}

export function parseLadderReplayBundle(
  raw: unknown,
  expectedGameId: string,
): LadderReplayEvidence {
  const parsed = completedBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReplayBundleValidationError('GameRoom returned a malformed completed bundle');
  }
  const bundle = parsed.data;
  if (bundle.gameId !== expectedGameId) {
    throw new ReplayBundleValidationError('GameRoom bundle gameId does not match the request');
  }

  const leaves: MerkleLeafData[] = bundle.actionLog.map((entry, actionIndex) => ({
    actionIndex,
    playerId: entry.playerId,
    actionData: JSON.stringify(entry.action),
  }));
  const computedMovesRoot = buildActionMerkleTree(leaves).root;
  if (computedMovesRoot.toLowerCase() !== bundle.result.movesRoot.toLowerCase()) {
    throw new ReplayBundleVerificationError('GameRoom actionLog does not match movesRoot');
  }

  const result = {
    outcome: bundle.result.outcome,
    movesRoot: bundle.result.movesRoot,
    turnCount: bundle.result.turnCount,
    ...(bundle.result.configHash === undefined ? {} : { configHash: bundle.result.configHash }),
  };
  const evidence = {
    gameId: bundle.gameId,
    gameType: bundle.gameType,
    playerIds: bundle.playerIds,
    config: bundle.config,
    actionLog: bundle.actionLog,
    result,
  };
  return {
    bundle,
    replayHash: hashCanonical(evidence),
    resultHash: hashCanonical(bundle.result.outcome),
  };
}
