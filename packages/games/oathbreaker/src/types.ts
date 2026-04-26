/**
 * OATHBREAKER — Type definitions for the CoordinationGame plugin.
 *
 * Iterated prisoner's dilemma with symmetric pledges, log^k anti-sybil scaling,
 * and tithe-based deflation. Agents negotiate a shared pledge amount, then
 * independently choose to honor or break the oath. 12 rounds, FFA, no teams.
 *
 * Two-step turn:
 *   1. PLEDGE PHASE — agents propose amounts until both match (symmetric)
 *   2. DECISION PHASE — agents submit sealed C/D against the agreed pledge
 *   3. ROUND END — all pairings done → batch resolve economics + reveal C/D
 */

// ---------------------------------------------------------------------------
// Actions (sequential, within a turn)
// ---------------------------------------------------------------------------

/** Propose a pledge amount. Public — opponent sees it immediately. */
export interface ProposePledgeAction {
  type: 'propose_pledge';
  amount: number;
}

/** Submit your sealed cooperate/defect decision. Only valid after pledge is agreed. */
export interface SubmitDecisionAction {
  type: 'submit_decision';
  decision: 'C' | 'D';
}

/** System actions — fired by the framework, not players. */
export interface GameStartAction {
  type: 'game_start';
}

export interface RoundTimeoutAction {
  type: 'round_timeout';
}

/** Union of all actions. */
export type OathAction =
  | GameStartAction
  | ProposePledgeAction
  | SubmitDecisionAction
  | RoundTimeoutAction;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for creating an OATHBREAKER game. */
export interface OathConfig {
  /** Number of rounds in the tournament. */
  maxRounds: number;
  /** Starting point balance for each player. */
  startingPoints: number;
  /** Minimum pledge per round (absolute). */
  minPledge: number;
  /** Maximum pledge as percentage of LOWER balance in the pairing (0-100).
   *  Ensures both players can actually meet the agreed amount. */
  maxPledgePct: number;
  /** Tithe rate — percentage burned on any oath-breaking (0-100). */
  titheRate: number;
  /** Base yield rate for cooperation bonus (0-100).
   *  bonus = pledge * (yield/100) * ln(pledge/R + 1)^k */
  yieldRate: number;
  /** Anti-sybil scaling exponent. Higher = harsher sybil penalty, more whale advantage.
   *  k=0.5: mild, k=0.75: balanced, k=1: standard log, k=2: brutal */
  scalingK: number;
  /** Seconds per round for agents to negotiate and decide. */
  turnTimerSeconds: number;
  /** Random seed for deterministic pairing order. */
  seed: string;
  /** Entry cost in WHOLE credits per player — display-only. Used for
   *  per-round UI math (`breakEvenDelta`, `totalCreditsInvested`). The raw-
   *  unit value that actually drives settlement is `plugin.entryCost`
   *  (bigint); this field is divided back from it at `createConfig` time. */
  entryCost: number;
  /** Player IDs (populated when game starts from lobby). */
  playerIds: string[];
}

/** Sensible defaults — 12 rounds, balanced scaling. */
export const DEFAULT_OATH_CONFIG: OathConfig = {
  maxRounds: 12,
  startingPoints: 100,
  minPledge: 5,
  maxPledgePct: 50,
  titheRate: 10,
  yieldRate: 10,
  scalingK: 0.75,
  turnTimerSeconds: 60,
  entryCost: 1,
  seed: 'oathbreaker',
  playerIds: [],
};

// ---------------------------------------------------------------------------
// Per-pairing state (within a round, before resolution)
// ---------------------------------------------------------------------------

/**
 * Pairing lifecycle:
 *   'pledging' → proposals going back and forth
 *   'deciding' → pledge agreed, waiting for sealed C/D from both
 *   'decided'  → both C/D submitted, waiting for round-end batch resolution
 *
 * After batch resolution, pairings are cleared (not kept in a 'resolved' state).
 * Results go into roundResults[].
 */
export type PairingPhase = 'pledging' | 'deciding' | 'decided';

export interface OathPairing {
  player1: string;
  player2: string;
  phase: PairingPhase;
  /** Player 1's latest proposed pledge (null if not yet proposed). */
  proposal1: number | null;
  /** Player 2's latest proposed pledge (null if not yet proposed). */
  proposal2: number | null;
  /** The agreed pledge amount (set when proposals match). */
  agreedPledge: number | null;
  /** Player 1's sealed decision (null if not yet submitted). */
  decision1: 'C' | 'D' | null;
  /** Player 2's sealed decision (null if not yet submitted). */
  decision2: 'C' | 'D' | null;
}

// ---------------------------------------------------------------------------
// Per-player state (persistent across rounds)
// ---------------------------------------------------------------------------

export interface OathPlayerState {
  id: string;
  balance: number;
  oathsKept: number;
  oathsBroken: number;
  totalPrinted: number;
  totalStolen: number;
  tithePaid: number;
  /** Full interaction history for this player. */
  history: OathInteraction[];
}

export interface OathInteraction {
  round: number;
  opponent: string;
  myMove: 'C' | 'D';
  theirMove: 'C' | 'D';
  /** The symmetric agreed pledge amount. */
  pledge: number;
  /** Points gained or lost this interaction. */
  delta: number;
}

// ---------------------------------------------------------------------------
// Round result (for spectator feed — revealed at round end)
// ---------------------------------------------------------------------------

export interface OathPairingResult {
  player1: string;
  player2: string;
  move1: 'C' | 'D';
  move2: 'C' | 'D';
  /** The agreed symmetric pledge amount. */
  pledge: number;
  delta1: number;
  delta2: number;
  outcome: OathPairingOutcomeType;
}

export type OathPairingOutcomeType =
  | 'cooperation' // both kept oath
  | 'betrayal_1' // player1 broke oath
  | 'betrayal_2' // player2 broke oath
  | 'standoff'; // both broke oath

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export interface OathState {
  round: number;
  phase: 'waiting' | 'playing' | 'finished';
  players: OathPlayerState[];
  /** Active pairings for the current round (empty between rounds). */
  pairings: OathPairing[];
  /** Total whole credits staked (players.length * entryCost). Display-only
   *  for in-game UI — settlement uses plugin.entryCost (bigint raw) directly. */
  totalCreditsInvested: number;
  /** Total points in circulation (changes with printing/burning). */
  totalSupply: number;
  /** Points printed through cooperation (cumulative). */
  totalPrinted: number;
  /** Points burned through tithes (cumulative). */
  totalBurned: number;
  /** Results for each round. Index 0 = round 1. */
  roundResults: OathPairingResult[][];
  /** Config snapshot for reference in resolution. */
  config: OathConfig;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * BigInt money type for OATHBREAKER payouts. All settlement math (entryCost
 * pot, per-player payouts, deltas) goes through this type. Reasoning: float
 * division (the old `dollarPerPoint = totalCreditsInvested / totalSupply`)
 * tripped the GameRoomDO zero-sum invariant and is rejected by canonicalEncode
 * (Phase 3.3). The unit is "credits" (whatever the smallest indivisible unit
 * of `entryCost` is — currently 1 credit per player).
 */
export type CreditAmount = bigint;

export interface OathOutcome {
  /**
   * Final rankings, sorted in canonical settlement order:
   *   1. floored balance, descending (highest first)
   *   2. join order (joinedAt index in `state.config.playerIds`), ascending
   *   3. playerId, lexicographic ascending
   *
   * Index 0 is the "highest-rank player" who receives the pot rounding
   * remainder per `wiki/architecture/credit-economics.md`.
   */
  rankings: OathPlayerRanking[];
  /** Total rounds played. */
  roundsPlayed: number;
  /** Economy summary — floored to integers for canonicalEncode safety. */
  totalPrinted: number;
  totalBurned: number;
  finalSupply: number;
}

export interface OathPlayerRanking {
  id: string;
  /** Floored final point balance — used for pot distribution. */
  finalBalance: number;
  oathsKept: number;
  oathsBroken: number;
}
