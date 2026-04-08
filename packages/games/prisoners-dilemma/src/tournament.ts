import { applyAction, createInitialState, getOutcome } from './game.js';
import type { IPDOutcome, IPDRound } from './types.js';
import { buildStrategyContext, createStrategyBot, type IPDStrategyName } from './strategies.js';

export interface MatchResult {
  a: IPDStrategyName;
  b: IPDStrategyName;
  outcome: IPDOutcome;
  history: IPDRound[];
}

export interface TournamentResult {
  matches: MatchResult[];
  totals: Record<IPDStrategyName, number>;
}

export function runMatch(a: IPDStrategyName, b: IPDStrategyName, rounds = 10): MatchResult {
  const players = [
    { id: 'p0', handle: a },
    { id: 'p1', handle: b },
  ] as const;

  let state = createInitialState({ rounds, players: [...players] });
  const botA = createStrategyBot(a);
  const botB = createStrategyBot(b);

  while (!state.finished) {
    const contextA = buildStrategyContext(state.history, 0, state.maxRounds);
    const contextB = buildStrategyContext(state.history, 1, state.maxRounds);

    const actionA = botA.decide(contextA);
    const actionB = botB.decide(contextB);

    state = applyAction(state, players[0].id, actionA).state;
    state = applyAction(state, players[1].id, actionB).state;
  }

  return {
    a,
    b,
    outcome: getOutcome(state),
    history: state.history,
  };
}

export function runRoundRobinTournament(
  strategies: IPDStrategyName[] = ['always_cooperate', 'always_defect', 'tit_for_tat', 'grudger', 'detective'],
  rounds = 10,
): TournamentResult {
  const matches: MatchResult[] = [];
  const totals = Object.fromEntries(strategies.map((name) => [name, 0])) as Record<IPDStrategyName, number>;

  for (const a of strategies) {
    for (const b of strategies) {
      const result = runMatch(a, b, rounds);
      matches.push(result);
      totals[a] += result.outcome.scores[0];
      totals[b] += result.outcome.scores[1];
    }
  }

  return { matches, totals };
}
