import type { CoordinationGame, GameSetup, SpectatorContext, ToolDefinition } from '@coordination-games/engine';
import { OpenQueuePhase, registerGame } from '@coordination-games/engine';
import {
  DEFAULT_COMEDY_CONFIG,
  type ComedyAction,
  type ComedyConfig,
  type ComedyOutcome,
  type ComedyState,
} from './types.js';
import {
  applyAction,
  createInitialState,
  getOutcome,
  getPlayerView,
  getSpectatorView,
  validateAction,
} from './game.js';

const COMEDY_GUIDE = `# Comedy of the Commons — v0 Rules

Comedy of the Commons is a free-for-all coordination game about shared scarcity.

## Core loop
- Each round begins with resource production from the regions you control.
- You may submit one action per round.
- Commons ecosystems can be extracted for short-term gain, but overuse degrades them.
- You can expand by building settlements in unclaimed regions.
- You can offer bilateral trades; reciprocal offers in the same round settle automatically.

## Action types
- \`offer_trade\`
- \`extract_commons\`
- \`build_settlement\`
- \`pass\`

## Win condition
Highest VP wins when the round limit is reached. Influence is the tie-breaker.

## Notes
This is an intentionally reduced v0 upstream port. Richer trust, commitments, and Olympiad portability are planned for later slices.
`;

export const COMEDY_SYSTEM_ACTION_TYPES: readonly string[] = Object.freeze([
  'game_start',
  'round_timeout',
]);

const GAME_TOOLS: ToolDefinition[] = [
  {
    name: 'offer_trade',
    description: 'Offer a bilateral trade to one other player. Matching reciprocal offers in the same round settle automatically.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target player id for the trade offer.' },
        give: { type: 'object', description: 'Resources you are offering.' },
        receive: { type: 'object', description: 'Resources you want back.' },
      },
      required: ['to', 'give', 'receive'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract_commons',
    description: 'Extract a shared resource from an ecosystem you can access. Higher extraction gives more now but damages the commons faster.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        ecosystemId: { type: 'string' },
        level: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['ecosystemId', 'level'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_settlement',
    description: 'Spend resources to establish a settlement in an unclaimed region and gain VP.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        regionId: { type: 'string' },
      },
      required: ['regionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'pass',
    description: 'Submit no action for this round.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export const ComedyOfTheCommonsPlugin: CoordinationGame<ComedyConfig, ComedyState, ComedyAction, ComedyOutcome> = {
  gameType: 'comedy-of-the-commons',
  version: '0.1.0',
  entryCost: 1,
  spectatorDelay: 0,
  guide: COMEDY_GUIDE,

  lobby: {
    queueType: 'open' as const,
    phases: [new OpenQueuePhase(4)],
    matchmaking: {
      minPlayers: 4,
      maxPlayers: 6,
      teamSize: 1,
      numTeams: 0,
      queueTimeoutMs: 300000,
    },
  },

  gameTools: GAME_TOOLS,

  requiredPlugins: ['basic-chat'],
  recommendedPlugins: ['rationale'],

  createInitialState,

  validateAction,

  applyAction,

  getVisibleState(state: ComedyState, playerId: string | null): unknown {
    if (playerId === null) return getSpectatorView(state, {});
    return getPlayerView(state, playerId) ?? getSpectatorView(state, {});
  },

  buildSpectatorView(state: ComedyState, _prevState: ComedyState | null, context: SpectatorContext): unknown {
    return getSpectatorView(state, context.handles, context.relayMessages);
  },

  isOver(state: ComedyState): boolean {
    return state.phase === 'finished';
  },

  getOutcome,

  computePayouts(outcome: ComedyOutcome, playerIds: string[]): Map<string, number> {
    const payouts = new Map<string, number>();
    const topVp = outcome.rankings[0]?.vp ?? 0;
    const winners = outcome.rankings.filter((ranking) => ranking.vp === topVp);
    const winnerPayout = playerIds.length / Math.max(1, winners.length);
    for (const id of playerIds) {
      payouts.set(id, winners.some((winner) => winner.id === id) ? winnerPayout - 1 : -1);
    }
    return payouts;
  },

  getPlayerStatus(state: ComedyState, playerId: string): string {
    const player = state.players.find((item) => item.id === playerId);
    if (!player) return '\n## Your Status\n- Unknown player';
    return `\n## Your Status\n- **Phase:** ${state.phase}\n- **Round:** ${state.round}/${state.config.maxRounds}\n- **VP:** ${player.vp}\n- **Influence:** ${player.influence}\n- **Controlled Regions:** ${player.regionsControlled.length}`;
  },

  getSummary(state: ComedyState): Record<string, any> {
    return {
      round: state.round,
      maxRounds: state.config.maxRounds,
      phase: state.phase,
      players: state.players.map((player) => player.id),
      flourishingEcosystems: state.ecosystems.filter((ecosystem) => ecosystem.health >= ecosystem.flourishThreshold).length,
    };
  },

  getPlayersNeedingAction(state: ComedyState): string[] {
    if (state.phase !== 'playing') return [];
    return state.players
      .filter((player) => state.submittedActions[player.id] === null)
      .map((player) => player.id);
  },

  createConfig(
    players: { id: string; handle: string; team?: string; role?: string }[],
    seed: string,
    options?: Record<string, any>,
  ): GameSetup<ComedyConfig> {
    return {
      config: {
        ...DEFAULT_COMEDY_CONFIG,
        playerIds: players.map((player) => player.id),
        seed,
        ...(options?.maxRounds ? { maxRounds: options.maxRounds } : {}),
      },
      players: players.map((player) => ({ id: player.id, team: 'FFA' })),
    };
  },
};

registerGame(ComedyOfTheCommonsPlugin);
