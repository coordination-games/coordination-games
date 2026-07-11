import {
  applyTournamentPayouts,
  computeHorizonCommitment,
  createHiddenHorizonPublicConfig,
  createSeries,
  createTournamentCommitment,
  createTournamentEconomics,
  deriveStopRound,
  deriveTournamentHorizonSecret,
  deriveTournamentRoomName,
  onGameSettled,
  parseBytes32Hex,
  revealTournamentHorizon,
  type TournamentGameConfig,
  verifyTournamentCommitment,
} from '@coordination-games/engine';
import { createV2InitialState } from './game.js';
import { sealV2HiddenHorizon } from './hidden-horizon.js';
import { TragedyOfTheCommonsV2Plugin } from './plugin.js';
import { buildPublicTournamentState, runPolicyActions } from './tournament-demo-helpers.js';
import type { TournamentDemoPolicy } from './tournament-demo-policy.js';
import { DEFAULT_V2_CONFIG } from './types.js';

const POLICY = {
  seriesLength: 2,
  baseEntryCost: 100n,
  carryBps: 2_000,
  slashBps: 500,
  minRounds: 2,
  maxRounds: 9,
  hazardNumerator: 1,
  hazardDenominator: 4,
} as const;

export type TranscriptEvent = Readonly<Record<string, unknown>>;

export type LocalTournamentInput = {
  readonly tournamentId: string;
  readonly seed: string;
  readonly playerEntropy: string;
  readonly policies: readonly TournamentDemoPolicy[];
};

type GameRun = {
  readonly gameId: string;
  readonly gameSeed: string;
  readonly entryCost: bigint;
  readonly actualRounds: number;
  readonly horizon: Readonly<{ commitment: string; verified: boolean }>;
  readonly botInputSafe: boolean;
  readonly payouts: Readonly<{
    playerTotal: bigint;
    treasuryDelta: bigint;
    everyPlayerAboveEntryFloor: boolean;
  }>;
};

export type LocalTournamentResult = Readonly<{
  readonly games: readonly GameRun[];
  readonly transcript: readonly TranscriptEvent[];
  readonly publicSpectator: Readonly<Record<string, unknown>>;
}>;

export class LocalTournamentDemoError extends Error {
  readonly name = 'LocalTournamentDemoError';

  constructor(readonly reason: string) {
    super(`Local tournament demo failed: ${reason}`);
  }
}

function assertPolicies(
  policies: readonly TournamentDemoPolicy[],
): readonly TournamentDemoPolicy[] {
  if (policies.length !== 3 || new Set(policies.map((policy) => policy.botName)).size !== 3) {
    throw new LocalTournamentDemoError('exactly three uniquely named policies are required');
  }
  if (new Set(policies.map((policy) => policy.setup.startingCamp)).size !== 3) {
    throw new LocalTournamentDemoError('policies must select three distinct starting camps');
  }
  return policies;
}

export function runLocalTournament(input: LocalTournamentInput): LocalTournamentResult {
  const policies = assertPolicies(input.policies);
  const playerIds = policies.map((policy) => policy.botName);
  const rootSeed = parseBytes32Hex(input.seed, 'seed');
  const playerEntropy = parseBytes32Hex(input.playerEntropy, 'playerEntropy');
  if (rootSeed === playerEntropy) {
    throw new LocalTournamentDemoError('seed and playerEntropy must be distinct');
  }
  const created = createSeries(
    {
      tournamentId: input.tournamentId,
      gameType: TragedyOfTheCommonsV2Plugin.gameType,
      playerIds,
      policy: POLICY,
    },
    rootSeed,
  );
  let series = created.series;
  let gameConfig: TournamentGameConfig | null = created.gameConfig;
  let finalSpectator: Readonly<Record<string, unknown>> = {};
  const games: GameRun[] = [];
  const transcript: TranscriptEvent[] = [];

  while (gameConfig !== null) {
    const currentGameIndex = gameConfig.gameIndex;
    const gameId = deriveTournamentRoomName(input.tournamentId, gameConfig.gameIndex);
    const secret = deriveTournamentHorizonSecret(
      rootSeed,
      input.tournamentId,
      gameConfig.gameIndex,
    );
    const horizonCommitment = computeHorizonCommitment({
      secret,
      gameId,
      playerEntropy,
      policyHash: gameConfig.policyHash,
    });
    const fullConfig = {
      ...DEFAULT_V2_CONFIG({
        seed: gameConfig.gameSeed,
        playerIds,
        maxRounds: POLICY.maxRounds,
        hiddenHorizon: createHiddenHorizonPublicConfig(horizonCommitment, POLICY),
      }),
      tournamentEconomics: { entryCost: gameConfig.entryCost.toString() },
    };
    const commitment = createTournamentCommitment({
      context: {
        tournamentRootSeed: rootSeed,
        gameSeed: gameConfig.gameSeed,
        tournamentId: input.tournamentId,
        gameIndex: gameConfig.gameIndex,
        policy: POLICY,
        horizonSecret: secret,
        playerEntropy,
        economics: createTournamentEconomics({
          policy: POLICY,
          playerCount: playerIds.length,
          incomingCarry: gameConfig.incomingCarry,
        }),
      },
      gameId,
      gameType: TragedyOfTheCommonsV2Plugin.gameType,
      playerIds,
      gameConfig: fullConfig,
    });
    const stopRound = deriveStopRound(secret, gameId, playerEntropy, POLICY);
    const state = sealV2HiddenHorizon(createV2InitialState(fullConfig), stopRound);
    transcript.push({
      kind: 'game_committed',
      gameId,
      gameIndex: gameConfig.gameIndex,
      commitment: commitment.commitment,
    });
    const completed = runPolicyActions(state, policies, gameId, transcript);
    const outcome = TragedyOfTheCommonsV2Plugin.getOutcome(completed.state);
    const economics = createTournamentEconomics({
      policy: POLICY,
      playerCount: playerIds.length,
      incomingCarry: gameConfig.incomingCarry,
    });
    const settledPayouts = applyTournamentPayouts(
      TragedyOfTheCommonsV2Plugin.computePayouts(outcome, playerIds, economics.entryCost),
      playerIds,
      economics,
    );
    const verification = verifyTournamentCommitment(commitment);
    const reveal = revealTournamentHorizon(commitment);
    transcript.push({
      kind: 'horizon_reveal',
      gameId,
      stopRound,
      ...reveal,
      verified: verification.ok,
    });
    transcript.push({ kind: 'outcome', gameId, outcome });
    transcript.push({
      kind: 'settlement',
      gameId,
      playerPayouts: Object.fromEntries(settledPayouts.playerPayouts),
      treasuryDelta: settledPayouts.treasuryDelta.toString(),
    });
    const playerTotal = [...settledPayouts.playerPayouts.values()].reduce(
      (total, delta) => total + delta,
      0n,
    );
    const everyPlayerAboveEntryFloor = [...settledPayouts.playerPayouts.values()].every(
      (delta) => delta >= -economics.entryCost,
    );
    games.push({
      gameId,
      gameSeed: gameConfig.gameSeed,
      entryCost: economics.entryCost,
      actualRounds: outcome.roundsPlayed,
      horizon: { commitment: commitment.commitment, verified: verification.ok },
      botInputSafe: completed.botInputSafe,
      payouts: {
        playerTotal,
        treasuryDelta: settledPayouts.treasuryDelta,
        everyPlayerAboveEntryFloor,
      },
    });
    const settled = onGameSettled(
      series,
      { gameId, gameIndex: gameConfig.gameIndex },
      settledPayouts.playerPayouts,
    );
    series = settled.series;
    gameConfig = settled.nextGameConfig;
    transcript.push({
      kind: 'carry_plan',
      gameId,
      carryPlan: settled.carryPlan,
      standings: settled.standings,
    });
    finalSpectator = buildPublicTournamentState({
      tournamentId: input.tournamentId,
      series,
      gameId,
      gameIndex: currentGameIndex,
      standings: settled.standings,
      entryCost: economics.entryCost,
      carry: economics.carry,
      slash: economics.slash,
      treasuryDelta: settledPayouts.treasuryDelta,
      receiptHash: commitment.configHash,
    });
  }
  return Object.freeze({
    games: Object.freeze(games),
    transcript: Object.freeze(transcript),
    publicSpectator: finalSpectator,
  });
}
