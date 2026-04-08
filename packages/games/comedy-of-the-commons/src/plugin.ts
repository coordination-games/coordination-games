/**
 * Comedy of the Commons — CoordinationGame plugin
 *
 * Minimal first slice:
 * - 4 players, FFA, fixed 19-hex world map, 3 ecosystems
 * - Production wheel, building/trading, ecosystem extraction
 * - First to 10 VP or max 20 turns wins
 */

import type {
  ComedyAction,
  ComedyConfig,
  ComedyOutcome,
  ComedyState,
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

const COMEDY_GUIDE = `# Comedy of the Commons — Game Rules

## Overview
Free-for-all, 4 players, 20 turns maximum. First to **10 Victory Points (VP)** wins.

## World
- 19 hexes: plains, forest, mountain, ocean, commons
- 3 ecosystems, each with health (80 at start)
- Resources: grain, timber, ore, fish, energy

## Turn Flow
Each turn has 4 phases:

### 1. Production
Wheel spin determines which hexes produce this turn.
Hexes matching the wheel number produce resources:
- plains → grain
- forest → timber
- mountain → ore
- ocean → fish
- commons → energy + grain

### 2. Negotiation
Propose and accept resource trades with other players.
Use \`submit_trade\` to offer a trade.
Use \`accept_trade\` or \`reject_trade\` to respond.

### 3. Building
Spend resources to build structures on your hexes:
- **farm** (plains): 2 grain + 1 timber → +1 VP
- **mine** (mountain): 1 grain + 2 timber → +1 VP
- **port** (ocean): 2 grain + 2 timber → +1 VP
- **tower** (any): 3 timber + 1 ore → +2 VP

### 4. Extraction
Extract from your built structures. Higher ecosystem health = better yields.
Extraction damages the ecosystem (health -5 per use).

## Victory
First to 10 VP wins. If no one reaches 10 VP by turn 20, highest VP wins.

## Tools
- \`wait_for_update()\` — get current game state
- \`submit_move(action)\` — submit an action (see below)
- \`chat(message, scope)\` — team chat

## Actions
\`submit_move\` accepts:
- \`{ "type": "submit_trade", "offer": { "from": "...", "to": "...", "give": {...}, "want": {...} } }\`
- \`{ "type": "accept_trade", "tradeId": "..." }\`
- \`{ "type": "reject_trade", "tradeId": "..." }\`
- \`{ "type": "build", "hexQ": 0, "hexR": 0, "structure": "farm" }\`
- \`{ "type": "extract", "hexQ": 0, "hexR": 0 }\`
- \`{ "type": "pass" }\`
`;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const ComedyOfTheCommonsPlugin: CoordinationGame<
  ComedyConfig,
  ComedyState,
  ComedyAction,
  ComedyOutcome
> = {
  gameType: 'comedy-of-the-commons',
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
      minPlayers: 4,
      maxPlayers: 4,
      teamSize: 1,
      numTeams: 0,
      queueTimeoutMs: 300000,
    },
  },

  spectatorDelay: 0,

  buildSpectatorView: (
    state: ComedyState,
    _prevState: ComedyState | null,
    _context: SpectatorContext,
  ) => getSpectatorView(state),

  guide: COMEDY_GUIDE,

  createConfig: (
    players: { id: string; handle: string; team?: string; role?: string }[],
    seed: string,
  ): GameSetup<ComedyConfig> => {
    const config: ComedyConfig = {
      mapSeed: seed,
      players: players.map(p => ({ id: p.id, handle: p.handle })),
    };
    return {
      config,
      players: players.map(p => ({ id: p.id, team: 'FFA' })),
    };
  },

  computePayouts: (outcome: ComedyOutcome, playerIds: string[]) => {
    const payouts = new Map<string, number>();
    const sorted = [...outcome.vp.entries()].sort(([, a], [, b]) => b - a);
    const topScore = sorted[0]?.[1] ?? 0;
    const winners = sorted.filter(([, score]) => score === topScore).map(([id]) => id);
    for (const id of playerIds) {
      payouts.set(id, winners.includes(id) ? 100 : 0);
    }
    return payouts;
  },
};

registerGame(ComedyOfTheCommonsPlugin);
