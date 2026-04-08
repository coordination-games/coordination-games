import type { IPDAction, IPDRound } from './types.js';

export type IPDStrategyName =
  | 'always_cooperate'
  | 'always_defect'
  | 'tit_for_tat'
  | 'grudger'
  | 'detective';

export interface IPDStrategyContext {
  round: number;
  maxRounds: number;
  myHistory: IPDAction[];
  opponentHistory: IPDAction[];
  rounds: IPDRound[];
}

export interface IPDStrategyBot {
  readonly name: IPDStrategyName;
  readonly description: string;
  decide(context: IPDStrategyContext): IPDAction;
}

const alwaysCooperate: IPDStrategyBot = {
  name: 'always_cooperate',
  description: 'Always cooperates, regardless of opponent behavior.',
  decide: () => 'cooperate',
};

const alwaysDefect: IPDStrategyBot = {
  name: 'always_defect',
  description: 'Always defects to maximize short-term payoff.',
  decide: () => 'defect',
};

const titForTat: IPDStrategyBot = {
  name: 'tit_for_tat',
  description: 'Cooperates first, then mirrors the opponent’s previous action.',
  decide: ({ opponentHistory }) => {
    if (opponentHistory.length === 0) return 'cooperate';
    return opponentHistory[opponentHistory.length - 1];
  },
};

const grudger: IPDStrategyBot = {
  name: 'grudger',
  description: 'Cooperates until betrayed once, then defects forever.',
  decide: ({ opponentHistory }) => {
    return opponentHistory.includes('defect') ? 'defect' : 'cooperate';
  },
};

const detective: IPDStrategyBot = {
  name: 'detective',
  description: 'Probes with C, D, C, C; if exploited, switches to tit-for-tat, otherwise defects.',
  decide: ({ round, opponentHistory }) => {
    const probeSequence: IPDAction[] = ['cooperate', 'defect', 'cooperate', 'cooperate'];
    if (round < probeSequence.length) {
      return probeSequence[round];
    }

    const opponentEverDefected = opponentHistory.includes('defect');
    if (opponentEverDefected) {
      return opponentHistory[opponentHistory.length - 1] ?? 'cooperate';
    }

    return 'defect';
  },
};

export const BUILT_IN_STRATEGIES: Record<IPDStrategyName, IPDStrategyBot> = {
  always_cooperate: alwaysCooperate,
  always_defect: alwaysDefect,
  tit_for_tat: titForTat,
  grudger,
  detective,
};

export function createStrategyBot(name: IPDStrategyName): IPDStrategyBot {
  return BUILT_IN_STRATEGIES[name];
}

export function buildStrategyContext(
  rounds: IPDRound[],
  playerIndex: 0 | 1,
  maxRounds: number,
): IPDStrategyContext {
  const myHistory = rounds.map((round) => (playerIndex === 0 ? round.p0Action : round.p1Action));
  const opponentHistory = rounds.map((round) => (playerIndex === 0 ? round.p1Action : round.p0Action));

  return {
    round: rounds.length,
    maxRounds,
    myHistory,
    opponentHistory,
    rounds,
  };
}
