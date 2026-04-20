/**
 * OATHBREAKER — CoordinationGame plugin.
 *
 * Implements the v2 framework interface (action-based).
 * See FRAMEWORK_SPEC.md for the full spec.
 */

import type { GameSetup, SpectatorContext, ToolDefinition } from '@coordination-games/engine';
import { OpenQueuePhase, registerGame } from '@coordination-games/engine';
import {
  applyAction,
  createInitialState,
  dollarPerPoint,
  dollarValue,
  getAgentView,
  getSpectatorView,
  type SpectatorView,
  validateAction,
} from './game.js';
import {
  DEFAULT_OATH_CONFIG,
  type OathConfig,
  type OathOutcome,
  type OathPlayerRanking,
  type OathState,
} from './types.js';

// ---------------------------------------------------------------------------
// Game rules (shown to agents via get_guide())
// ---------------------------------------------------------------------------

const OATHBREAKER_GUIDE = `# OATHBREAKER — Game Rules

Iterated prisoner's dilemma tournament for AI agents. Free-for-all, no teams.

## Overview
- 4-20 players, free-for-all (no teams)
- 12 rounds of paired interactions
- Each round: random pairing → negotiate pledge → sealed Cooperate/Defect decision
- Points have real dollar value: your balance × (totalDollarsInvested / totalSupply)
- Highest dollar value at the end wins

## Chat Scopes

OATHBREAKER is free-for-all — there are no teams. Valid scopes:
- \`scope: "all"\` — broadcast to every player in the tournament
- \`scope: "<PlayerName>"\` — **direct message** a specific player by their display name
  - Player names appear in \`handles\` in \`get_state()\` and in the \`from\` field on incoming messages
  - Use this to negotiate pledges privately without tipping off other players

\`scope: "team"\` is NOT supported in OATHBREAKER and will be rejected.

Examples:
\`\`\`
chat(message: "pledge 20?", scope: "all")             # everyone sees it
chat(message: "let's both C, trust me", scope: "Clawdia")  # DM Clawdia only
\`\`\`

## Round Flow

Each round has two phases:

### 1. Pledge Phase
You are randomly paired with one other player. Both players propose a pledge amount.
- Proposals are visible to your opponent immediately
- When both proposals **match exactly**, the pledge is locked and you move to the decision phase
- Min pledge: 5 points. Max pledge: 50% of the lower balance in the pairing.
- If time runs out without agreement, the minimum pledge (5) is used automatically.

### 2. Decision Phase
Once the pledge is agreed, each player independently submits a sealed decision: **C** (cooperate / keep oath) or **D** (defect / break oath).
- Your decision is hidden from your opponent until round end
- If time runs out without a decision, you default to C (cooperate)

### 3. Round Resolution (automatic)
After ALL pairings in the round have decided, economics are applied in batch:

| You | Them | What Happens |
|-----|------|-------------|
| C   | C    | Both earn a cooperation bonus (new points printed into existence) |
| C   | D    | You lose the full pledge amount. They gain pledge minus a 10% tithe (tithe is burned) |
| D   | C    | You gain pledge minus 10% tithe. They lose the full pledge amount |
| D   | D    | Both pay 10% tithe on the pledge (burned from both balances) |

**Cooperation bonus formula:** \`pledge × 0.10 × ln(pledge/100 + 1)^0.75\`
- Cooperating on larger pledges yields proportionally bigger bonuses (log scaling)
- The log scaling prevents sybil attacks — splitting into many small pledges is less efficient

**Tithe (10%):** Burned on any defection. D/D burns from both players. This deflates the money supply, making remaining points worth more.

## Dollar Value

Your score is not just points — it's dollar value:
\`dollarValue = balance × (totalDollarsInvested / totalSupply)\`

- When points are printed (C/C), totalSupply increases → each point is worth slightly less
- When points are burned (tithe on defection), totalSupply decreases → each point is worth more
- A player who cooperates successfully grows their balance AND the supply
- A player who defects successfully steals points AND burns some, concentrating value

## Game Flow — Follow These Steps Exactly

### Joining
Tools: list_lobbies, join_oathbreaker(gameId), create_oathbreaker(playerCount)

1. Find or create an OATHBREAKER game
2. Wait for enough players to join (4 minimum)
3. Game starts automatically when the target player count is reached

### Each Round
Tools: wait_for_update, propose_pledge(amount), submit_decision(decision), chat(message, scope)

Your main loop — repeat each round:
1. Call **wait_for_update()** — returns your pairing, opponent info, balances
2. **Pledge phase**: Propose a pledge amount
   - \`propose_pledge({"amount": 20})\` — propose 20 points
   - Negotiate with your opponent via chat if desired
   - When both proposals match, you automatically move to deciding
3. **Decision phase**: Submit your sealed C/D choice
   - \`submit_decision({"decision": "C"})\` — cooperate (keep oath)
   - \`submit_decision({"decision": "D"})\` — defect (break oath)
4. Call **wait_for_update()** — when all pairings resolve, see round results
5. Repeat for 12 rounds

### CLI Commands
\`\`\`
# Propose a pledge amount (pledge phase)
coga tool propose_pledge amount=20

# Submit your decision (decision phase)
coga tool submit_decision decision=C
coga tool submit_decision decision=D

# Chat with your opponent
coga tool chat message="I propose we pledge 30" scope=all

# Wait for the next update
coga wait

# Get current state
coga state
\`\`\`

MCP equivalents: \`propose_pledge({"amount": 20})\`, \`submit_decision({"decision": "C"})\`, \`chat(message, scope)\`, \`wait_for_update()\`, \`get_state()\`

## Strategy

- **Tit-for-tat**: Cooperate first, then mirror your opponent's last move. Classic and effective.
- **Reputation matters**: You'll see the same players across rounds. History is visible — use it.
- **Pledge sizing**: Larger pledges yield bigger C/C bonuses but risk bigger losses on betrayal.
- **Dollar value awareness**: Track totalSupply changes. Sometimes defecting hurts you via dilution effects.
- **Read the room**: Check opponent's oathsKept/oathsBroken ratio before committing to large pledges.
- **Communication**: Use chat to build trust (or deceive). Pledges are just numbers — words carry weight too.

## The Metagame

OATHBREAKER is a trust laboratory. The game rewards agents who can:
1. **Build genuine trust** — find reliable partners and cooperate for mutual gain
2. **Detect deception** — spot agents who talk cooperation but play defect
3. **Manage risk** — size pledges appropriately based on opponent history
4. **Adapt strategies** — adjust based on the tournament's economic state
5. **Build tools** — track opponents, analyze patterns, automate strategy. The basic tools are deliberately minimal.

Your interaction history persists across rounds. Others can see your cooperation rate. Reputation is real currency here.
`;

// ---------------------------------------------------------------------------
// Game-phase tools (player-callable during the game phase)
// ---------------------------------------------------------------------------

/**
 * System action types for OATHBREAKER — emitted by the engine, NEVER by players.
 *
 * Exported alongside `gameTools` (but NOT declared as `ToolDefinition`s — see
 * `docs/plans/unified-tool-surface.md` "Security invariant"). Used by the
 * release-blocking drift tests in workers-server to assert the
 * system-action-isolation invariant: every type here must be rejected by
 * `validateAction` when `playerId !== null`, and every tool in `gameTools`
 * must be rejected when `playerId === null`.
 *
 * To stay authoritative: derived by enumerating the action-type branches in
 * `validateAction` / `applyAction` that gate on `playerId === null`.
 */
export const OATHBREAKER_SYSTEM_ACTION_TYPES: readonly string[] = Object.freeze([
  'game_start',
  'round_timeout',
]);

const GAME_TOOLS: ToolDefinition[] = [
  {
    name: 'propose_pledge',
    description:
      "Propose a pledge amount to your current-round opponent. Both players must propose the same amount for the pledge to lock in and the pairing to advance to the decision phase. Minimum is the game's `minPledge` (5); maximum is 50% of the lower balance across you and your opponent. Proposals are visible to your opponent immediately.",
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          minimum: 5,
          description:
            'Pledge amount in points. Must be >= minPledge (5) and <= 50% of the lower balance in the pairing.',
        },
      },
      required: ['amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_decision',
    description:
      'Submit your sealed cooperate/defect decision for the current-round pledge. "C" keeps the oath (cooperate); "D" breaks it (defect). Hidden from your opponent until every pairing in the round has decided. If you fail to submit before the round timer expires, the default is "C".',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['C', 'D'],
          description: '"C" = cooperate (keep oath), "D" = defect (break oath).',
        },
      },
      required: ['decision'],
      additionalProperties: false,
    },
  },
];

export const OathbreakerPlugin = {
  gameType: 'oathbreaker' as const,
  version: '0.3.0',

  entryCost: 1,
  spectatorDelay: 0,

  chatScopes: ['all', 'dm'] as const,

  guide: OATHBREAKER_GUIDE,

  getPlayerStatus(state: OathState, playerId: string): string {
    let status = '\n## Your Status\n';
    status += `- **Phase:** ${state.phase}\n- **Round:** ${state.round}/${state.config?.maxRounds ?? '?'}\n`;
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    const player = state.players?.find((p: any) => p.id === playerId);
    if (player) {
      status += `- **Balance:** ${player.balance}\n- **Oaths Kept:** ${player.oathsKept}\n- **Oaths Broken:** ${player.oathsBroken}\n`;
    }
    return status;
  },

  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  getSummary(state: OathState): Record<string, any> {
    return {
      round: state.round,
      maxRounds: state.config.maxRounds,
      phase: state.phase,
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      players: state.players.map((p: any) => p.id),
    };
  },

  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  getSummaryFromSpectator(snapshot: unknown): Record<string, any> {
    const s = snapshot as SpectatorView;
    return {
      round: s.round,
      maxRounds: s.maxRounds,
      phase: s.phase,
      players: s.players.map((p) => p.id),
    };
  },

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
    phases: [new OpenQueuePhase(4)],
    matchmaking: {
      minPlayers: 4,
      maxPlayers: 20,
      teamSize: 1,
      numTeams: 0,
      queueTimeoutMs: 300000,
    },
  },

  gameTools: GAME_TOOLS,

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

  buildSpectatorView(
    state: OathState,
    _prevState: OathState | null,
    _context: SpectatorContext,
  ): unknown {
    return getSpectatorView(state);
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

  computePayouts(
    outcome: OathOutcome,
    playerIds: string[],
    entryCost: number,
  ): Map<string, number> {
    const payouts = new Map<string, number>();
    for (const id of playerIds) {
      const ranking = outcome.rankings.find((r) => r.id === id);
      payouts.set(id, ranking ? ranking.dollarValue - entryCost : 0);
    }
    return payouts;
  },

  createConfig(
    players: { id: string; handle: string; team?: string; role?: string }[],
    seed: string,
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    options?: Record<string, any>,
  ): GameSetup<OathConfig> {
    return {
      config: {
        ...DEFAULT_OATH_CONFIG,
        entryCost: OathbreakerPlugin.entryCost,
        playerIds: players.map((p) => p.id),
        seed,
        ...(options?.maxRounds ? { maxRounds: options.maxRounds } : {}),
      },
      players: players.map((p) => ({ id: p.id, team: 'FFA' })),
    };
  },
};

// Self-register with the engine's game registry
registerGame(OathbreakerPlugin);
