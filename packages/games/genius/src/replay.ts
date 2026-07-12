import { applyAction, createInitialState, validateAction } from './game.js';
import { rankGeniusPlayers } from './ranking.js';
import type {
  GeniusConfigInput,
  GeniusOutcome,
  GeniusRecordedAction,
  GeniusReplay,
  GeniusState,
  GeniusTranscriptEntry,
} from './types.js';

export class GeniusReplayError extends Error {
  readonly name = 'GeniusReplayError';

  constructor(
    readonly actionIndex: number,
    readonly reason: string,
  ) {
    super(`Invalid Genius replay action ${actionIndex}: ${reason}`);
  }
}

export function getGeniusOutcome(state: GeniusState): GeniusOutcome {
  return {
    winnerIds: [...state.winnerIds],
    roundsPlayed: state.round,
    rankings: rankGeniusPlayers(
      state.players,
      state.players.map((player) => player.id),
    ),
  };
}

export function replayGeniusGame(
  config: GeniusConfigInput,
  actions: readonly {
    readonly playerId: string | null;
    readonly action: unknown;
  }[],
): GeniusReplay {
  let state = createInitialState(config);
  const transcript: GeniusTranscriptEntry[] = [];
  actions.forEach((record, index) => {
    if (!validateAction(state, record.playerId, record.action)) {
      throw new GeniusReplayError(index, 'action failed validation');
    }
    state = applyAction(state, record.playerId, record.action).state;
    const accepted: GeniusRecordedAction = {
      playerId: record.playerId,
      action: record.action,
    };
    transcript.push({ index, ...accepted, state });
  });
  return {
    state,
    outcome: state.phase === 'finished' ? getGeniusOutcome(state) : null,
    transcript,
  };
}
