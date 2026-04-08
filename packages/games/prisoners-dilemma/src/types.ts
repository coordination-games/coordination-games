/**
 * Iterated Prisoner's Dilemma — Game types
 *
 * 2 players, N rounds (default 10). Each round, both players
 * simultaneously choose cooperate or defect. Payoff matrix:
 *   Both cooperate:  +2, +2
 *   Both defect:     +1, +1
 *   Cooperate/Defect: 0, +3 (defector wins)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for creating a new IPD game. */
export interface IPDConfig {
  /** Number of rounds to play. */
  rounds: number;
  /** Players in this game. */
  players: IPDPlayerConfig[];
}

/** Player config at game creation. */
export interface IPDPlayerConfig {
  id: string;
  handle: string;
}

// ---------------------------------------------------------------------------
// Game State
// ---------------------------------------------------------------------------

/** A single round result. */
export interface IPDRound {
  round: number;
  /** What player 0 did this round. */
  p0Action: IPDAction;
  /** What player 1 did this round. */
  p1Action: IPDAction;
  /** Payoff to player 0 this round. */
  p0Payoff: number;
  /** Payoff to player 1 this round. */
  p1Payoff: number;
}

/** The full IPD game state. */
export interface IPDState {
  /** Current round number (1-indexed). 0 = not started. */
  round: number;
  /** Maximum number of rounds. */
  maxRounds: number;
  /** All rounds played so far (index 0 = round 1). */
  history: IPDRound[];
  /** Running total scores. */
  scores: [number, number];
  /** Player IDs [p0, p1]. */
  playerIds: [string, string];
  /** Player handles [p0, p1]. */
  playerHandles: [string, string];
  /** Whether the game is over. */
  finished: boolean;
  /** Winner: 0 = p0, 1 = p1, null = tie/draw. */
  winner: number | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The two choices available each round. */
export type IPDAction = 'cooperate' | 'defect';

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** Game outcome when isOver() returns true. */
export interface IPDOutcome {
  winner: string | null;  // player ID or null for tie
  scores: [number, number];  // [p0, p1]
  totalRounds: number;
  history: IPDRound[];
}

// ---------------------------------------------------------------------------
// Agent view (what a player sees)
// ---------------------------------------------------------------------------

/** What player 0 sees. */
export interface IPDPlayer0View {
  you: {
    id: string;
    handle: string;
    score: number;
    history: { myAction: IPDAction; theirAction: IPDAction; myPayoff: number }[];
  };
  opponent: {
    id: string;
    handle: string;
    score: number;
  };
  round: number;
  maxRounds: number;
  finished: boolean;
}

/** What player 1 sees (mirrored view). */
export interface IPDPlayer1View {
  you: {
    id: string;
    handle: string;
    score: number;
    history: { myAction: IPDAction; theirAction: IPDAction; myPayoff: number }[];
  };
  opponent: {
    id: string;
    handle: string;
    score: number;
  };
  round: number;
  maxRounds: number;
  finished: boolean;
}

/** Spectator view. */
export interface IPDSpectatorView {
  round: number;
  maxRounds: number;
  scores: [number, number];
  playerHandles: [string, string];
  history: IPDRound[];
  finished: boolean;
  winner: string | null;
}