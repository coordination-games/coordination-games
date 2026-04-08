/**
 * Iterated Prisoner's Dilemma — Entry point
 */

export { PrisonersDilemmaPlugin } from './plugin.js';
export {
  BUILT_IN_STRATEGIES,
  buildStrategyContext,
  createStrategyBot,
} from './strategies.js';
export { runMatch, runRoundRobinTournament } from './tournament.js';
export type * from './types.js';
export type {
  IPDStrategyBot,
  IPDStrategyContext,
  IPDStrategyName,
} from './strategies.js';
export type { MatchResult, TournamentResult } from './tournament.js';
