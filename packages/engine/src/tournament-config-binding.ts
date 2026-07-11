import { canonicalEncode } from './canonical-encoding.js';
import { createHiddenHorizonPublicConfig } from './hidden-horizon.js';
import {
  type Bytes32Hex,
  encodeTournamentConfig,
  type TournamentPolicy,
} from './tournament-encoding.js';

export type TournamentConfigBinding = {
  readonly tournamentRootSeed: Bytes32Hex;
  readonly gameSeed: Bytes32Hex;
  readonly tournamentId: string;
  readonly gameId: string;
  readonly gameIndex: number;
  readonly gameType: string;
  readonly playerIds: readonly string[];
  readonly policyHash: Bytes32Hex;
  readonly commitment: Bytes32Hex;
  readonly t0GameConfig: unknown;
};

export class TournamentConfigBindingError extends Error {
  readonly name = 'TournamentConfigBindingError';

  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`Invalid tournament config ${field}: ${reason}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PRIVATE_CONFIG_KEYS = new Set([
  'horizonsecret',
  'secret',
  'playerentropy',
  'entropy',
  'tournamentrootseed',
  'rootseed',
  'horizonreveal',
  'commitmentinput',
  'configinput',
  'privatepayload',
  'privatematerial',
  'confighash',
]);
const BYTES32_HEX = /^0x[0-9a-f]{64}$/i;

function normalizedKey(key: string): string {
  return key.replace(/[-_]/g, '').toLowerCase();
}

function freezeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) freezeValue(item);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) freezeValue(item);
    return Object.freeze(value);
  }
  return value;
}

export function snapshotTournamentPlayerIds(playerIds: readonly string[]): readonly string[] {
  if (playerIds.some((playerId) => typeof playerId !== 'string' || playerId.length === 0)) {
    throw new TournamentConfigBindingError('playerIds', playerIds, 'expected non-empty strings');
  }
  return Object.freeze([...playerIds]);
}

export function snapshotTournamentGameConfig(
  gameConfig: unknown,
  privateInputs: {
    readonly tournamentRootSeed: Bytes32Hex;
    readonly horizonSecret: Bytes32Hex;
    readonly playerEntropy: Bytes32Hex;
  },
): unknown {
  const privateValues = new Set<string>([
    privateInputs.tournamentRootSeed.toLowerCase(),
    privateInputs.horizonSecret.toLowerCase(),
    privateInputs.playerEntropy.toLowerCase(),
  ]);
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (BYTES32_HEX.test(value) && privateValues.has(value.toLowerCase())) {
        throw new TournamentConfigBindingError(
          'gameConfig',
          undefined,
          'contains private tournament material',
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (PRIVATE_CONFIG_KEYS.has(normalizedKey(key))) {
          throw new TournamentConfigBindingError(
            'gameConfig',
            undefined,
            'contains a private field',
          );
        }
        visit(item);
      }
    }
  };
  visit(gameConfig);
  const snapshot = structuredClone(gameConfig);
  canonicalEncode(snapshot);
  return freezeValue(snapshot);
}

export function verifyTournamentPublicHorizon(
  gameConfig: unknown,
  commitment: Bytes32Hex,
  policy: TournamentPolicy,
): void {
  if (!isRecord(gameConfig) || !isRecord(gameConfig.hiddenHorizon)) {
    throw new TournamentConfigBindingError('hiddenHorizon', gameConfig, 'is required');
  }
  const expected = createHiddenHorizonPublicConfig(commitment, policy);
  const expectedKeys = Object.keys(expected);
  const expectedValues: readonly unknown[] = [
    expected.commitment,
    expected.policyHash,
    expected.minRounds,
    expected.maxRounds,
    expected.hazardNumerator,
    expected.hazardDenominator,
  ];
  const actual = gameConfig.hiddenHorizon;
  const actualKeys = Object.keys(actual);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key, index) => actual[key] !== expectedValues[index])
  ) {
    throw new TournamentConfigBindingError(
      'hiddenHorizon',
      actual,
      'does not match the committed policy',
    );
  }
}

export function encodeTournamentConfigBinding(input: TournamentConfigBinding): Uint8Array {
  return encodeTournamentConfig({
    tournamentRootSeed: input.tournamentRootSeed,
    gameSeed: input.gameSeed,
    tournamentId: input.tournamentId,
    gameId: input.gameId,
    gameIndex: input.gameIndex,
    gameType: input.gameType,
    playerIds: input.playerIds,
    policyHash: input.policyHash,
    horizonCommitment: input.commitment,
    gameConfig: input.t0GameConfig,
  });
}
