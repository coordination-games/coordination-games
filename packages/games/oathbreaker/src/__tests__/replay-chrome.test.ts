/**
 * OATHBREAKER `getReplayChrome` + `getSummaryFromSpectator` ⊆ `getSummary`
 * invariant — Phase 4.7.
 *
 * Guards the historical bug where the generic `ReplayPage` always rendered
 * "Draw!" because the OATH spectator snapshot had no `winner` field and
 * the page consumed `turnState.winner` directly. With per-plugin chrome
 * the actual winner (highest dollar value) is reported back as data.
 */

import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createInitialState,
  DEFAULT_OATH_CONFIG,
  getSpectatorView,
  OathbreakerPlugin,
  type OathState,
} from '../index.js';

// ---------------------------------------------------------------------------
// State builders
// ---------------------------------------------------------------------------

function freshState(playerIds: string[]): OathState {
  return createInitialState({
    ...DEFAULT_OATH_CONFIG,
    maxRounds: 1,
    playerIds,
  });
}

/**
 * Drive the game to a terminal `phase: 'finished'` snapshot with a known
 * winner. Two players, one round; player A defects, player B cooperates →
 * A keeps higher balance (steals B's pledge minus tithe) → A wins.
 */
function finishedAWins(): OathState {
  let state = freshState(['playerA', 'playerB']);
  // Game start
  ({ state } = applyAction(state, null, { type: 'game_start' }));
  // Identify the pairing (only one)
  const pairing = state.pairings[0];
  if (!pairing) throw new Error('expected one pairing after game_start');
  const { player1, player2 } = pairing;

  // Both propose 10 → matches → deciding
  ({ state } = applyAction(state, player1, { type: 'propose_pledge', amount: 10 }));
  ({ state } = applyAction(state, player2, { type: 'propose_pledge', amount: 10 }));

  // playerA defects, playerB cooperates. To make 'A wins' deterministic:
  // whoever IS 'playerA' defects, the other cooperates.
  const aIsPlayer1 = player1 === 'playerA';
  const aMove = 'D';
  const bMove = 'C';
  ({ state } = applyAction(state, player1, {
    type: 'submit_decision',
    decision: aIsPlayer1 ? aMove : bMove,
  }));
  ({ state } = applyAction(state, player2, {
    type: 'submit_decision',
    decision: aIsPlayer1 ? bMove : aMove,
  }));

  return state;
}

function finishedDraw(): OathState {
  // Two players who both cooperate every round end with identical balances
  // → tie at the top → draw.
  let state = freshState(['playerA', 'playerB']);
  ({ state } = applyAction(state, null, { type: 'game_start' }));
  const pairing = state.pairings[0];
  if (!pairing) throw new Error('expected one pairing after game_start');
  ({ state } = applyAction(state, pairing.player1, { type: 'propose_pledge', amount: 10 }));
  ({ state } = applyAction(state, pairing.player2, { type: 'propose_pledge', amount: 10 }));
  ({ state } = applyAction(state, pairing.player1, { type: 'submit_decision', decision: 'C' }));
  ({ state } = applyAction(state, pairing.player2, { type: 'submit_decision', decision: 'C' }));
  return state;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OathbreakerPlugin.getReplayChrome', () => {
  it('returns in_progress for an unfinished snapshot', () => {
    const state = freshState(['p1', 'p2']);
    const snap = getSpectatorView(state);
    const chrome = OathbreakerPlugin.getReplayChrome(snap);
    expect(chrome.isFinished).toBe(false);
    expect(chrome.statusVariant).toBe('in_progress');
    expect(chrome.winnerLabel).toBeUndefined();
  });

  it('returns isFinished + winnerLabel for the actual top-balance player', () => {
    const state = finishedAWins();
    expect(state.phase).toBe('finished');
    const snap = getSpectatorView(state);
    const chrome = OathbreakerPlugin.getReplayChrome(snap);
    expect(chrome.isFinished).toBe(true);
    expect(chrome.statusVariant).toBe('win');
    // playerA defected against a cooperator → larger balance → winner.
    expect(chrome.winnerLabel).toBe('playerA');
  });

  it('returns draw with no winnerLabel when top balances tie', () => {
    const state = finishedDraw();
    expect(state.phase).toBe('finished');
    const snap = getSpectatorView(state);
    const chrome = OathbreakerPlugin.getReplayChrome(snap);
    expect(chrome.isFinished).toBe(true);
    expect(chrome.statusVariant).toBe('draw');
    expect(chrome.winnerLabel).toBeUndefined();
  });
});

describe('OathbreakerPlugin.getSummaryFromSpectator ⊆ getSummary', () => {
  it('every key produced from the spectator view appears in the full summary with the same value', () => {
    const state = finishedAWins();
    const fullSummary = OathbreakerPlugin.getSummary(state);
    const spectatorSummary = OathbreakerPlugin.getSummaryFromSpectator(getSpectatorView(state));
    for (const [key, value] of Object.entries(spectatorSummary)) {
      expect(fullSummary).toHaveProperty(key);
      expect(fullSummary[key]).toEqual(value);
    }
  });
});
