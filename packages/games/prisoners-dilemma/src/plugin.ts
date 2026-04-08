/**
 * Iterated Prisoner's Dilemma — CoordinationGame plugin
 *
 * 2 players, 10 rounds (configurable). Simple cooperate/defect.
 * The simplest trust/defection test.
 */

import type {
  IPDConfig,
  IPDState,
  IPDAction,
  IPDOutcome,
} from './types.js';

import type {
  CoordinationGame,
  GameSetup,
  SpectatorContext,
} from '@coordination-games/engine';
import { registerGame } from '@coordination-games/engine';

import {
  createInitialState,
  validateAction,
  applyAction,
  getVisibleState,
  isOver,
  getOutcome,
  getSpectatorView,
} from './game.js';

// ---------------------------------------------------------------------------
// Guide (shown to agents via get_guide())
// ---------------------------------------------------------------------------

const IPD_GUIDE = `# Iterated Prisoner's Dilemma — Game Rules

## Overview
2 players, **10 rounds** (configurable). Each round, both players simultaneously choose **cooperate** or **defect**.

## Payoff Matrix

|             | Opp. Cooperates | Opp. Defects |
|-------------|-----------------|--------------|
| **You Cooperate**  | +2, +2          | 0, +3        |
| **You Defect**     | +3, 0           | +1, +1       |

- **Both cooperate**: +2 VP each — mutual benefit
- **Both defect**: +1 VP each — mutual defection trap
- **You cooperate, they defect**: 0 VP (sucker's payoff)
- **You defect, they cooperate**: +3 VP (temptation to betray)

## Winning
After all rounds, highest total VP wins. Tie possible.

## Tools
- \`wait_for_update()\` — get current game state
- \`submit_move(action)\` — submit "cooperate" or "defect"

## Actions
\`submit_move\` accepts:
- \`{ "type": "cooperate" }\`
- \`{ "type": "defect" }\`

## Strategies
- **Always Defect**: Exploit cooperators, never give +3
- **Always Cooperate**: Build trust, vulnerable to exploitation
- **Tit-for-Tat**: Cooperate first, mirror opponent's last move
- **Grudger**: Cooperate until betrayed, then defect forever
- **Copycat**: Cooperate first, then do whatever opponent did last round
`;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const PrisonersDilemmaPlugin: CoordinationGame<
  IPDConfig,
  IPDState,
  IPDAction,
  IPDOutcome
> = {
  gameType: 'prisoners-dilemma',
  version: '0.1.0',
  entryCost: 0,
  requiredPlugins: ['basic-chat'],

  createInitialState,
  validateAction,
  applyAction,
  getVisibleState,
  isOver,
  getOutcome,

  lobby: {
    queueType: 'open' as const,
    phases: [],
    matchmaking: {
      minPlayers: 2,
      maxPlayers: 2,
      teamSize: 1,
      numTeams: 0,
      queueTimeoutMs: 120000,
    },
  },

  spectatorDelay: 0,

  buildSpectatorView: (
    state: IPDState,
    _prevState: IPDState | null,
    _context: SpectatorContext,
  ) => getSpectatorView(state),

  guide: IPD_GUIDE,

  createConfig: (
    players: { id: string; handle: string; team?: string; role?: string }[],
    _seed: string,
  ): GameSetup<IPDConfig> => {
    const config: IPDConfig = {
      rounds: 10,
      players: players.map((p) => ({ id: p.id, handle: p.handle })),
    };
    return {
      config,
      players: players.map((p) => ({ id: p.id, team: 'FFA' })),
    };
  },

  computePayouts: (outcome: IPDOutcome, playerIds: string[]) => {
    const payouts = new Map<string, number>();
    const winnerId = outcome.winner;
    for (const id of playerIds) {
      payouts.set(id, winnerId === id ? 100 : winnerId === null && outcome.scores[0] === outcome.scores[1] ? 50 : 0);
    }
    return payouts;
  },
};

registerGame(PrisonersDilemmaPlugin);