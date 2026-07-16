import type { TournamentSeries } from '@coordination-games/engine';
import { buildV2PlayerView } from './game.js';
import { TragedyOfTheCommonsV2Plugin } from './plugin.js';
import { LocalTournamentDemoError, type TranscriptEvent } from './tournament-demo-execution.js';
import {
  evaluateTournamentDemoRound,
  evaluateTournamentDemoSetup,
  type TournamentDemoPolicy,
} from './tournament-demo-policy.js';
import type { TragedyV2Action, TragedyV2State } from './types.js';

function observe(
  transcript: TranscriptEvent[],
  state: TragedyV2State,
  playerId: string,
  gameId: string,
): boolean {
  const input = buildV2PlayerView(state, playerId);
  const safe = !/stopRound|endpoint|root|entropy|secret/i.test(JSON.stringify(input));
  if (!safe) throw new LocalTournamentDemoError(`private horizon data reached ${playerId}`);
  transcript.push({ kind: 'public_observation', gameId, playerId, input });
  return safe;
}

function applyPolicyAction(
  transcript: TranscriptEvent[],
  state: TragedyV2State,
  playerId: string,
  policy: TournamentDemoPolicy,
  gameId: string,
  action: TragedyV2Action,
): TragedyV2State {
  transcript.push({
    kind: 'bot_decision',
    gameId,
    playerId,
    policy: policy.botName,
    policySha256: policy.sha256,
    sourcePath: policy.sourcePath,
    round: state.round,
    action,
  });
  if (!TragedyOfTheCommonsV2Plugin.validateAction(state, playerId, action)) {
    throw new LocalTournamentDemoError(`policy ${policy.botName} chose an invalid action`);
  }
  const result = TragedyOfTheCommonsV2Plugin.applyAction(state, playerId, action);
  transcript.push({ kind: 'action_result', gameId, playerId, action, phase: result.state.phase });
  return result.state;
}

export function runPolicyActions(
  initial: TragedyV2State,
  policies: readonly TournamentDemoPolicy[],
  gameId: string,
  transcript: TranscriptEvent[],
): Readonly<{ state: TragedyV2State; botInputSafe: boolean }> {
  let state = initial;
  let botInputSafe = true;
  while (state.phase !== 'finished') {
    const current = state.players[state.currentPlayerIndex];
    if (current === undefined) throw new LocalTournamentDemoError('missing current player');
    const policy = policies.find((candidate) => candidate.botName === current.id);
    if (policy === undefined)
      throw new LocalTournamentDemoError(`missing policy for ${current.id}`);
    botInputSafe = observe(transcript, state, current.id, gameId) && botInputSafe;
    const action =
      state.phase === 'waiting'
        ? evaluateTournamentDemoSetup(policy)
        : evaluateTournamentDemoRound(policy);
    state = applyPolicyAction(transcript, state, current.id, policy, gameId, action);
  }
  return { state, botInputSafe };
}

export function buildPublicTournamentState(input: {
  readonly tournamentId: string;
  readonly series: TournamentSeries;
  readonly gameId: string;
  readonly gameIndex: number;
  readonly standings: readonly {
    readonly playerId: string;
    readonly cumulativeDelta: bigint;
    readonly gamesPlayed: number;
  }[];
  readonly entryCost: bigint;
  readonly carry: bigint;
  readonly slash: bigint;
  readonly treasuryDelta: bigint;
  readonly receiptHash: string;
}): Readonly<Record<string, unknown>> {
  return {
    tournamentId: input.tournamentId,
    gameType: TragedyOfTheCommonsV2Plugin.gameType,
    status: 'completed',
    currentGameId: null,
    currentGameIndex: input.gameIndex,
    gameIds: [...input.series.settledGameIds],
    activePlayerIds: [...input.series.activePlayerIds],
    eliminatedPlayerIds: input.series.playerIds.filter(
      (id) => !input.series.activePlayerIds.includes(id),
    ),
    standings: input.standings.map((standing) => ({
      playerId: standing.playerId,
      cumulativeDelta: standing.cumulativeDelta.toString(),
      gamesPlayed: standing.gamesPlayed,
    })),
    policy: { baseEntryCost: '100', carryBps: '2000', slashBps: '500' },
    treasuryCarry: input.series.treasuryCarry.toString(),
    currentEconomics: null,
    lastSettlement: {
      gameId: input.gameId,
      gameIndex: input.gameIndex,
      txHash: `local-receipt:${input.receiptHash}`,
      blockNumber: 0,
      entryCost: input.entryCost.toString(),
      carry: input.carry.toString(),
      slash: input.slash.toString(),
      treasuryDelta: input.treasuryDelta.toString(),
    },
  };
}
