import { describe, expect, it } from 'vitest';
import {
  computeHorizonCommitment,
  computeTournamentConfigHash,
  computeTournamentPolicyHash,
  createHiddenHorizonPublicConfig,
  createTournamentCommitment,
  encodeTournamentConfig,
  verifyTournamentCommitment,
} from '../index.js';
import { parseBytes32Hex } from '../tournament-encoding.js';

const ROOT_SEED = parseBytes32Hex(
  '0x202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
);
const SECRET = parseBytes32Hex(
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
);
const ENTROPY = parseBytes32Hex(
  '0x404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
);

const context = {
  tournamentRootSeed: ROOT_SEED,
  gameSeed: parseBytes32Hex('0xa63f21a40fa9df01e8f117353b711f0e7b24fd46639b0e99505f601f229d992c'),
  tournamentId: 'tourney\u001e🔥/α',
  gameIndex: 7,
  policy: {
    seriesLength: 3,
    baseEntryCost: 12_500_000n,
    carryBps: 2_500,
    slashBps: 500,
    minRounds: 2,
    maxRounds: 9,
    hazardNumerator: 1,
    hazardDenominator: 4,
  },
  economics: {
    baseEntryCost: 12_500_000n,
    entryCost: 12_500_000n,
    playerCount: 3,
    basePot: 37_500_000n,
    incomingCarry: 0n,
    releasedCarry: 0n,
    carryRemainder: 0n,
    carry: 9_375_000n,
    slash: 1_875_000n,
    treasuryDelta: 11_250_000n,
  },
  horizonSecret: SECRET,
  playerEntropy: ENTROPY,
};

const policyHash = computeTournamentPolicyHash(context.policy);
const commitment = computeHorizonCommitment({
  secret: context.horizonSecret,
  gameId: 'game\u001f42/β',
  playerEntropy: context.playerEntropy,
  policyHash,
});
const publicConfig = {
  stake: 99n,
  nested: { z: 2, a: 1 },
  rounds: [1, 2],
  tournamentEconomics: { entryCost: '12500000' },
  hiddenHorizon: createHiddenHorizonPublicConfig(commitment, context.policy),
};

function createRecord() {
  return createTournamentCommitment({
    context,
    gameId: 'game\u001f42/β',
    gameType: 'tragedy-of-the-commons/v2',
    playerIds: ['alice\u001e', 'ボブ', 'carol\u001f|'],
    gameConfig: publicConfig,
  });
}

describe('tournament commitment lifecycle', () => {
  it('Given a valid t0 context, when sealing it, then it pins Task 4 commitment bytes and config hash', () => {
    const record = createRecord();

    expect(record.commitment).toBe(
      '0x6e3b34a0186ede98b01a04c475d0cdd99946596181c4ad68f3dca68359636178',
    );
    expect(record.configHash).toBe(record.t0ConfigHash);
    expect(record.configInput).toEqual(
      encodeTournamentConfig({
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
      }),
    );
    expect(verifyTournamentCommitment(record)).toEqual({ ok: true });
  });

  it.each([
    (record: ReturnType<typeof createRecord>) => ({ ...record, horizonSecret: ENTROPY }),
    (record: ReturnType<typeof createRecord>) => ({ ...record, playerEntropy: SECRET }),
    (record: ReturnType<typeof createRecord>) => ({ ...record, policyHash: SECRET }),
    (record: ReturnType<typeof createRecord>) => ({ ...record, commitment: SECRET }),
    (record: ReturnType<typeof createRecord>) => ({
      ...record,
      commitmentInput: Uint8Array.from(record.commitmentInput, (byte, index) =>
        index === 0 ? byte ^ 1 : byte,
      ),
    }),
    (record: ReturnType<typeof createRecord>) => ({ ...record, t0ConfigHash: SECRET }),
  ])('Given a tampered sealed field, when verifying before reveal, then it fails closed', (tamper) => {
    expect(verifyTournamentCommitment(tamper(createRecord()))).toEqual({ ok: false });
  });

  it('Given a mismatched derived game seed, when sealing a create context, then it rejects it', () => {
    expect(() =>
      createTournamentCommitment({
        context: { ...context, gameSeed: SECRET },
        gameId: 'game\u001f42/β',
        gameType: 'tragedy-of-the-commons/v2',
        playerIds: ['alice\u001e', 'ボブ', 'carol\u001f|'],
        gameConfig: publicConfig,
      }),
    ).toThrow('gameSeed');
  });

  it('Given a missing or mismatched public horizon projection, when sealing, then it rejects before hashing', () => {
    expect(() =>
      createTournamentCommitment({
        context,
        gameId: 'game\u001f42/β',
        gameType: 'tragedy-of-the-commons/v2',
        playerIds: ['alice\u001e', 'ボブ', 'carol\u001f|'],
        gameConfig: {
          ...publicConfig,
          hiddenHorizon: {
            ...publicConfig.hiddenHorizon,
            commitment: parseBytes32Hex(`0x${'55'.repeat(32)}`),
          },
        },
      }),
    ).toThrow('hiddenHorizon');
  });

  it.each([
    { ...publicConfig, diagnostics: SECRET.toUpperCase() },
    { ...publicConfig, nested: { ...publicConfig.nested, horizonReveal: 'redacted' } },
    { ...publicConfig, privatePayload: { entropy: 'masked' } },
  ])('Given a normalized private value or nested private alias, when sealing, then it rejects', (gameConfig) => {
    expect(() =>
      createTournamentCommitment({
        context,
        gameId: 'game\u001f42/β',
        gameType: 'tragedy-of-the-commons/v2',
        playerIds: ['alice\u001e', 'ボブ', 'carol\u001f|'],
        gameConfig,
      }),
    ).toThrow();
  });

  it('Given an ordinary public game seed, when sealing, then it remains valid', () => {
    expect(() =>
      createTournamentCommitment({
        context,
        gameId: 'game\u001f42/β',
        gameType: 'tragedy-of-the-commons/v2',
        playerIds: ['alice\u001e', 'ボブ', 'carol\u001f|'],
        gameConfig: { ...publicConfig, seed: 'public-game-seed' },
      }),
    ).not.toThrow();
  });

  it('Given coordinated config-hash aliases, when the exact config bytes remain original, then verification fails', () => {
    const record = createRecord();
    const replacement = computeTournamentConfigHash({
      tournamentRootSeed: record.tournamentRootSeed,
      gameSeed: record.gameSeed,
      tournamentId: record.tournamentId,
      gameId: record.gameId,
      gameIndex: record.gameIndex,
      gameType: record.gameType,
      playerIds: record.playerIds,
      policyHash: record.policyHash,
      horizonCommitment: record.commitment,
      gameConfig: { ...publicConfig, stake: 100n },
    });

    expect(
      verifyTournamentCommitment({
        ...record,
        configHash: replacement,
        t0ConfigHash: replacement,
      }),
    ).toEqual({ ok: false });
  });

  it('Given a sealed tournament entry cost, when economic context is tampered, then verification fails closed', () => {
    // Given
    const record = createTournamentCommitment({
      context,
      gameId: 'game\u001f42/β',
      gameType: 'tragedy-of-the-commons/v2',
      playerIds: ['alice\u001e', 'ボブ', 'carol\u001f|'],
      gameConfig: {
        ...publicConfig,
        tournamentEconomics: { entryCost: '12500000' },
      },
    });

    // When
    const tampered = {
      ...record,
      t0GameConfig: {
        ...publicConfig,
        tournamentEconomics: { entryCost: '12500001' },
      },
    };

    // Then
    expect(verifyTournamentCommitment(tampered)).toEqual({ ok: false });
  });

  it.each([
    { ...context.economics, baseEntryCost: 12_500_001n },
    { ...context.economics, entryCost: 12_500_001n },
    { ...context.economics, playerCount: 4 },
    { ...context.economics, basePot: 37_500_001n },
    { ...context.economics, incomingCarry: 1n },
    { ...context.economics, releasedCarry: 1n },
    { ...context.economics, carryRemainder: 1n },
    { ...context.economics, carry: 9_375_001n },
    { ...context.economics, slash: 1_875_001n },
    { ...context.economics, treasuryDelta: 11_250_001n },
  ])('Given a forged sealed economics field, when config mirrors its entry cost, then creation rejects', (economics) => {
    // Given
    const gameConfig = {
      ...publicConfig,
      tournamentEconomics: { entryCost: economics.entryCost.toString() },
    };

    // When / Then
    expect(() =>
      createTournamentCommitment({
        context: { ...context, economics },
        gameId: 'game\u001f42/β',
        gameType: 'tragedy-of-the-commons/v2',
        playerIds: ['alice\u001e', 'ボブ', 'carol\u001f|'],
        gameConfig,
      }),
    ).toThrow('economics');
  });

  it.each([
    { ...context.economics, baseEntryCost: 12_500_001n },
    { ...context.economics, entryCost: 12_500_001n },
    { ...context.economics, playerCount: 4 },
    { ...context.economics, basePot: 37_500_001n },
    { ...context.economics, incomingCarry: 1n },
    { ...context.economics, releasedCarry: 1n },
    { ...context.economics, carryRemainder: 1n },
    { ...context.economics, carry: 9_375_001n },
    { ...context.economics, slash: 1_875_001n },
    { ...context.economics, treasuryDelta: 11_250_001n },
  ])('Given a forged persisted economics field, when verifying, then it fails closed', (economics) => {
    // Given / When
    const record = createRecord();

    // Then
    expect(verifyTournamentCommitment({ ...record, economics })).toEqual({ ok: false });
  });
});
