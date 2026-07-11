import { describe, expect, it } from 'vitest';
import {
  type Bytes32Hex,
  computeHiddenHorizonPrfDigest,
  computeTournamentPolicyHash,
  deriveStopRound,
  HiddenHorizonError,
  parseBytes32Hex,
  type TournamentPolicy,
} from '../index.js';

const SECRET = parseBytes32Hex(
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
);
const OTHER_SECRET = parseBytes32Hex(`0x${'20'.repeat(32)}`);
const PLAYER_ENTROPY = parseBytes32Hex(
  '0x404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
);
const OTHER_ENTROPY = parseBytes32Hex(`0x${'60'.repeat(32)}`);
const TASK4_POLICY_HASH = parseBytes32Hex(
  '0x1af7a87c9e0d8cb0c0843dbf3e29d878e267c0a35d6cced0155a8b3841837f29',
);
const FAKE_POLICY_HASH = parseBytes32Hex(`0x${'70'.repeat(32)}`);
const OTHER_FAKE_POLICY_HASH = parseBytes32Hex(`0x${'80'.repeat(32)}`);
const POLICY: TournamentPolicy = {
  seriesLength: 3,
  baseEntryCost: 12_500_000n,
  carryBps: 2_500,
  slashBps: 500,
  minRounds: 2,
  maxRounds: 9,
  hazardNumerator: 1,
  hazardDenominator: 4,
};
const POLICY_VARIANTS = [
  ['seriesLength', { ...POLICY, seriesLength: 4 }],
  ['baseEntryCost', { ...POLICY, baseEntryCost: 12_500_001n }],
  ['carryBps', { ...POLICY, carryBps: 2_501 }],
  ['slashBps', { ...POLICY, slashBps: 501 }],
  ['minRounds', { ...POLICY, minRounds: 3 }],
  ['maxRounds', { ...POLICY, maxRounds: 10 }],
  ['hazardNumerator', { ...POLICY, hazardNumerator: 2 }],
  ['hazardDenominator', { ...POLICY, hazardDenominator: 5 }],
] satisfies readonly (readonly [string, TournamentPolicy])[];

function deriveRuntime(args: readonly unknown[]): unknown {
  return Reflect.apply(deriveStopRound, undefined, args);
}

function expectHiddenHorizonError(field: string, run: () => unknown): void {
  try {
    run();
    expect.fail(`expected HiddenHorizonError for ${field}`);
  } catch (error) {
    if (!(error instanceof HiddenHorizonError)) throw error;
    expect(error.field).toBe(field);
  }
}

function sequence(
  secret: Bytes32Hex,
  gamePrefix: string,
  entropy: Bytes32Hex,
  policy: TournamentPolicy,
): readonly number[] {
  return Array.from({ length: 32 }, (_, index) =>
    deriveStopRound(secret, `${gamePrefix}-${index}`, entropy, policy),
  );
}

describe('deriveStopRound', () => {
  it('locks the Task 4 PRF vector to a deterministic stop round', () => {
    // Given the exact Task 4 secret, game ID, entropy, and policy hash vector
    // When the truncated-geometric endpoint is derived
    expect(computeTournamentPolicyHash(POLICY)).toBe(TASK4_POLICY_HASH);
    const stopRound = deriveStopRound(SECRET, 'game\u001f42/β', PLAYER_ENTROPY, POLICY);

    // Then replay is stable and the independently calculated endpoint is pinned
    expect(stopRound).toBe(3);
    expect(deriveStopRound(SECRET, 'game\u001f42/β', PLAYER_ENTROPY, POLICY)).toBe(3);
  });

  it('changes deterministic corpus outputs when any non-policy PRF input changes', () => {
    // Given a replayable corpus under one hidden-horizon policy
    const baseline = sequence(SECRET, 'sensitivity', PLAYER_ENTROPY, POLICY);

    // When one secret-keyed PRF input changes at a time
    // Then each resulting corpus differs from the baseline
    expect(sequence(OTHER_SECRET, 'sensitivity', PLAYER_ENTROPY, POLICY)).not.toEqual(baseline);
    expect(sequence(SECRET, 'other-game', PLAYER_ENTROPY, POLICY)).not.toEqual(baseline);
    expect(sequence(SECRET, 'sensitivity', OTHER_ENTROPY, POLICY)).not.toEqual(baseline);
  });

  it.each(
    POLICY_VARIANTS,
  )('binds changed full-policy field %s into the PRF sequence', (_, variant) => {
    // Given a full policy field change covered by Task 4 policyHash
    const baselineHash = computeTournamentPolicyHash(POLICY);
    const changedHash = computeTournamentPolicyHash(variant);
    const baselineDigest = computeHiddenHorizonPrfDigest({
      secret: SECRET,
      gameId: 'full-policy-binding',
      playerEntropy: PLAYER_ENTROPY,
      policyHash: baselineHash,
    });

    // When the changed policy hash drives the Task 4 PRF domain
    const changedDigest = computeHiddenHorizonPrfDigest({
      secret: SECRET,
      gameId: 'full-policy-binding',
      playerEntropy: PLAYER_ENTROPY,
      policyHash: changedHash,
    });

    // Then both the keyed digest and a deterministic derived corpus change
    expect(changedHash).not.toBe(baselineHash);
    expect(changedDigest).not.toBe(baselineDigest);
    expect(sequence(SECRET, 'full-policy-binding', PLAYER_ENTROPY, variant)).not.toEqual(
      sequence(SECRET, 'full-policy-binding', PLAYER_ENTROPY, POLICY),
    );
  });

  it('ignores injected policyHash values and derives only from the full policy', () => {
    // Given equivalent full policies polluted with two caller-controlled hashes
    const firstInjected = { ...POLICY, policyHash: FAKE_POLICY_HASH };
    const secondInjected = { ...POLICY, policyHash: OTHER_FAKE_POLICY_HASH };

    // When deterministic corpora are derived
    const expected = sequence(SECRET, 'injected-hash', PLAYER_ENTROPY, POLICY);

    // Then neither injected hash can influence the PRF sequence
    expect(sequence(SECRET, 'injected-hash', PLAYER_ENTROPY, firstInjected)).toEqual(expected);
    expect(sequence(SECRET, 'injected-hash', PLAYER_ENTROPY, secondInjected)).toEqual(expected);
  });

  it('handles degenerate hazards and the forced cap without an unbounded loop', () => {
    // Given valid boundary policies
    const fixed = { ...POLICY, minRounds: 7, maxRounds: 7 };
    const neverStop = { ...POLICY, hazardNumerator: 0 };
    const alwaysStop = { ...POLICY, hazardNumerator: 4 };
    const forcedCap = { ...POLICY, maxRounds: 3 };

    // When each endpoint is derived
    // Then fixed/zero/full hazards short-circuit and residual mass lands on the cap
    expect(deriveStopRound(SECRET, 'fixed', PLAYER_ENTROPY, fixed)).toBe(7);
    expect(deriveStopRound(SECRET, 'zero', PLAYER_ENTROPY, neverStop)).toBe(9);
    expect(deriveStopRound(SECRET, 'full', PLAYER_ENTROPY, alwaysStop)).toBe(2);
    expect(
      Array.from({ length: 32 }, (_, index) =>
        deriveStopRound(SECRET, `forced-cap-${index}`, PLAYER_ENTROPY, forcedCap),
      ),
    ).toContain(3);
  });

  it('approximates truncated-geometric frequencies over a deterministic corpus', () => {
    // Given a fixed 4096-game corpus and hazard 1/4 over rounds 2..6
    const sampleCount = 4096;
    const corpusPolicy = { ...POLICY, maxRounds: 6 };

    // When every endpoint is derived without random or clock input
    const stops = Array.from({ length: sampleCount }, (_, index) =>
      deriveStopRound(SECRET, `distribution-${index}`, PLAYER_ENTROPY, corpusPolicy),
    );
    const counts = [2, 3, 4, 5, 6].map(
      (round) => stops.filter((stopRound) => stopRound === round).length,
    );
    const survival = [2, 3, 4, 5, 6].map(
      (round) => stops.filter((stopRound) => stopRound >= round).length,
    );
    const expected = [1024, 768, 576, 432, 1296];

    // Then frequencies track the exact rational masses and pre-cap stop mass decreases
    for (const [index, expectedCount] of expected.entries()) {
      expect(Math.abs((counts[index] ?? 0) - expectedCount)).toBeLessThanOrEqual(150);
    }
    expect(counts.slice(0, -1)).toEqual([...counts.slice(0, -1)].sort((a, b) => b - a));
    expect(survival).toEqual([...survival].sort((a, b) => b - a));
  });

  it.each([
    ['seriesLength', { ...POLICY, seriesLength: 0 }],
    ['baseEntryCost', { ...POLICY, baseEntryCost: -1n }],
    ['carryBps', { ...POLICY, carryBps: 10_001 }],
    ['slashBps', { ...POLICY, slashBps: -1 }],
    ['minRounds', { ...POLICY, minRounds: 0 }],
    ['minRounds', { ...POLICY, minRounds: 1.5 }],
    ['maxRounds', { ...POLICY, maxRounds: 1 }],
    ['maxRounds', { ...POLICY, maxRounds: 65_536 }],
    ['maxRounds', { ...POLICY, maxRounds: Number.MAX_SAFE_INTEGER + 1 }],
    ['hazardNumerator', { ...POLICY, hazardNumerator: -1 }],
    ['hazardNumerator', { ...POLICY, hazardNumerator: 1.5 }],
    ['hazardNumerator', { ...POLICY, hazardNumerator: 5 }],
    ['hazardDenominator', { ...POLICY, hazardNumerator: 0, hazardDenominator: 0 }],
    ['hazardDenominator', { ...POLICY, hazardDenominator: 2.5 }],
    ['hazardDenominator', { ...POLICY, hazardDenominator: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects invalid policy field %s', (field, invalidPolicy) => {
    expectHiddenHorizonError(field, () =>
      deriveRuntime([SECRET, 'invalid-policy', PLAYER_ENTROPY, invalidPolicy]),
    );
  });

  it.each([
    ['secret', '', 'game', PLAYER_ENTROPY, POLICY],
    ['secret', `0x${'00'.repeat(31)}`, 'game', PLAYER_ENTROPY, POLICY],
    ['gameId', SECRET, '', PLAYER_ENTROPY, POLICY],
    ['playerEntropy', SECRET, 'game', `0x${'gg'.repeat(32)}`, POLICY],
  ])('rejects malformed runtime field %s without exposing input values', (field, ...args) => {
    expectHiddenHorizonError(field, () => deriveRuntime(args));
  });
});
