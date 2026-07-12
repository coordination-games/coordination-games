import { canonicalizeJson, keccak256CanonicalJson } from '@coordination-games/engine';
import { applyAction, createInitialState, validateAction } from './game.js';
import { getGeniusOutcome, replayGeniusGame } from './replay.js';
import {
  GENIUS_COLORS,
  type GeniusBot,
  type GeniusBotFixture,
  type GeniusVisibleState,
} from './types.js';
import { buildGeniusVisibleState } from './views.js';

export class GeniusBotError extends Error {
  readonly name = 'GeniusBotError';
}

function expectedColor(view: GeniusVisibleState, playerId: string) {
  if (view.phase !== 'playing' || view.currentPlayerId !== playerId) {
    throw new GeniusBotError(`player ${playerId} does not currently act`);
  }
  const color = view.sequence[view.inputIndex];
  if (color === undefined) throw new GeniusBotError('visible sequence has no current color');
  return color;
}

export function createPerfectGeniusBot(playerId: string): GeniusBot {
  return {
    playerId,
    chooseAction(view) {
      return { type: 'press_color', color: expectedColor(view, playerId) };
    },
  };
}

export function createOneTimeMistakeGeniusBot(
  playerId: string,
  mistakeRound: number,
  mistakeInputIndex = 0,
): GeniusBot {
  return {
    playerId,
    chooseAction(view) {
      const expected = expectedColor(view, playerId);
      if (view.round !== mistakeRound || view.inputIndex !== mistakeInputIndex) {
        return { type: 'press_color', color: expected };
      }
      const index = GENIUS_COLORS.indexOf(expected);
      const color = GENIUS_COLORS[(index + 1) % GENIUS_COLORS.length];
      if (color === undefined) throw new GeniusBotError('fixture palette is empty');
      return { type: 'press_color', color };
    },
  };
}

export function runGeniusBotFixture(): GeniusBotFixture {
  const config = {
    playerIds: ['perfect-alpha', 'fallible', 'perfect-beta'],
    seed: 'genius-three-bot-fixture-v1',
    maxRounds: 4,
  } as const;
  const bots: readonly GeniusBot[] = [
    createPerfectGeniusBot('perfect-alpha'),
    createOneTimeMistakeGeniusBot('fallible', 2),
    createPerfectGeniusBot('perfect-beta'),
  ];
  let state = createInitialState(config);
  const actions = [];
  while (state.phase === 'playing') {
    if (actions.length >= 1_000) throw new GeniusBotError('fixture exceeded its action bound');
    const playerId = state.currentPlayerId;
    if (playerId === null) throw new GeniusBotError('playing state has no current player');
    const bot = bots.find((candidate) => candidate.playerId === playerId);
    if (bot === undefined) throw new GeniusBotError(`missing bot for ${playerId}`);
    const action = bot.chooseAction(buildGeniusVisibleState(state));
    if (!validateAction(state, playerId, action)) {
      throw new GeniusBotError(`bot ${playerId} produced an invalid action`);
    }
    actions.push({ playerId, action });
    state = applyAction(state, playerId, action).state;
  }
  const outcome = getGeniusOutcome(state);
  const replay = replayGeniusGame(config, actions);
  if (canonicalizeJson(replay.state) !== canonicalizeJson(state)) {
    throw new GeniusBotError('fixture replay state differs from the live run');
  }
  if (canonicalizeJson(replay.outcome) !== canonicalizeJson(outcome)) {
    throw new GeniusBotError('fixture replay outcome differs from the live run');
  }
  const transcript = replay.transcript;
  const publicHash = keccak256CanonicalJson({ config, actions, outcome, transcript });
  return { config, actions, state, outcome, transcript, replay, publicHash };
}
