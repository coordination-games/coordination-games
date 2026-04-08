/**
 * Iterated Prisoner's Dilemma — Game logic tests
 */

import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  validateAction,
  applyAction,
  getVisibleState,
  isOver,
  getOutcome,
} from './src/game.js';
import {
  buildStrategyContext,
  createStrategyBot,
  runMatch,
  runRoundRobinTournament,
} from './src/index.js';
import type { IPDAction } from './src/types.js';

const PLAYERS = [
  { id: 'alice', handle: 'Alice' },
  { id: 'bob', handle: 'Bob' },
];

describe('IPD game logic', () => {
  it('creates initial state correctly', () => {
    const state = createInitialState({ rounds: 10, players: PLAYERS });
    expect(state.round).toBe(0);
    expect(state.maxRounds).toBe(10);
    expect(state.scores).toEqual([0, 0]);
    expect(state.history).toEqual([]);
    expect(state.finished).toBe(false);
    expect(state.winner).toBe(null);
  });

  it('validates cooperate and defect actions', () => {
    const state = createInitialState({ rounds: 10, players: PLAYERS });
    expect(validateAction(state, 'alice', 'cooperate')).toBe(true);
    expect(validateAction(state, 'alice', 'defect')).toBe(true);
    expect(validateAction(state, 'alice', 'invalid' as IPDAction)).toBe(false);
  });

  it('rejects actions when game is over', () => {
    const state = createInitialState({ rounds: 1, players: PLAYERS });
    // Manually finish the game
    const finished = { ...state, finished: true };
    expect(validateAction(finished, 'alice', 'cooperate')).toBe(false);
  });

  it('resolves mutual cooperation correctly', () => {
    const state = createInitialState({ rounds: 10, players: PLAYERS });
    // Alice cooperates
    const r1 = applyAction(state, 'alice', 'cooperate');
    // Bob cooperates
    const r2 = applyAction(r1.state, 'bob', 'cooperate');
    expect(r2.state.round).toBe(1);
    expect(r2.state.scores).toEqual([2, 2]);
    expect(r2.state.history.length).toBe(1);
    expect(r2.state.history[0]).toMatchObject({
      p0Action: 'cooperate',
      p1Action: 'cooperate',
      p0Payoff: 2,
      p1Payoff: 2,
    });
  });

  it('resolves mutual defection correctly', () => {
    const state = createInitialState({ rounds: 10, players: PLAYERS });
    const r1 = applyAction(state, 'alice', 'defect');
    const r2 = applyAction(r1.state, 'bob', 'defect');
    expect(r2.state.scores).toEqual([1, 1]);
    expect(r2.state.history[0]).toMatchObject({
      p0Action: 'defect',
      p1Action: 'defect',
      p0Payoff: 1,
      p1Payoff: 1,
    });
  });

  it('resolves exploitation correctly', () => {
    const state = createInitialState({ rounds: 10, players: PLAYERS });
    // Alice cooperates, Bob defects
    const r1 = applyAction(state, 'alice', 'cooperate');
    const r2 = applyAction(r1.state, 'bob', 'defect');
    expect(r2.state.scores).toEqual([0, 3]);
    // Alice defects, Bob cooperates
    const r3 = applyAction(r2.state, 'alice', 'defect');
    const r4 = applyAction(r3.state, 'bob', 'cooperate');
    expect(r4.state.scores).toEqual([3, 3]);
  });

  it('ends game after max rounds', () => {
    const state = createInitialState({ rounds: 3, players: PLAYERS });
    for (let i = 0; i < 3; i++) {
      const r1 = applyAction(state, 'alice', 'cooperate');
      const r2 = applyAction(r1.state, 'bob', 'defect');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (state as any) = r2.state;
    }
    // After 3 rounds game should be over
    const finalState = createInitialState({ rounds: 3, players: PLAYERS });
    const s1 = applyAction(finalState, 'alice', 'cooperate');
    const s2 = applyAction(s1.state, 'bob', 'defect');
    const s3 = applyAction(s2.state, 'alice', 'cooperate');
    const s4 = applyAction(s3.state, 'bob', 'defect');
    const s5 = applyAction(s4.state, 'alice', 'cooperate');
    const s6 = applyAction(s5.state, 'bob', 'defect');
    expect(s6.state.finished).toBe(true);
    expect(s6.state.winner).toBe(1); // Bob has +9 vs Alice's +3
  });

  it('gives correct spectator view', () => {
    const state = createInitialState({ rounds: 10, players: PLAYERS });
    const spectator = getVisibleState(state, null);
    expect(spectator).toMatchObject({
      round: 0,
      maxRounds: 10,
      scores: [0, 0],
      playerHandles: ['Alice', 'Bob'],
      history: [],
      finished: false,
    });
  });

  it('gives correct player views', () => {
    let state = createInitialState({ rounds: 10, players: PLAYERS });
    state = applyAction(state, 'alice', 'cooperate').state;
    state = applyAction(state, 'bob', 'defect').state;

    const alice = getVisibleState(state, 'alice') as any;
    expect(alice.you.score).toBe(0);
    expect(alice.you.history[0].myAction).toBe('cooperate');
    expect(alice.you.history[0].theirAction).toBe('defect');
    expect(alice.opponent.score).toBe(3);

    const bob = getVisibleState(state, 'bob') as any;
    expect(bob.you.score).toBe(3);
    expect(bob.you.history[0].myAction).toBe('defect');
    expect(bob.you.history[0].theirAction).toBe('cooperate');
    expect(bob.opponent.score).toBe(0);
  });

  it('detects tie correctly', () => {
    const state = createInitialState({ rounds: 2, players: PLAYERS });
    // Both cooperate twice: 4-4 tie
    let s = state;
    s = applyAction(s, 'alice', 'cooperate').state;
    s = applyAction(s, 'bob', 'cooperate').state;
    s = applyAction(s, 'alice', 'cooperate').state;
    s = applyAction(s, 'bob', 'cooperate').state;
    expect(s.finished).toBe(true);
    expect(s.winner).toBe(null);
    expect(getOutcome(s).winner).toBe(null);
  });

  it('built-in always_cooperate always cooperates', () => {
    const bot = createStrategyBot('always_cooperate');
    const context = buildStrategyContext([], 0, 10);
    expect(bot.decide(context)).toBe('cooperate');
  });

  it('built-in always_defect always defects', () => {
    const bot = createStrategyBot('always_defect');
    const context = buildStrategyContext([], 0, 10);
    expect(bot.decide(context)).toBe('defect');
  });

  it('tit_for_tat cooperates first then mirrors opponent', () => {
    const bot = createStrategyBot('tit_for_tat');
    expect(bot.decide(buildStrategyContext([], 0, 10))).toBe('cooperate');
    expect(
      bot.decide(
        buildStrategyContext([
          { round: 1, p0Action: 'cooperate', p1Action: 'defect', p0Payoff: 0, p1Payoff: 3 },
        ], 0, 10),
      ),
    ).toBe('defect');
  });

  it('grudger defects forever after first betrayal', () => {
    const bot = createStrategyBot('grudger');
    expect(bot.decide(buildStrategyContext([], 0, 10))).toBe('cooperate');
    expect(
      bot.decide(
        buildStrategyContext([
          { round: 1, p0Action: 'cooperate', p1Action: 'defect', p0Payoff: 0, p1Payoff: 3 },
        ], 0, 10),
      ),
    ).toBe('defect');
    expect(
      bot.decide(
        buildStrategyContext([
          { round: 1, p0Action: 'cooperate', p1Action: 'defect', p0Payoff: 0, p1Payoff: 3 },
          { round: 2, p0Action: 'defect', p1Action: 'cooperate', p0Payoff: 3, p1Payoff: 0 },
        ], 0, 10),
      ),
    ).toBe('defect');
  });

  it('detective probes then defects against pure cooperators', () => {
    const bot = createStrategyBot('detective');
    expect(bot.decide(buildStrategyContext([], 0, 10))).toBe('cooperate');
    expect(
      bot.decide(
        buildStrategyContext([
          { round: 1, p0Action: 'cooperate', p1Action: 'cooperate', p0Payoff: 2, p1Payoff: 2 },
        ], 0, 10),
      ),
    ).toBe('defect');
    expect(
      bot.decide(
        buildStrategyContext([
          { round: 1, p0Action: 'cooperate', p1Action: 'cooperate', p0Payoff: 2, p1Payoff: 2 },
          { round: 2, p0Action: 'defect', p1Action: 'cooperate', p0Payoff: 3, p1Payoff: 0 },
          { round: 3, p0Action: 'cooperate', p1Action: 'cooperate', p0Payoff: 2, p1Payoff: 2 },
          { round: 4, p0Action: 'cooperate', p1Action: 'cooperate', p0Payoff: 2, p1Payoff: 2 },
        ], 0, 10),
      ),
    ).toBe('defect');
  });

  it('detective switches to tit-for-tat after being betrayed', () => {
    const bot = createStrategyBot('detective');
    expect(
      bot.decide(
        buildStrategyContext([
          { round: 1, p0Action: 'cooperate', p1Action: 'cooperate', p0Payoff: 2, p1Payoff: 2 },
          { round: 2, p0Action: 'defect', p1Action: 'defect', p0Payoff: 1, p1Payoff: 1 },
          { round: 3, p0Action: 'cooperate', p1Action: 'cooperate', p0Payoff: 2, p1Payoff: 2 },
          { round: 4, p0Action: 'cooperate', p1Action: 'defect', p0Payoff: 0, p1Payoff: 3 },
        ], 0, 10),
      ),
    ).toBe('defect');
  });

  it('runMatch returns deterministic outcomes', () => {
    const result = runMatch('always_defect', 'always_cooperate', 10);
    expect(result.outcome.scores).toEqual([30, 0]);
    expect(result.outcome.winner).toBe('p0');
  });

  it('round robin tournament aggregates totals', () => {
    const tournament = runRoundRobinTournament(['always_cooperate', 'always_defect'], 2);
    expect(tournament.matches).toHaveLength(4);
    expect(tournament.totals.always_defect).toBeGreaterThan(tournament.totals.always_cooperate);
  });
});
