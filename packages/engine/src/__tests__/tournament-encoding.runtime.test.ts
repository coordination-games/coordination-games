import { describe, expect, it } from 'vitest';
import {
  type Bytes32Hex,
  computeHiddenHorizonPrfDigest,
  computeHorizonCommitment,
  computeTournamentConfigHash,
  deriveTournamentGameSeed,
  type HorizonCommitmentInput,
  parseBytes32Hex,
  type TournamentConfigHashInput,
  TournamentEncodingError,
  verifyHorizonCommitment,
} from '../tournament-encoding.js';

const ZERO = parseBytes32Hex(`0x${'00'.repeat(32)}`);
const ONE = parseBytes32Hex(`0x${'11'.repeat(32)}`);
const TWO = parseBytes32Hex(`0x${'22'.repeat(32)}`);
const HORIZON_INPUT: HorizonCommitmentInput = {
  secret: ZERO,
  gameId: 'game-runtime-boundary',
  playerEntropy: ONE,
  policyHash: TWO,
};
const COMMITMENT = computeHorizonCommitment(HORIZON_INPUT);
const CONFIG: TournamentConfigHashInput = {
  tournamentRootSeed: TWO,
  gameSeed: deriveTournamentGameSeed(TWO, 'tournament-runtime-boundary', 0),
  tournamentId: 'tournament-runtime-boundary',
  gameId: HORIZON_INPUT.gameId,
  gameIndex: 0,
  gameType: 'tragedy-of-the-commons/v2',
  playerIds: ['alpha', 'beta'],
  policyHash: HORIZON_INPUT.policyHash,
  horizonCommitment: COMMITMENT,
  gameConfig: { rounds: 2 },
};

type Bytes32BoundaryCase = {
  readonly name: string;
  readonly field: string;
  readonly run: (value: Bytes32Hex) => unknown;
};

const MALFORMED_BYTES32_VALUES = [
  '' as unknown as Bytes32Hex,
  `0x${'00'.repeat(31)}` as unknown as Bytes32Hex,
  `0x${'gg'.repeat(32)}` as unknown as Bytes32Hex,
  undefined as unknown as Bytes32Hex,
] as const;

const BYTES32_BOUNDARY_CASES = [
  {
    name: 'computeHorizonCommitment secret',
    field: 'secret',
    run: (value) => computeHorizonCommitment({ ...HORIZON_INPUT, secret: value }),
  },
  {
    name: 'computeHorizonCommitment player entropy',
    field: 'playerEntropy',
    run: (value) => computeHorizonCommitment({ ...HORIZON_INPUT, playerEntropy: value }),
  },
  {
    name: 'computeHorizonCommitment policy hash',
    field: 'policyHash',
    run: (value) => computeHorizonCommitment({ ...HORIZON_INPUT, policyHash: value }),
  },
  {
    name: 'computeHiddenHorizonPrfDigest secret',
    field: 'secret',
    run: (value) => computeHiddenHorizonPrfDigest({ ...HORIZON_INPUT, secret: value }),
  },
  {
    name: 'deriveTournamentGameSeed root seed',
    field: 'tournamentRootSeed',
    run: (value) => deriveTournamentGameSeed(value, CONFIG.tournamentId, CONFIG.gameIndex),
  },
  {
    name: 'computeTournamentConfigHash root seed',
    field: 'tournamentRootSeed',
    run: (value) => computeTournamentConfigHash({ ...CONFIG, tournamentRootSeed: value }),
  },
  {
    name: 'computeTournamentConfigHash game seed',
    field: 'gameSeed',
    run: (value) => computeTournamentConfigHash({ ...CONFIG, gameSeed: value }),
  },
  {
    name: 'computeTournamentConfigHash policy hash',
    field: 'policyHash',
    run: (value) => computeTournamentConfigHash({ ...CONFIG, policyHash: value }),
  },
  {
    name: 'computeTournamentConfigHash horizon commitment',
    field: 'horizonCommitment',
    run: (value) => computeTournamentConfigHash({ ...CONFIG, horizonCommitment: value }),
  },
  {
    name: 'verifyHorizonCommitment expected commitment',
    field: 'commitment',
    run: (value) => verifyHorizonCommitment(value, HORIZON_INPUT),
  },
] satisfies readonly Bytes32BoundaryCase[];

function expectTournamentEncodingError(field: string, run: () => unknown): void {
  try {
    run();
    expect.fail(`expected TournamentEncodingError for ${field}`);
  } catch (error) {
    if (!(error instanceof TournamentEncodingError)) throw error;
    expect(error.field).toBe(field);
  }
}

describe('runtime bytes32 boundaries', () => {
  it.each(BYTES32_BOUNDARY_CASES)('$name rejects malformed runtime values', ({ field, run }) => {
    for (const value of MALFORMED_BYTES32_VALUES) {
      expectTournamentEncodingError(field, () => run(value));
    }
  });

  it('normalizes uppercase runtime values before hashing and verification', () => {
    const uppercase = (value: Bytes32Hex): Bytes32Hex =>
      value.toUpperCase() as unknown as Bytes32Hex;
    const uppercaseHorizonInput = {
      ...HORIZON_INPUT,
      secret: uppercase(HORIZON_INPUT.secret),
      playerEntropy: uppercase(HORIZON_INPUT.playerEntropy),
      policyHash: uppercase(HORIZON_INPUT.policyHash),
    };
    expect(computeHorizonCommitment(uppercaseHorizonInput)).toBe(COMMITMENT);
    expect(computeHiddenHorizonPrfDigest(uppercaseHorizonInput)).toBe(
      computeHiddenHorizonPrfDigest(HORIZON_INPUT),
    );
    expect(deriveTournamentGameSeed(uppercase(TWO), CONFIG.tournamentId, CONFIG.gameIndex)).toBe(
      CONFIG.gameSeed,
    );
    expect(
      computeTournamentConfigHash({
        ...CONFIG,
        tournamentRootSeed: uppercase(CONFIG.tournamentRootSeed),
        gameSeed: uppercase(CONFIG.gameSeed),
        policyHash: uppercase(CONFIG.policyHash),
        horizonCommitment: uppercase(CONFIG.horizonCommitment),
      }),
    ).toBe(computeTournamentConfigHash(CONFIG));
    expect(verifyHorizonCommitment(uppercase(COMMITMENT), uppercaseHorizonInput)).toBe(true);
  });
});
