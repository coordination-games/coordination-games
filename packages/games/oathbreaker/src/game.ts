/**
 * OATHBREAKER — Core game logic.
 *
 * Pure functions: state in, state out. No side effects.
 * Deterministic given the same inputs + seed.
 *
 * Uses the v2 framework interface: applyAction + getVisibleState.
 * All economics (balance changes, printing, burning) happen in batch
 * at round end — never mid-round. Players see stable balances while
 * negotiating and deciding.
 *
 * Spectators see oaths (agreed pledges) live but C/D decisions are
 * hidden until round-end batch resolution reveals everything at once.
 */

import type {
  OathConfig,
  OathState,
  OathAction,
  OathPlayerState,
  OathPairing,
  OathPairingResult,
  OathPairingOutcomeType,
  OathInteraction,
} from './types.js';

import type { ActionResult } from '@coordination-games/engine';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic shuffle
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str: string, round: number): number {
  let hash = 0;
  const s = `${str}:${round}`;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

function seededShuffle<T>(arr: T[], seed: string, round: number): T[] {
  const out = [...arr];
  const rng = mulberry32(hashSeed(seed, round));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cooperation bonus — log^k scaling (anti-sybil)
// ---------------------------------------------------------------------------

export function cooperationBonus(pledge: number, config: OathConfig): number {
  const R = config.startingPoints;
  const k = config.scalingK;
  const y = config.yieldRate / 100;
  return pledge * y * Math.pow(Math.log(pledge / R + 1), k);
}

// ---------------------------------------------------------------------------
// Create initial state
// ---------------------------------------------------------------------------

export function createInitialState(
  config: OathConfig,
): OathState {
  const playerIds = config.playerIds;
  const players: OathPlayerState[] = playerIds.map((id) => ({
    id,
    balance: config.startingPoints,
    oathsKept: 0,
    oathsBroken: 0,
    totalPrinted: 0,
    totalStolen: 0,
    tithePaid: 0,
    history: [],
  }));

  const totalSupply = playerIds.length * config.startingPoints;

  return {
    round: 0,
    phase: 'waiting',
    players,
    pairings: [],
    totalDollarsInvested: playerIds.length * config.entryCost,
    totalSupply,
    totalPrinted: 0,
    totalBurned: 0,
    roundResults: [],
    config,
  };
}

// ---------------------------------------------------------------------------
// Validate an action
// ---------------------------------------------------------------------------

export function validateAction(
  state: OathState,
  playerId: string | null,
  action: OathAction,
): boolean {
  // System actions
  if (action.type === 'game_start') {
    return playerId === null && state.phase === 'waiting';
  }
  if (action.type === 'round_timeout') {
    return playerId === null && state.phase === 'playing';
  }

  // Player actions require a player
  if (playerId === null) return false;

  const pairing = findPairing(state, playerId);
  if (!pairing) return false;

  const isPlayer1 = pairing.player1 === playerId;
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return false;

  if (action.type === 'propose_pledge') {
    if (pairing.phase !== 'pledging') return false;

    const opponent = state.players.find(
      (p) => p.id === (isPlayer1 ? pairing.player2 : pairing.player1),
    );
    if (!opponent) return false;

    const lowerBalance = Math.min(player.balance, opponent.balance);
    const maxPledge = lowerBalance * (state.config.maxPledgePct / 100);

    if (action.amount < state.config.minPledge) return false;
    if (action.amount > maxPledge + 0.001) return false;

    return true;
  }

  if (action.type === 'submit_decision') {
    if (pairing.phase !== 'deciding') return false;
    const existing = isPlayer1 ? pairing.decision1 : pairing.decision2;
    if (existing !== null) return false;
    if (action.decision !== 'C' && action.decision !== 'D') return false;
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Apply an action — THE CORE
// ---------------------------------------------------------------------------

export function applyAction(
  state: OathState,
  playerId: string | null,
  action: OathAction,
): ActionResult<OathState, OathAction> {
  // --- System: game start ---
  if (action.type === 'game_start') {
    const started = startRound(state);
    return {
      state: started,
      deadline: {
        seconds: state.config.turnTimerSeconds,
        action: { type: 'round_timeout' },
      },
    };
  }

  // --- System: round timeout ---
  if (action.type === 'round_timeout') {
    const withDefaults = applyTimeoutDefaults(state);
    const resolved = resolveRound(withDefaults);
    return advanceOrFinish(resolved);
  }

  // --- Player: propose pledge ---
  if (action.type === 'propose_pledge' && playerId) {
    const pairingIndex = findPairingIndex(state, playerId);
    if (pairingIndex === -1) return { state };

    const pairings = [...state.pairings];
    const pairing = { ...pairings[pairingIndex] };
    pairings[pairingIndex] = pairing;

    const isPlayer1 = pairing.player1 === playerId;
    if (isPlayer1) {
      pairing.proposal1 = action.amount;
    } else {
      pairing.proposal2 = action.amount;
    }

    // Check if proposals match → transition to deciding
    if (
      pairing.proposal1 !== null &&
      pairing.proposal2 !== null &&
      Math.abs(pairing.proposal1 - pairing.proposal2) < 0.001
    ) {
      pairing.agreedPledge = pairing.proposal1;
      pairing.phase = 'deciding';
    }

    return { state: { ...state, pairings } };
  }

  // --- Player: submit decision ---
  if (action.type === 'submit_decision' && playerId) {
    const pairingIndex = findPairingIndex(state, playerId);
    if (pairingIndex === -1) return { state };

    const pairings = [...state.pairings];
    const pairing = { ...pairings[pairingIndex] };
    pairings[pairingIndex] = pairing;

    const isPlayer1 = pairing.player1 === playerId;
    if (isPlayer1) {
      pairing.decision1 = action.decision;
    } else {
      pairing.decision2 = action.decision;
    }

    // Both decided → mark as 'decided' (NOT resolved — no economics yet)
    if (pairing.decision1 !== null && pairing.decision2 !== null) {
      pairing.phase = 'decided';
    }

    const newState = { ...state, pairings };

    // Check if ALL pairings are decided → batch resolve the round
    if (newState.pairings.every((p) => p.phase === 'decided')) {
      const resolved = resolveRound(newState);
      return advanceOrFinish(resolved);
    }

    return { state: newState };
  }

  return { state };
}

// ---------------------------------------------------------------------------
// Internal: advance to next round or finish
// ---------------------------------------------------------------------------

function advanceOrFinish(resolvedState: OathState): ActionResult<OathState, OathAction> {
  if (resolvedState.round >= resolvedState.config.maxRounds) {
    return {
      state: { ...resolvedState, phase: 'finished' },
      deadline: null,
      progressIncrement: true,
    };
  }

  // Start next round immediately
  const nextRound = startRound(resolvedState);
  return {
    state: nextRound,
    deadline: {
      seconds: resolvedState.config.turnTimerSeconds,
      action: { type: 'round_timeout' },
    },
    progressIncrement: true,
  };
}

// ---------------------------------------------------------------------------
// Internal: start a new round — create pairings
// ---------------------------------------------------------------------------

function startRound(state: OathState): OathState {
  const round = state.round + 1;
  const { config } = state;

  const active = state.players.filter((p) => p.balance >= config.minPledge);

  const shuffled = seededShuffle(active, config.seed, round);
  const pairings: OathPairing[] = [];
  for (let i = 0; i < shuffled.length - 1; i += 2) {
    pairings.push({
      player1: shuffled[i].id,
      player2: shuffled[i + 1].id,
      phase: 'pledging',
      proposal1: null,
      proposal2: null,
      agreedPledge: null,
      decision1: null,
      decision2: null,
    });
  }

  return { ...state, round, phase: 'playing', pairings };
}

// ---------------------------------------------------------------------------
// Internal: apply timeout defaults
// ---------------------------------------------------------------------------

function applyTimeoutDefaults(state: OathState): OathState {
  const pairings = state.pairings.map((p) => {
    if (p.phase === 'decided') return p;

    const pairing = { ...p };

    if (pairing.agreedPledge === null) {
      pairing.agreedPledge = state.config.minPledge;
    }

    if (pairing.decision1 === null) pairing.decision1 = 'C';
    if (pairing.decision2 === null) pairing.decision2 = 'C';
    pairing.phase = 'decided';

    return pairing;
  });

  return { ...state, pairings };
}

// ---------------------------------------------------------------------------
// Internal: batch resolve all pairings — economics happen HERE only
// ---------------------------------------------------------------------------

function resolveRound(state: OathState): OathState {
  const { config } = state;
  const titheRate = config.titheRate / 100;

  const players: OathPlayerState[] = state.players.map((p) => ({
    ...p,
    history: [...p.history],
  }));
  const playerMap = new Map(players.map((p) => [p.id, p]));

  const roundResults: OathPairingResult[] = [];
  let printed = 0;
  let burned = 0;

  for (const pairing of state.pairings) {
    if (pairing.phase !== 'decided') continue;

    const p1 = playerMap.get(pairing.player1)!;
    const p2 = playerMap.get(pairing.player2)!;
    const pledge = pairing.agreedPledge!;
    const m1 = pairing.decision1!;
    const m2 = pairing.decision2!;

    let delta1 = 0;
    let delta2 = 0;
    let outcome: OathPairingOutcomeType;

    if (m1 === 'C' && m2 === 'C') {
      const bonus = cooperationBonus(pledge, config);
      p1.balance += bonus;
      p2.balance += bonus;
      p1.totalPrinted += bonus;
      p2.totalPrinted += bonus;
      p1.oathsKept++;
      p2.oathsKept++;
      delta1 = bonus;
      delta2 = bonus;
      printed += bonus * 2;
      outcome = 'cooperation';

    } else if (m1 === 'C' && m2 === 'D') {
      const tithe = pledge * titheRate;
      p1.balance -= pledge;
      p2.balance += pledge - tithe;
      p2.totalStolen += pledge - tithe;
      p2.tithePaid += tithe;
      p1.oathsKept++;
      p2.oathsBroken++;
      delta1 = -pledge;
      delta2 = pledge - tithe;
      burned += tithe;
      outcome = 'betrayal_2';

    } else if (m1 === 'D' && m2 === 'C') {
      const tithe = pledge * titheRate;
      p2.balance -= pledge;
      p1.balance += pledge - tithe;
      p1.totalStolen += pledge - tithe;
      p1.tithePaid += tithe;
      p2.oathsKept++;
      p1.oathsBroken++;
      delta1 = pledge - tithe;
      delta2 = -pledge;
      burned += tithe;
      outcome = 'betrayal_1';

    } else {
      const tithe = pledge * titheRate;
      p1.balance -= tithe;
      p2.balance -= tithe;
      p1.tithePaid += tithe;
      p2.tithePaid += tithe;
      p1.oathsBroken++;
      p2.oathsBroken++;
      delta1 = -tithe;
      delta2 = -tithe;
      burned += tithe * 2;
      outcome = 'standoff';
    }

    p1.history.push({
      round: state.round, opponent: p2.id,
      myMove: m1, theirMove: m2, pledge, delta: delta1,
    });
    p2.history.push({
      round: state.round, opponent: p1.id,
      myMove: m2, theirMove: m1, pledge, delta: delta2,
    });

    roundResults.push({
      player1: p1.id, player2: p2.id,
      move1: m1, move2: m2, pledge,
      delta1, delta2, outcome,
    });
  }

  const totalSupply = players.reduce((s, p) => s + p.balance, 0);

  return {
    ...state,
    players,
    pairings: [], // clear after resolution
    totalSupply,
    totalPrinted: state.totalPrinted + printed,
    totalBurned: state.totalBurned + burned,
    roundResults: [...state.roundResults, roundResults],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPairing(state: OathState, playerId: string): OathPairing | undefined {
  return state.pairings.find(
    (p) => p.player1 === playerId || p.player2 === playerId,
  );
}

function findPairingIndex(state: OathState, playerId: string): number {
  return state.pairings.findIndex(
    (p) => p.player1 === playerId || p.player2 === playerId,
  );
}

// ---------------------------------------------------------------------------
// Dollar value computation
// ---------------------------------------------------------------------------

export function dollarValue(
  balance: number,
  totalDollarsInvested: number,
  totalSupply: number,
): number {
  if (totalSupply <= 0) return 0;
  return balance * (totalDollarsInvested / totalSupply);
}

export function dollarPerPoint(
  totalDollarsInvested: number,
  totalSupply: number,
): number {
  if (totalSupply <= 0) return 0;
  return totalDollarsInvested / totalSupply;
}

// ---------------------------------------------------------------------------
// Visible state — per-player (agents) and spectator views
// ---------------------------------------------------------------------------

/** What an agent sees during their turn. */
export interface AgentView {
  round: number;
  maxRounds: number;
  yourBalance: number;
  opponentId: string;
  opponentBalance: number;
  pairingPhase: 'pledging' | 'deciding' | 'decided';
  yourProposal: number | null;
  opponentProposal: number | null;
  agreedPledge: number | null;
  opponentHasDecided: boolean;
  yourDecision: 'C' | 'D' | null;
  historyWithOpponent: OathInteraction[];
  yourFullHistory: OathInteraction[];
  gameParams: OathConfig;
  totalSupply: number;
  totalDollarsInvested: number;
  dollarPerPoint: number;
  yourDollarValue: number;
}

/** What spectators see — oaths visible, C/D hidden until round end. */
export interface SpectatorView {
  round: number;
  maxRounds: number;
  phase: 'waiting' | 'playing' | 'finished';
  players: {
    id: string;
    dollarValue: number;
    breakEvenDelta: number;
    cooperationRate: number;
    oathsKept: number;
    oathsBroken: number;
  }[];
  pairings: {
    player1: string;
    player2: string;
    phase: 'pledging' | 'deciding' | 'decided';
    proposal1: number | null;
    proposal2: number | null;
    agreedPledge: number | null;
    player1HasDecided: boolean;
    player2HasDecided: boolean;
    // C/D decisions are NEVER shown here — only in roundResults after resolution
  }[];
  /** Revealed only after batch resolution. Previous rounds' full results. */
  roundResults: OathPairingResult[][];
}

export function getAgentView(state: OathState, playerId: string): AgentView | null {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return null;

  const pairing = findPairing(state, playerId);
  if (!pairing) return null;

  const isPlayer1 = pairing.player1 === playerId;
  const opponentId = isPlayer1 ? pairing.player2 : pairing.player1;
  const opponent = state.players.find((p) => p.id === opponentId);
  if (!opponent) return null;

  const dpp = dollarPerPoint(state.totalDollarsInvested, state.totalSupply);
  const historyWithOpponent = player.history.filter((h) => h.opponent === opponentId);

  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    yourBalance: player.balance,
    opponentId,
    opponentBalance: opponent.balance,
    pairingPhase: pairing.phase,
    yourProposal: isPlayer1 ? pairing.proposal1 : pairing.proposal2,
    opponentProposal: isPlayer1 ? pairing.proposal2 : pairing.proposal1,
    agreedPledge: pairing.agreedPledge,
    opponentHasDecided: isPlayer1
      ? pairing.decision2 !== null
      : pairing.decision1 !== null,
    yourDecision: isPlayer1 ? pairing.decision1 : pairing.decision2,
    historyWithOpponent,
    yourFullHistory: player.history,
    gameParams: state.config,
    totalSupply: state.totalSupply,
    totalDollarsInvested: state.totalDollarsInvested,
    dollarPerPoint: dpp,
    yourDollarValue: dollarValue(player.balance, state.totalDollarsInvested, state.totalSupply),
  };
}

export function getSpectatorView(state: OathState): SpectatorView {
  const dpp = dollarPerPoint(state.totalDollarsInvested, state.totalSupply);
  const entryCost = state.totalDollarsInvested / Math.max(state.players.length, 1);

  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    players: state.players.map((p) => {
      const dv = dollarValue(p.balance, state.totalDollarsInvested, state.totalSupply);
      const total = p.oathsKept + p.oathsBroken;
      return {
        id: p.id,
        dollarValue: dv,
        breakEvenDelta: dv - entryCost,
        cooperationRate: total > 0 ? p.oathsKept / total : 1,
        oathsKept: p.oathsKept,
        oathsBroken: p.oathsBroken,
      };
    }),
    pairings: state.pairings.map((p) => ({
      player1: p.player1,
      player2: p.player2,
      phase: p.phase,
      proposal1: p.proposal1,
      proposal2: p.proposal2,
      agreedPledge: p.agreedPledge,
      player1HasDecided: p.decision1 !== null,
      player2HasDecided: p.decision2 !== null,
      // No decision content exposed — only revealed in roundResults
    })),
    roundResults: state.roundResults,
  };
}
