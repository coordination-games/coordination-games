import { bytesToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  computeHiddenHorizonPrfDigest,
  computeHorizonCommitment,
  computeTournamentConfigHash,
  computeTournamentPolicyHash,
  deriveTournamentGameSeed,
  encodeHiddenHorizonPrfInput,
  encodeHorizonCommitmentInput,
  encodeTournamentConfig,
  encodeTournamentGameSeedInput,
  encodeTournamentPolicy,
  type HorizonCommitmentInput,
  parseBytes32Hex,
  TOURNAMENT_ENCODING_DOMAINS,
  type TournamentConfigHashInput,
  type TournamentPolicy,
} from '../index.js';

const SECRET = parseBytes32Hex(
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
);
const ROOT_SEED = parseBytes32Hex(
  '0x202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
);
const PLAYER_ENTROPY = parseBytes32Hex(
  '0x404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
);

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

const POLICY_ENCODED =
  '0x636f6f7264696e6174696f6e2e67616d65732f746f75726e616d656e742d706f6c6963792f76311e7365726965734c656e6774681f00000001331e62617365456e747279436f73741f0000000831323530303030301e63617272794270731f00000004323530301e736c6173684270731f000000033530301e6d696e526f756e64731f00000001321e6d6178526f756e64731f00000001391e68617a6172644e756d657261746f721f00000001311e68617a61726444656e6f6d696e61746f721f00000001341e';
const POLICY_HASH = parseBytes32Hex(
  '0x1af7a87c9e0d8cb0c0843dbf3e29d878e267c0a35d6cced0155a8b3841837f29',
);

const HORIZON_INPUT: HorizonCommitmentInput = {
  secret: SECRET,
  gameId: 'game\u001f42/β',
  playerEntropy: PLAYER_ENTROPY,
  policyHash: POLICY_HASH,
};
const COMMITMENT_ENCODED =
  '0x636f6f7264696e6174696f6e2e67616d65732f686f72697a6f6e2d636f6d6d69746d656e742f76311e7365637265741f00000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f1e67616d6549641f0000000a67616d651f34322fceb21e706c61796572456e74726f70791f00000020404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f1e706f6c696379486173681f000000201af7a87c9e0d8cb0c0843dbf3e29d878e267c0a35d6cced0155a8b3841837f291e';
const COMMITMENT = parseBytes32Hex(
  '0x6e3b34a0186ede98b01a04c475d0cdd99946596181c4ad68f3dca68359636178',
);
const PRF_ENCODED =
  '0x636f6f7264696e6174696f6e2e67616d65732f68696464656e2d686f72697a6f6e2d7072662f76311e7365637265741f00000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f1e67616d6549641f0000000a67616d651f34322fceb21e706c61796572456e74726f70791f00000020404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f1e706f6c696379486173681f000000201af7a87c9e0d8cb0c0843dbf3e29d878e267c0a35d6cced0155a8b3841837f291e';
const PRF_DIGEST = parseBytes32Hex(
  '0x604c2881e2b8849a841ee6d8fe3f890ae6c587f453277a00ca5b62b1bac78892',
);

const GAME_SEED_INPUT_ENCODED =
  '0x636f6f7264696e6174696f6e2e67616d65732f746f75726e616d656e742d67616d652d736565642f76311e746f75726e616d656e74526f6f74536565641f00000020202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f1e746f75726e616d656e7449641f0000000f746f75726e65791ef09f94a52fceb11e67616d65496e6465781f00000001371e';
const GAME_SEED = parseBytes32Hex(
  '0xa63f21a40fa9df01e8f117353b711f0e7b24fd46639b0e99505f601f229d992c',
);

const CONFIG_INPUT: TournamentConfigHashInput = {
  tournamentRootSeed: ROOT_SEED,
  gameSeed: GAME_SEED,
  tournamentId: 'tourney\u001e🔥/α',
  gameId: HORIZON_INPUT.gameId,
  gameIndex: 7,
  gameType: 'tragedy-of-the-commons/v2',
  playerIds: ['alice\u001e', 'ボブ', 'carol\u001f|'],
  policyHash: POLICY_HASH,
  horizonCommitment: COMMITMENT,
  gameConfig: { stake: 99n, nested: { z: 2, a: 1 }, rounds: [1, 2] },
};
const CONFIG_ENCODED =
  '0x636f6f7264696e6174696f6e2e67616d65732f746f75726e616d656e742d636f6e6669672f76311e746f75726e616d656e74526f6f74536565641f00000020202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f1e67616d65536565641f00000020a63f21a40fa9df01e8f117353b711f0e7b24fd46639b0e99505f601f229d992c1e746f75726e616d656e7449641f0000000f746f75726e65791ef09f94a52fceb11e67616d6549641f0000000a67616d651f34322fceb21e67616d65496e6465781f00000001371e67616d65547970651f00000019747261676564792d6f662d7468652d636f6d6d6f6e732f76321e706c61796572436f756e741f00000001331e706c6179657249641f00000006616c6963651e1e706c6179657249641f00000006e3839ce383961e706c6179657249641f000000076361726f6c1f7c1e706f6c696379486173681f000000201af7a87c9e0d8cb0c0843dbf3e29d878e267c0a35d6cced0155a8b3841837f291e686f72697a6f6e436f6d6d69746d656e741f000000206e3b34a0186ede98b01a04c475d0cdd99946596181c4ad68f3dca683596361781e67616d65436f6e6669671f000000417b226e6573746564223a7b2261223a312c227a223a327d2c22726f756e6473223a5b312c325d2c227374616b65223a7b225f5f626967696e74223a223939227d7d1e';
const CONFIG_HASH = parseBytes32Hex(
  '0x8198b6c30adc00bd2d83b9bbc750599722bee82a471365944467dfa23943eaae',
);

describe('tournament encoding cross-check vectors', () => {
  it('pins every ASCII v1 domain tag', () => {
    expect(TOURNAMENT_ENCODING_DOMAINS).toEqual({
      policy: 'coordination.games/tournament-policy/v1',
      horizonCommitment: 'coordination.games/horizon-commitment/v1',
      hiddenHorizonPrf: 'coordination.games/hidden-horizon-prf/v1',
      gameSeed: 'coordination.games/tournament-game-seed/v1',
      config: 'coordination.games/tournament-config/v1',
    });
  });

  it('matches independently generated policy bytes and Keccak-256', () => {
    expect(bytesToHex(encodeTournamentPolicy(POLICY))).toBe(POLICY_ENCODED);
    expect(computeTournamentPolicyHash(POLICY)).toBe(POLICY_HASH);
  });

  it('matches independently generated commitment and PRF vectors', () => {
    expect(bytesToHex(encodeHorizonCommitmentInput(HORIZON_INPUT))).toBe(COMMITMENT_ENCODED);
    expect(computeHorizonCommitment(HORIZON_INPUT)).toBe(COMMITMENT);
    expect(bytesToHex(encodeHiddenHorizonPrfInput(HORIZON_INPUT))).toBe(PRF_ENCODED);
    expect(computeHiddenHorizonPrfDigest(HORIZON_INPUT)).toBe(PRF_DIGEST);
  });

  it('matches independently generated game seed input and digest', () => {
    expect(bytesToHex(encodeTournamentGameSeedInput(ROOT_SEED, CONFIG_INPUT.tournamentId, 7))).toBe(
      GAME_SEED_INPUT_ENCODED,
    );
    expect(deriveTournamentGameSeed(ROOT_SEED, CONFIG_INPUT.tournamentId, 7)).toBe(GAME_SEED);
  });

  it('matches independently generated t0 config bytes and digest', () => {
    expect(bytesToHex(encodeTournamentConfig(CONFIG_INPUT))).toBe(CONFIG_ENCODED);
    expect(computeTournamentConfigHash(CONFIG_INPUT)).toBe(CONFIG_HASH);
  });
});
