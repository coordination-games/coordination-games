import { describe, expect, it } from 'vitest';
import { NonIntegerNumberError, NonPojoValueError } from '../canonical-encoding.js';
import {
  computeHiddenHorizonPrfDigest,
  computeHorizonCommitment,
  computeTournamentConfigHash,
  computeTournamentPolicyHash,
  deriveTournamentGameSeed,
  type HorizonCommitmentInput,
  parseBytes32Hex,
  type TournamentConfigHashInput,
  TournamentEncodingError,
  type TournamentPolicy,
  verifyHorizonCommitment,
} from '../tournament-encoding.js';

const ZERO = parseBytes32Hex(`0x${'00'.repeat(32)}`);
const ONE = parseBytes32Hex(`0x${'11'.repeat(32)}`);
const TWO = parseBytes32Hex(`0x${'22'.repeat(32)}`);
const THREE = parseBytes32Hex(`0x${'33'.repeat(32)}`);

const POLICY: TournamentPolicy = {
  seriesLength: 3,
  baseEntryCost: 10_000_000n,
  carryBps: 2_000,
  slashBps: 500,
  minRounds: 2,
  maxRounds: 10,
  hazardNumerator: 1,
  hazardDenominator: 5,
};

const POLICY_HASH = computeTournamentPolicyHash(POLICY);
const HORIZON_INPUT: HorizonCommitmentInput = {
  secret: ZERO,
  gameId: 'game\u001fα',
  playerEntropy: ONE,
  policyHash: POLICY_HASH,
};
const COMMITMENT = computeHorizonCommitment(HORIZON_INPUT);
const CONFIG: TournamentConfigHashInput = {
  tournamentRootSeed: TWO,
  gameSeed: deriveTournamentGameSeed(TWO, 'tournament\u001e🔥', 0),
  tournamentId: 'tournament\u001e🔥',
  gameId: HORIZON_INPUT.gameId,
  gameIndex: 0,
  gameType: 'tragedy-of-the-commons/v2',
  playerIds: ['player\u001eone', '玩家二'],
  policyHash: POLICY_HASH,
  horizonCommitment: COMMITMENT,
  gameConfig: { rounds: [1, 2], nested: { b: 2, a: 1 } },
};

describe('parseBytes32Hex', () => {
  it('normalizes uppercase hex to lowercase', () => {
    expect(parseBytes32Hex(`0x${'AB'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`);
  });

  it.each([`0x${'00'.repeat(31)}`, `0x${'gg'.repeat(32)}`, '00'])('rejects invalid %s', (value) => {
    expect(() => parseBytes32Hex(value)).toThrow(TournamentEncodingError);
  });
});

describe('tournament policy commitment', () => {
  const tamperedPolicies: readonly TournamentPolicy[] = [
    { ...POLICY, seriesLength: 4 },
    { ...POLICY, baseEntryCost: 10_000_001n },
    { ...POLICY, carryBps: 2_001 },
    { ...POLICY, slashBps: 501 },
    { ...POLICY, minRounds: 3 },
    { ...POLICY, maxRounds: 11 },
    { ...POLICY, hazardNumerator: 2 },
    { ...POLICY, hazardDenominator: 6 },
  ];

  it.each(tamperedPolicies)('changes when any covered field changes', (tampered) => {
    expect(computeTournamentPolicyHash(tampered)).not.toBe(POLICY_HASH);
  });

  it.each([
    { ...POLICY, seriesLength: 0 },
    { ...POLICY, seriesLength: Number.MAX_SAFE_INTEGER + 1 },
    { ...POLICY, baseEntryCost: -1n },
    { ...POLICY, carryBps: 10_001 },
    { ...POLICY, slashBps: -1 },
    { ...POLICY, minRounds: 0 },
    { ...POLICY, maxRounds: 1 },
    { ...POLICY, hazardNumerator: -1 },
    { ...POLICY, hazardNumerator: 6 },
    { ...POLICY, hazardDenominator: 0 },
  ])('rejects invalid unsigned or out-of-range policy integers', (invalidPolicy) => {
    expect(() => computeTournamentPolicyHash(invalidPolicy)).toThrow(TournamentEncodingError);
  });
});

describe('hidden horizon commitment and PRF', () => {
  it.each([
    { ...HORIZON_INPUT, secret: THREE },
    { ...HORIZON_INPUT, gameId: `${HORIZON_INPUT.gameId}-tampered` },
    { ...HORIZON_INPUT, playerEntropy: TWO },
    { ...HORIZON_INPUT, policyHash: THREE },
  ])('commits every input field', (tampered) => {
    expect(computeHorizonCommitment(tampered)).not.toBe(COMMITMENT);
  });

  it('verifies through the same commitment encoder and rejects a wrong secret', () => {
    expect(verifyHorizonCommitment(COMMITMENT, HORIZON_INPUT)).toBe(true);
    expect(verifyHorizonCommitment(COMMITMENT, { ...HORIZON_INPUT, secret: THREE })).toBe(false);
  });

  it('uses a distinct secret-keyed PRF domain', () => {
    const digest = computeHiddenHorizonPrfDigest(HORIZON_INPUT);
    expect(digest).not.toBe(COMMITMENT);
    expect(computeHiddenHorizonPrfDigest({ ...HORIZON_INPUT, secret: THREE })).not.toBe(digest);
  });
});

describe('t0 tournament config hash', () => {
  it.each([
    { ...CONFIG, tournamentRootSeed: THREE },
    { ...CONFIG, gameSeed: THREE },
    { ...CONFIG, tournamentId: `${CONFIG.tournamentId}-tampered` },
    { ...CONFIG, gameId: `${CONFIG.gameId}-tampered` },
    { ...CONFIG, gameIndex: 1 },
    { ...CONFIG, gameType: `${CONFIG.gameType}-tampered` },
    { ...CONFIG, playerIds: [...CONFIG.playerIds].reverse() },
    { ...CONFIG, policyHash: THREE },
    { ...CONFIG, horizonCommitment: THREE },
    { ...CONFIG, gameConfig: { rounds: [1, 3], nested: { b: 2, a: 1 } } },
  ])('changes when any frozen config field changes', (tampered) => {
    expect(computeTournamentConfigHash(tampered)).not.toBe(computeTournamentConfigHash(CONFIG));
  });

  it('preserves player order while framing separators and Unicode unambiguously', () => {
    const ambiguousWithoutLengths = { ...CONFIG, playerIds: ['a', 'bc'] };
    const differentlySplit = { ...CONFIG, playerIds: ['ab', 'c'] };
    expect(computeTournamentConfigHash(ambiguousWithoutLengths)).not.toBe(
      computeTournamentConfigHash(differentlySplit),
    );
  });

  it('is invariant to nested gameConfig object key insertion order', () => {
    const reordered = {
      ...CONFIG,
      gameConfig: { nested: { a: 1, b: 2 }, rounds: [1, 2] },
    };
    expect(computeTournamentConfigHash(reordered)).toBe(computeTournamentConfigHash(CONFIG));
  });

  it('inherits canonicalEncode float and non-POJO rejection', () => {
    expect(() => computeTournamentConfigHash({ ...CONFIG, gameConfig: { hazard: 0.5 } })).toThrow(
      NonIntegerNumberError,
    );
    expect(() => computeTournamentConfigHash({ ...CONFIG, gameConfig: new Map() })).toThrow(
      NonPojoValueError,
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid game index %s', (gameIndex) => {
    expect(() => computeTournamentConfigHash({ ...CONFIG, gameIndex })).toThrow(
      TournamentEncodingError,
    );
    expect(() => deriveTournamentGameSeed(TWO, CONFIG.tournamentId, gameIndex)).toThrow(
      TournamentEncodingError,
    );
  });
});
