/**
 * OATHBREAKER — CoordinationGame plugin.
 *
 * Implements the v2 framework interface (action-based).
 * See FRAMEWORK_SPEC.md for the full spec.
 */

import type {
  OathConfig,
  OathState,
  OathAction,
  OathOutcome,
  OathPlayerRanking,
} from './types.js';

import type { CoordinationGame } from '@coordination-games/engine';

import {
  createInitialState,
  validateAction,
  applyAction,
  getAgentView,
  getSpectatorView,
  dollarPerPoint,
  dollarValue,
} from './game.js';

export const OathbreakerPlugin = {
  gameType: 'oathbreaker' as const,
  version: '0.3.0',

  entryCost: 1,
  spectatorDelay: 0,

  getPlayersNeedingAction(state: OathState): string[] {
    if (state.phase !== 'playing') return [];
    const needed: string[] = [];
    for (const pairing of state.pairings) {
      if (pairing.phase === 'decided') continue;
      if (pairing.phase === 'pledging') {
        if (pairing.proposal1 === null) needed.push(pairing.player1);
        if (pairing.proposal2 === null) needed.push(pairing.player2);
      } else if (pairing.phase === 'deciding') {
        if (pairing.decision1 === null) needed.push(pairing.player1);
        if (pairing.decision2 === null) needed.push(pairing.player2);
      }
    }
    return needed;
  },

  lobby: {
    queueType: 'open' as const,
    phases: [],
    matchmaking: {
      minPlayers: 4,
      maxPlayers: 20,
      teamSize: 1,
      numTeams: 0,
      queueTimeoutMs: 300000,
    },
  },

  requiredPlugins: ['basic-chat'],
  recommendedPlugins: ['elo', 'trust-graph'],

  // --- v2 interface ---

  createInitialState,
  validateAction,
  applyAction,

  getVisibleState(state: OathState, playerId: string | null): unknown {
    if (playerId === null) return getSpectatorView(state);
    return getAgentView(state, playerId) ?? getSpectatorView(state);
  },

  isOver(state: OathState): boolean {
    return state.phase === 'finished';
  },

  getOutcome(state: OathState): OathOutcome {
    const { players, totalPrinted, totalBurned, totalSupply } = state;
    const dpp = dollarPerPoint(state.totalDollarsInvested, totalSupply);

    const rankings: OathPlayerRanking[] = players
      .map((p) => {
        const total = p.oathsKept + p.oathsBroken;
        return {
          id: p.id,
          finalBalance: p.balance,
          dollarValue: dollarValue(p.balance, state.totalDollarsInvested, totalSupply),
          oathsKept: p.oathsKept,
          oathsBroken: p.oathsBroken,
          cooperationRate: total > 0 ? p.oathsKept / total : 1,
        };
      })
      .sort((a, b) => b.dollarValue - a.dollarValue);

    return {
      rankings,
      dollarPerPoint: dpp,
      roundsPlayed: state.round,
      totalPrinted,
      totalBurned,
      finalSupply: totalSupply,
    };
  },

  computePayouts(outcome: OathOutcome, playerIds: string[]): Map<string, number> {
    const payouts = new Map<string, number>();
    for (const id of playerIds) {
      const ranking = outcome.rankings.find((r) => r.id === id);
      payouts.set(id, ranking ? ranking.dollarValue - 1 : 0);
    }
    return payouts;
  },
};

