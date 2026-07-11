import { keccak256 } from 'viem';
import { z } from 'zod';
import { canonicalEncode } from './canonical-encoding.js';
/**
 * Tournament commitment record v1.
 * Exact byte grammar (all names/domains are ASCII):
 *   record = UTF8(domain) || 0x1e || field...
 *   field  = UTF8(name) || 0x1f || uint32be(value.byteLength) || value || 0x1e
 * Every field value is length-framed, so separator bytes inside UTF-8 strings
 * are data, never syntax. Fields occur only in the documented order below.
 * Integers are canonical unsigned base-10 UTF-8 (no sign or leading zeroes).
 * Bytes32 values are lowercase-normalized hex at the API boundary and encoded
 * as their 32 raw bytes. Player arrays encode count then repeated playerId
 * fields in caller order. Only gameConfig uses canonicalEncode JSON bytes.
 */
export const TOURNAMENT_ENCODING_DOMAINS = {
  policy: 'coordination.games/tournament-policy/v1',
  horizonCommitment: 'coordination.games/horizon-commitment/v1',
  hiddenHorizonPrf: 'coordination.games/hidden-horizon-prf/v1',
  gameSeed: 'coordination.games/tournament-game-seed/v1',
  roomName: 'coordination.games/tournament-room-name/v1',
  horizonSecret: 'coordination.games/tournament-horizon-secret/v1',
  config: 'coordination.games/tournament-config/v1',
} as const;
const BYTES32_HEX_SCHEMA = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase())
  .brand<'Bytes32Hex'>();
export type Bytes32Hex = z.infer<typeof BYTES32_HEX_SCHEMA>;
export type TournamentPolicy = {
  readonly seriesLength: number;
  readonly baseEntryCost: bigint;
  readonly carryBps: number;
  readonly slashBps: number;
  readonly minRounds: number;
  readonly maxRounds: number;
  readonly hazardNumerator: number;
  readonly hazardDenominator: number;
};
export type HorizonCommitmentInput = {
  readonly secret: Bytes32Hex;
  readonly gameId: string;
  readonly playerEntropy: Bytes32Hex;
  readonly policyHash: Bytes32Hex;
};
export type TournamentConfigHashInput = {
  readonly tournamentRootSeed: Bytes32Hex;
  readonly gameSeed: Bytes32Hex;
  readonly tournamentId: string;
  readonly gameId: string;
  readonly gameIndex: number;
  readonly gameType: string;
  readonly playerIds: readonly string[];
  readonly policyHash: Bytes32Hex;
  readonly horizonCommitment: Bytes32Hex;
  readonly gameConfig: unknown;
};
export class TournamentEncodingError extends Error {
  readonly name = 'TournamentEncodingError';
  constructor(
    readonly field: string,
    readonly value: unknown,
    reason: string,
  ) {
    super(`Invalid tournament encoding field ${field}: ${reason}`);
  }
}
type Field = readonly [name: string, value: Uint8Array];
type NumberBounds = { readonly min: number; readonly max?: number };
const RECORD_SEPARATOR = Uint8Array.of(0x1e);
const FIELD_SEPARATOR = Uint8Array.of(0x1f);
const TEXT_ENCODER = new TextEncoder();
const MAX_UINT32 = 0xffff_ffff;
const MAX_BPS = 10_000;
export function parseBytes32Hex(value: unknown, field = 'bytes32'): Bytes32Hex {
  const result = BYTES32_HEX_SCHEMA.safeParse(value);
  if (!result.success) {
    throw new TournamentEncodingError(field, value, 'expected 0x plus exactly 64 hex digits');
  }
  return result.data;
}
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
function uint32be(value: number): Uint8Array {
  return Uint8Array.of(
    Math.floor(value / 0x1_00_00_00) & 0xff,
    Math.floor(value / 0x1_00_00) & 0xff,
    Math.floor(value / 0x1_00) & 0xff,
    value & 0xff,
  );
}
function encodeRecord(domain: string, fields: readonly Field[]): Uint8Array {
  const parts: Uint8Array[] = [TEXT_ENCODER.encode(domain), RECORD_SEPARATOR];
  for (const [name, value] of fields) {
    if (value.byteLength > MAX_UINT32) {
      throw new TournamentEncodingError(
        name,
        value.byteLength,
        'value exceeds uint32 length frame',
      );
    }
    parts.push(
      TEXT_ENCODER.encode(name),
      FIELD_SEPARATOR,
      uint32be(value.byteLength),
      value,
      RECORD_SEPARATOR,
    );
  }
  return concatBytes(parts);
}
function bytes32(field: string, value: Bytes32Hex): Uint8Array {
  const normalized = parseBytes32Hex(value, field);
  return Uint8Array.from({ length: 32 }, (_, index) => {
    const start = 2 + index * 2;
    return Number.parseInt(normalized.slice(start, start + 2), 16);
  });
}
function unsignedNumber(field: string, value: number, bounds: NumberBounds): Uint8Array {
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < bounds.min || value > max) {
    throw new TournamentEncodingError(field, value, `expected integer in [${bounds.min}, ${max}]`);
  }
  return TEXT_ENCODER.encode(value.toString(10));
}
function unsignedBigInt(field: string, value: bigint): Uint8Array {
  if (value < 0n) {
    throw new TournamentEncodingError(field, value, 'expected unsigned bigint');
  }
  return TEXT_ENCODER.encode(value.toString(10));
}
function hashEncoded(bytes: Uint8Array): Bytes32Hex {
  return parseBytes32Hex(keccak256(bytes));
}

/** Policy order: seriesLength, baseEntryCost, carryBps, slashBps, minRounds,
 * maxRounds, hazardNumerator, hazardDenominator. */
export function encodeTournamentPolicy(policy: TournamentPolicy): Uint8Array {
  if (policy.maxRounds < policy.minRounds) {
    throw new TournamentEncodingError('maxRounds', policy.maxRounds, 'must be >= minRounds');
  }
  if (policy.hazardNumerator > policy.hazardDenominator) {
    throw new TournamentEncodingError(
      'hazardNumerator',
      policy.hazardNumerator,
      'must be <= hazardDenominator',
    );
  }
  return encodeRecord(TOURNAMENT_ENCODING_DOMAINS.policy, [
    ['seriesLength', unsignedNumber('seriesLength', policy.seriesLength, { min: 1 })],
    ['baseEntryCost', unsignedBigInt('baseEntryCost', policy.baseEntryCost)],
    ['carryBps', unsignedNumber('carryBps', policy.carryBps, { min: 0, max: MAX_BPS })],
    ['slashBps', unsignedNumber('slashBps', policy.slashBps, { min: 0, max: MAX_BPS })],
    ['minRounds', unsignedNumber('minRounds', policy.minRounds, { min: 1 })],
    ['maxRounds', unsignedNumber('maxRounds', policy.maxRounds, { min: 1 })],
    ['hazardNumerator', unsignedNumber('hazardNumerator', policy.hazardNumerator, { min: 0 })],
    [
      'hazardDenominator',
      unsignedNumber('hazardDenominator', policy.hazardDenominator, { min: 1 }),
    ],
  ]);
}

export function computeTournamentPolicyHash(policy: TournamentPolicy): Bytes32Hex {
  return hashEncoded(encodeTournamentPolicy(policy));
}
function encodeHorizonInput(domain: string, input: HorizonCommitmentInput): Uint8Array {
  return encodeRecord(domain, [
    ['secret', bytes32('secret', input.secret)],
    ['gameId', TEXT_ENCODER.encode(input.gameId)],
    ['playerEntropy', bytes32('playerEntropy', input.playerEntropy)],
    ['policyHash', bytes32('policyHash', input.policyHash)],
  ]);
}

export function encodeHorizonCommitmentInput(input: HorizonCommitmentInput): Uint8Array {
  return encodeHorizonInput(TOURNAMENT_ENCODING_DOMAINS.horizonCommitment, input);
}

export function computeHorizonCommitment(input: HorizonCommitmentInput): Bytes32Hex {
  return hashEncoded(encodeHorizonCommitmentInput(input));
}

export function verifyHorizonCommitment(
  commitment: Bytes32Hex,
  input: HorizonCommitmentInput,
): boolean {
  return computeHorizonCommitment(input) === parseBytes32Hex(commitment, 'commitment');
}

export function encodeHiddenHorizonPrfInput(input: HorizonCommitmentInput): Uint8Array {
  return encodeHorizonInput(TOURNAMENT_ENCODING_DOMAINS.hiddenHorizonPrf, input);
}

export function computeHiddenHorizonPrfDigest(input: HorizonCommitmentInput): Bytes32Hex {
  return hashEncoded(encodeHiddenHorizonPrfInput(input));
}

export function encodeTournamentGameSeedInput(
  rootSeed: Bytes32Hex,
  tournamentId: string,
  gameIndex: number,
): Uint8Array {
  return encodeRecord(TOURNAMENT_ENCODING_DOMAINS.gameSeed, [
    ['tournamentRootSeed', bytes32('tournamentRootSeed', rootSeed)],
    ['tournamentId', TEXT_ENCODER.encode(tournamentId)],
    ['gameIndex', unsignedNumber('gameIndex', gameIndex, { min: 0 })],
  ]);
}

export function deriveTournamentGameSeed(
  rootSeed: Bytes32Hex,
  tournamentId: string,
  gameIndex: number,
): Bytes32Hex {
  return hashEncoded(encodeTournamentGameSeedInput(rootSeed, tournamentId, gameIndex));
}

export function deriveTournamentRoomName(tournamentId: string, gameIndex: number): Bytes32Hex {
  return hashEncoded(
    encodeRecord(TOURNAMENT_ENCODING_DOMAINS.roomName, [
      ['tournamentId', TEXT_ENCODER.encode(tournamentId)],
      ['gameIndex', unsignedNumber('gameIndex', gameIndex, { min: 0 })],
    ]),
  );
}

export function deriveTournamentHorizonSecret(
  rootSeed: Bytes32Hex,
  tournamentId: string,
  gameIndex: number,
): Bytes32Hex {
  return hashEncoded(
    encodeRecord(TOURNAMENT_ENCODING_DOMAINS.horizonSecret, [
      ['tournamentRootSeed', bytes32('tournamentRootSeed', rootSeed)],
      ['tournamentId', TEXT_ENCODER.encode(tournamentId)],
      ['gameIndex', unsignedNumber('gameIndex', gameIndex, { min: 0 })],
    ]),
  );
}

/** Config order: root seed, game seed, tournament/game IDs, index/type,
 * player count + ordered player IDs, policy hash, horizon commitment, gameConfig. */
export function encodeTournamentConfig(input: TournamentConfigHashInput): Uint8Array {
  const playerFields: Field[] = input.playerIds.map((playerId) => [
    'playerId',
    TEXT_ENCODER.encode(playerId),
  ]);
  return encodeRecord(TOURNAMENT_ENCODING_DOMAINS.config, [
    ['tournamentRootSeed', bytes32('tournamentRootSeed', input.tournamentRootSeed)],
    ['gameSeed', bytes32('gameSeed', input.gameSeed)],
    ['tournamentId', TEXT_ENCODER.encode(input.tournamentId)],
    ['gameId', TEXT_ENCODER.encode(input.gameId)],
    ['gameIndex', unsignedNumber('gameIndex', input.gameIndex, { min: 0 })],
    ['gameType', TEXT_ENCODER.encode(input.gameType)],
    ['playerCount', unsignedNumber('playerCount', input.playerIds.length, { min: 0 })],
    ...playerFields,
    ['policyHash', bytes32('policyHash', input.policyHash)],
    ['horizonCommitment', bytes32('horizonCommitment', input.horizonCommitment)],
    ['gameConfig', canonicalEncode(input.gameConfig)],
  ]);
}

export function computeTournamentConfigHash(input: TournamentConfigHashInput): Bytes32Hex {
  return hashEncoded(encodeTournamentConfig(input));
}
