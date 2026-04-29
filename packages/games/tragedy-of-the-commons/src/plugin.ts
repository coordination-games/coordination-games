import type {
  CoordinationGame,
  GamePhaseKind,
  GameSetup,
  SpectatorContext,
  ToolDefinition,
} from '@coordination-games/engine';
import { credits, OpenQueuePhase, registerGame } from '@coordination-games/engine';
import {
  applyAction,
  createInitialState,
  getOutcome,
  getPlayerView,
  getSpectatorView,
  type TragedySpectatorView,
  validateAction,
} from './game.js';
import {
  DEFAULT_TRAGEDY_CONFIG,
  type TragedyAction,
  type TragedyConfig,
  type TragedyOutcome,
  type TragedyPlayerRanking,
  type TragedyState,
} from './types.js';

const TRAGEDY_GUIDE = `# Tragedy of the Commons — v0 Rules

Tragedy of the Commons is a free-for-all coordination game about shared scarcity.

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

export const TRAGEDY_GAME_ID = 'tragedy-of-the-commons' as const;

export const TRAGEDY_SYSTEM_ACTION_TYPES: readonly string[] = Object.freeze([
  'game_start',
  'round_timeout',
]);

const RESOURCE_BUNDLE_SCHEMA = {
  type: 'object',
  properties: {
    grain: { type: 'integer', minimum: 0 },
    timber: { type: 'integer', minimum: 0 },
    ore: { type: 'integer', minimum: 0 },
    fish: { type: 'integer', minimum: 0 },
    water: { type: 'integer', minimum: 0 },
    energy: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const;

function compareRanking(left: TragedyPlayerRanking, right: TragedyPlayerRanking): number {
  if (right.vp !== left.vp) return right.vp - left.vp;
  if (right.influence !== left.influence) return right.influence - left.influence;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validateRankingIntegrity(
  rankings: readonly TragedyPlayerRanking[],
  playerIds: readonly string[],
): void {
  if (rankings.length !== playerIds.length) {
    throw new Error('Tragedy payout rankings must include every player exactly once');
  }

  const playerSet = new Set(playerIds);
  const seen = new Set<string>();
  for (const ranking of rankings) {
    if (!playerSet.has(ranking.id)) {
      throw new Error(`Tragedy payout ranking contains unknown player: ${ranking.id}`);
    }
    if (seen.has(ranking.id)) {
      throw new Error(`Tragedy payout ranking contains duplicate player: ${ranking.id}`);
    }
    if (!Number.isSafeInteger(ranking.vp) || !Number.isSafeInteger(ranking.influence)) {
      throw new Error(
        `Tragedy payout ranking contains non-integer score for player: ${ranking.id}`,
      );
    }
    seen.add(ranking.id);
  }
}

const GAME_TOOLS: ToolDefinition[] = [
  {
    name: 'offer_trade',
    description:
      'Offer a bilateral trade to one other player. Matching reciprocal offers in the same round settle automatically.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target player id for the trade offer.' },
        give: { ...RESOURCE_BUNDLE_SCHEMA, description: 'Resources you are offering.' },
        receive: { ...RESOURCE_BUNDLE_SCHEMA, description: 'Resources you want back.' },
      },
      required: ['to', 'give', 'receive'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract_commons',
    description:
      'Extract a shared resource from an ecosystem you can access. Higher extraction gives more now but damages the commons faster.',
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

export const TragedyOfTheCommonsPlugin: CoordinationGame<
  TragedyConfig,
  TragedyState,
  TragedyAction,
  TragedyOutcome
> = {
  gameType: TRAGEDY_GAME_ID,
  version: '0.1.0',
  entryCost: credits(1),
  spectatorDelay: 0,
  progressUnit: 'round',
  chatScopes: ['all', 'dm'] as const,
  guide: TRAGEDY_GUIDE,

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
  recommendedPlugins: ['reasoning', 'trust-graph'],

  createInitialState,
  validateAction,
  applyAction,

  getVisibleState(state: TragedyState, playerId: string | null): unknown {
    if (playerId === null) return getSpectatorView(state);
    return getPlayerView(state, playerId) ?? getSpectatorView(state);
  },

  buildSpectatorView(
    state: TragedyState,
    _prevState: TragedyState | null,
    context: SpectatorContext,
  ): unknown {
    return getSpectatorView(state, context.handles, context.relayMessages);
  },

  isOver(state: TragedyState): boolean {
    return state.phase === 'finished';
  },

  getCurrentPhaseKind(state: TragedyState): GamePhaseKind {
    if (state.phase === 'finished') return 'finished';
    if (state.phase === 'playing') return 'in_progress';
    return 'lobby';
  },

  getTeamForPlayer(_state: TragedyState, playerId: string): string {
    return playerId;
  },

  getProgressCounter(state: TragedyState): number {
    return state.round;
  },

  getOutcome,

  computePayouts(
    outcome: TragedyOutcome,
    playerIds: string[],
    entryCost: bigint,
  ): Map<string, bigint> {
    const payouts = new Map<string, bigint>();
    validateRankingIntegrity(outcome.rankings, playerIds);
    const winner = [...outcome.rankings].sort(compareRanking)[0];
    const potTotal = entryCost * BigInt(playerIds.length);

    for (const id of playerIds) {
      const share = id === winner?.id ? potTotal : 0n;
      payouts.set(id, share - entryCost);
    }
    return payouts;
  },

  getPlayerStatus(state: TragedyState, playerId: string): string {
    const player = state.players.find((item) => item.id === playerId);
    if (!player) return '\n## Your Status\n- Unknown player';
    return `\n## Your Status\n- **Phase:** ${state.phase}\n- **Round:** ${state.round}/${state.config.maxRounds}\n- **VP:** ${player.vp}\n- **Influence:** ${player.influence}\n- **Controlled Regions:** ${player.regionsControlled.length}`;
  },

  getSummary(state: TragedyState): Record<string, unknown> {
    return {
      round: state.round,
      maxRounds: state.config.maxRounds,
      phase: state.phase,
      players: state.players.map((player) => player.id),
      flourishingEcosystems: state.ecosystems.filter(
        (ecosystem) => ecosystem.health >= ecosystem.flourishThreshold,
      ).length,
    };
  },

  getSummaryFromSpectator(snapshot: unknown): Record<string, unknown> {
    const s = snapshot as TragedySpectatorView;
    return {
      round: s.round,
      maxRounds: s.maxRounds,
      phase: s.phase,
      players: s.players.map((player) => player.id),
      flourishingEcosystems: s.ecosystems.filter((ecosystem) => ecosystem.status === 'flourishing')
        .length,
    };
  },

  getReplayChrome(snapshot: unknown): {
    isFinished: boolean;
    winnerLabel?: string;
    statusVariant: 'in_progress' | 'win' | 'draw';
  } {
    const s = snapshot as TragedySpectatorView;
    const isFinished = s.phase === 'finished';
    if (!isFinished) return { isFinished: false, statusVariant: 'in_progress' };
    if (!s.winner) return { isFinished: true, statusVariant: 'draw' };
    return { isFinished: true, winnerLabel: s.winner, statusVariant: 'win' };
  },

  getPlayersNeedingAction(state: TragedyState): string[] {
    if (state.phase !== 'playing') return [];
    return state.players
      .filter((player) => state.submittedActions[player.id] === null)
      .map((player) => player.id);
  },

  createConfig(
    players: { id: string; handle: string; team?: string; role?: string }[],
    seed: string,
    options?: Record<string, unknown>,
  ): GameSetup<TragedyConfig> {
    const maxRoundsOpt = options?.maxRounds;
    const maxRoundsOverride = typeof maxRoundsOpt === 'number' ? { maxRounds: maxRoundsOpt } : {};
    return {
      config: {
        ...DEFAULT_TRAGEDY_CONFIG,
        playerIds: players.map((player) => player.id),
        seed,
        ...maxRoundsOverride,
      },
      players: players.map((player) => ({ id: player.id, team: player.id })),
    };
  },
};

registerGame(TragedyOfTheCommonsPlugin);
