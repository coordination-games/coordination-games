import { z } from 'zod';
import {
  encodeTournamentConfigBinding,
  snapshotTournamentGameConfig,
  snapshotTournamentPlayerIds,
  verifyTournamentPublicHorizon,
} from './tournament-config-binding.js';
import {
  type Bytes32Hex,
  computeHorizonCommitment,
  computeTournamentConfigHash,
  computeTournamentPolicyHash,
  deriveTournamentGameSeed,
  encodeHorizonCommitmentInput,
  type HorizonCommitmentInput,
  parseBytes32Hex,
  type TournamentPolicy,
  verifyHorizonCommitment,
} from './tournament-encoding.js';

export type TournamentCommitmentContext = {
  readonly tournamentRootSeed: Bytes32Hex;
  readonly gameSeed: Bytes32Hex;
  readonly tournamentId: string;
  readonly gameIndex: number;
  readonly policy: TournamentPolicy;
  readonly horizonSecret: Bytes32Hex;
  readonly playerEntropy: Bytes32Hex;
};

export type TournamentCommitmentRecord = TournamentCommitmentContext & {
  readonly gameId: string;
  readonly gameType: string;
  readonly playerIds: readonly string[];
  readonly policyHash: Bytes32Hex;
  readonly commitment: Bytes32Hex;
  readonly commitmentInput: Uint8Array;
  readonly configInput: Uint8Array;
  readonly t0GameConfig: unknown;
  readonly t0ConfigHash: Bytes32Hex;
  readonly configHash: Bytes32Hex;
};

export type HorizonReveal = {
  readonly secret: Bytes32Hex;
  readonly playerEntropy: Bytes32Hex;
};

export type TournamentCommitmentVerification = { readonly ok: true } | { readonly ok: false };

export class TournamentCommitmentError extends Error {
  readonly name = 'TournamentCommitmentError';

  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`Invalid tournament commitment ${field}: ${reason}`);
  }
}

const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((value) => parseBytes32Hex(value));
const unsignedBigIntSchema = z
  .union([z.bigint(), z.string().regex(/^(0|[1-9][0-9]*)$/)])
  .transform((value) => (typeof value === 'bigint' ? value : BigInt(value)));
const policySchema = z
  .object({
    seriesLength: z.number().int(),
    baseEntryCost: unsignedBigIntSchema,
    carryBps: z.number().int(),
    slashBps: z.number().int(),
    minRounds: z.number().int(),
    maxRounds: z.number().int(),
    hazardNumerator: z.number().int(),
    hazardDenominator: z.number().int(),
  })
  .strict();
const contextSchema = z
  .object({
    tournamentRootSeed: bytes32Schema,
    gameSeed: bytes32Schema,
    tournamentId: z.string().min(1),
    gameIndex: z.number().int().nonnegative(),
    policy: policySchema,
    horizonSecret: bytes32Schema,
    playerEntropy: bytes32Schema,
  })
  .strict();

export function parseTournamentCommitmentContext(value: unknown): TournamentCommitmentContext {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) {
    throw new TournamentCommitmentError(
      'context',
      value,
      parsed.error.issues[0]?.message ?? 'invalid',
    );
  }
  return parsed.data;
}

function requireText(field: string, value: string): string {
  if (value.length === 0) throw new TournamentCommitmentError(field, value, 'must be non-empty');
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function configInput(record: TournamentCommitmentRecord): Uint8Array {
  return encodeTournamentConfigBinding({
    tournamentRootSeed: parseBytes32Hex(record.tournamentRootSeed, 'tournamentRootSeed'),
    gameSeed: parseBytes32Hex(record.gameSeed, 'gameSeed'),
    tournamentId: requireText('tournamentId', record.tournamentId),
    gameId: requireText('gameId', record.gameId),
    gameIndex: record.gameIndex,
    gameType: requireText('gameType', record.gameType),
    playerIds: snapshotTournamentPlayerIds(record.playerIds),
    policyHash: parseBytes32Hex(record.policyHash, 'policyHash'),
    commitment: parseBytes32Hex(record.commitment, 'commitment'),
    t0GameConfig: record.t0GameConfig,
  });
}

function commitmentInput(record: TournamentCommitmentRecord): HorizonCommitmentInput {
  return {
    secret: parseBytes32Hex(record.horizonSecret, 'horizonSecret'),
    gameId: requireText('gameId', record.gameId),
    playerEntropy: parseBytes32Hex(record.playerEntropy, 'playerEntropy'),
    policyHash: parseBytes32Hex(record.policyHash, 'policyHash'),
  };
}

export function createTournamentCommitment(input: {
  readonly context: TournamentCommitmentContext;
  readonly gameId: string;
  readonly gameType: string;
  readonly playerIds: readonly string[];
  readonly gameConfig: unknown;
}): TournamentCommitmentRecord {
  const context = parseTournamentCommitmentContext(input.context);
  const gameId = requireText('gameId', input.gameId);
  const gameType = requireText('gameType', input.gameType);
  const tournamentId = requireText('tournamentId', context.tournamentId);
  const expectedSeed = deriveTournamentGameSeed(
    context.tournamentRootSeed,
    tournamentId,
    context.gameIndex,
  );
  if (expectedSeed !== context.gameSeed) {
    throw new TournamentCommitmentError(
      'gameSeed',
      context.gameSeed,
      'does not match tournament derivation',
    );
  }
  const policyHash = computeTournamentPolicyHash(context.policy);
  const horizonInput: HorizonCommitmentInput = {
    secret: context.horizonSecret,
    gameId,
    playerEntropy: context.playerEntropy,
    policyHash,
  };
  const commitmentInput = encodeHorizonCommitmentInput(horizonInput);
  const commitment = computeHorizonCommitment(horizonInput);
  verifyTournamentPublicHorizon(input.gameConfig, commitment, context.policy);
  const playerIds = snapshotTournamentPlayerIds(input.playerIds);
  const t0GameConfig = snapshotTournamentGameConfig(input.gameConfig, context);
  const configInput = encodeTournamentConfigBinding({
    tournamentRootSeed: context.tournamentRootSeed,
    gameSeed: context.gameSeed,
    tournamentId,
    gameId,
    gameIndex: context.gameIndex,
    gameType,
    playerIds,
    policyHash,
    commitment,
    t0GameConfig,
  });
  const t0ConfigHash = computeTournamentConfigHash({
    tournamentRootSeed: context.tournamentRootSeed,
    gameSeed: context.gameSeed,
    tournamentId,
    gameId,
    gameIndex: context.gameIndex,
    gameType,
    playerIds,
    policyHash,
    horizonCommitment: commitment,
    gameConfig: t0GameConfig,
  });
  return {
    ...context,
    gameId,
    gameType,
    playerIds,
    policyHash,
    commitment,
    commitmentInput: Uint8Array.from(commitmentInput),
    configInput: Uint8Array.from(configInput),
    t0GameConfig,
    t0ConfigHash,
    configHash: t0ConfigHash,
  };
}

export function verifyTournamentCommitment(
  record: TournamentCommitmentRecord,
): TournamentCommitmentVerification {
  try {
    const input = commitmentInput(record);
    const encodedInput = encodeHorizonCommitmentInput(input);
    const encodedConfigInput = configInput(record);
    const policyHash = computeTournamentPolicyHash(record.policy);
    const t0ConfigHash = parseBytes32Hex(record.t0ConfigHash, 't0ConfigHash');
    const configHash = parseBytes32Hex(record.configHash, 'configHash');
    const expectedSeed = deriveTournamentGameSeed(
      record.tournamentRootSeed,
      record.tournamentId,
      record.gameIndex,
    );
    verifyTournamentPublicHorizon(record.t0GameConfig, record.commitment, record.policy);
    const recomputedConfigHash = computeTournamentConfigHash({
      tournamentRootSeed: record.tournamentRootSeed,
      gameSeed: record.gameSeed,
      tournamentId: record.tournamentId,
      gameId: record.gameId,
      gameIndex: record.gameIndex,
      gameType: record.gameType,
      playerIds: record.playerIds,
      policyHash: record.policyHash,
      horizonCommitment: record.commitment,
      gameConfig: record.t0GameConfig,
    });
    if (
      expectedSeed !== record.gameSeed ||
      policyHash !== record.policyHash ||
      !equalBytes(encodedInput, record.commitmentInput) ||
      !equalBytes(encodedConfigInput, record.configInput) ||
      !verifyHorizonCommitment(record.commitment, input) ||
      recomputedConfigHash !== t0ConfigHash ||
      t0ConfigHash !== configHash
    ) {
      return { ok: false };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function revealTournamentHorizon(record: TournamentCommitmentRecord): HorizonReveal {
  return {
    secret: parseBytes32Hex(record.horizonSecret, 'horizonSecret'),
    playerEntropy: parseBytes32Hex(record.playerEntropy, 'playerEntropy'),
  };
}
