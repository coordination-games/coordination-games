import type {
  CoordinationGame,
  GamePhaseKind,
  GameSetup,
  SpectatorContext,
  ToolDefinition,
} from '@coordination-games/engine';
import {
  credits,
  defineLobbySizePolicy,
  OpenQueuePhase,
  registerGame,
} from '@coordination-games/engine';
import {
  applyAction,
  applyV2Action,
  buildV2PlayerView,
  buildV2SpectatorView,
  createInitialState,
  createV2InitialState,
  getOutcome,
  getPlayerView,
  getSpectatorView,
  getV2Outcome,
  type TragedySpectatorView,
  validateAction,
  validateV2Action,
} from './game.js';
import { effectiveV2FinalRound } from './hidden-horizon.js';
import { getTragedyLadderPlacements } from './ladder.js';
import { computeCarrySafePayouts } from './payouts.js';
import {
  DEFAULT_TRAGEDY_CONFIG,
  DEFAULT_V2_CONFIG,
  type TragedyAction,
  type TragedyConfig,
  type TragedyOutcome,
  type TragedyState,
  type TragedyV2Action,
  type TragedyV2Config,
  type TragedyV2Outcome,
  type TragedyV2SpectatorView,
  type TragedyV2State,
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
Highest VP ranks first when the round limit is reached, with Influence as the tie-breaker. The pot includes an equal reserve plus a ranked competitive pool scaled by commons health up to half the pot; exact VP and Influence ties share their occupied rank weight.

## Notes
This is an intentionally reduced v0 upstream port. Richer trust, commitments, and Olympiad portability are planned for later slices.
`;

export const TRAGEDY_GAME_ID = 'tragedy-of-the-commons' as const;
const TRAGEDY_LOBBY_SIZE_POLICY = defineLobbySizePolicy({
  min: 4,
  max: 6,
  default: 4,
  unit: 'player-count',
});

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
    phases: [new OpenQueuePhase(TRAGEDY_LOBBY_SIZE_POLICY.default, TRAGEDY_LOBBY_SIZE_POLICY)],
  },

  gameTools: GAME_TOOLS,

  requiredPlugins: ['basic-chat'],
  recommendedPlugins: ['reasoning', 'trust-projector-tragedy'],

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
  getLadderPlacements: getTragedyLadderPlacements,

  computePayouts(
    outcome: TragedyOutcome,
    playerIds: string[],
    entryCost: bigint,
  ): Map<string, bigint> {
    return computeCarrySafePayouts(outcome, playerIds, entryCost);
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
      commonsHealthPercent: getOutcome(state).commonsHealthPercent,
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
      commonsHealthPercent: s.commonsHealthPercent,
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
const TRAGEDY_GUIDE_V2 = `# Tragedy of the Commons — V2 Rules

Tragedy of the Commons is a free-for-all coordination game about shared scarcity on a tile-based board.

## Board
- Tiles: Forest (timber), Mountain (ore), River (fish/water), Wetland (fish/water), Oil Field (energy — rare and dangerous)
- Intersections: build spots at tile corners where structures can be placed
- Roads: tile-edge connections between intersections (cost: 1 timber + 1 energy)

## Core loop
- Setup starts with randomized player order. On your setup turn, use place_starting_camp to choose your free starting camp intersection.
- After every player places a legal non-adjacent starting camp, round 1 begins automatically.
- Each round begins with solar production and reset of extraction counters.
- You may submit one action per round.
- Extract tiles for short-term gain, but overuse degrades them.
- Build roads to expand your network, then build camps or solar farms at intersections.
- Upgrade camps → villages → cities, and solar-farms → solar-arrays for more VP.
- Offer bilateral trades; reciprocal offers in the same round settle automatically.

## Action types
- place_starting_camp (setup only)
- offer_trade
- build_road
- build_structure (camp or solar-farm)
- upgrade_structure
- extract_tile
- convert_timber_to_energy
- pass

## Build costs
- road: 1 timber + 1 energy
- camp: 1 timber + 1 fish + 1 water + 1 energy
- village: 2 timber + 1 fish + 1 water + 2 energy
- city: 2 ore + 2 fish + 1 water + 3 energy
- solar-farm: 1 ore + 1 timber + 2 energy
- solar-array: 2 ore + 2 water + 3 energy

## VP
- camp = 1, village = 2, city = 3, solar-farm = 1, solar-array = 2

## Extraction
- camp/village/city = 1/2/3 extraction units per round
- Must be adjacent to the tile you extract from
- low/medium/high extraction uses 1/2/3 units and applies 1/3/6 pressure
- Oil yields 2 energy per extraction but causes heavy damage to adjacent tiles
- convert_timber_to_energy converts 2 timber into 1 energy

## Tile health
- healthy → strained → collapsed
- Collapsed tiles produce nothing
- Tiles recover 2 health each round before new extraction pressure is applied
- Solar buildings generate clean energy without extraction

## Win condition
Highest VP ranks first when the round limit is reached, with Influence as the tie-breaker. The pot includes an equal reserve plus a ranked competitive pool scaled by commons health up to half the pot; exact VP and Influence ties share their occupied rank weight.
`;

const PLACE_STARTING_CAMP_TOOL: ToolDefinition = {
  name: 'place_starting_camp',
  description:
    'During setup, choose the intersection where your free starting camp will be placed. Camps cannot be adjacent to existing starting camps.',
  mcpExpose: true,
  inputSchema: {
    type: 'object',
    properties: {
      intersectionId: { type: 'string', description: 'Target empty intersection id.' },
    },
    required: ['intersectionId'],
    additionalProperties: false,
  },
};

const GAME_TOOLS_V2: ToolDefinition[] = [
  PLACE_STARTING_CAMP_TOOL,
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
    name: 'build_road',
    description:
      'Build a road between two intersections to expand your network. Cost: 1 timber + 1 energy.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        fromIntersectionId: { type: 'string', description: 'Starting intersection id.' },
        toIntersectionId: { type: 'string', description: 'Ending intersection id.' },
      },
      required: ['fromIntersectionId', 'toIntersectionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'build_structure',
    description:
      'Build a new camp or solar-farm at an intersection. New camps after setup must connect to your road network.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        intersectionId: { type: 'string', description: 'Target intersection id.' },
        structureType: {
          type: 'string',
          enum: ['camp', 'village', 'city', 'solar-farm', 'solar-array'],
          description: 'Type of structure to build.',
        },
      },
      required: ['intersectionId', 'structureType'],
      additionalProperties: false,
    },
  },
  {
    name: 'upgrade_structure',
    description:
      'Upgrade an existing structure you own (camp → village → city, solar-farm → solar-array).',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        structureId: { type: 'string', description: 'Id of the structure to upgrade.' },
      },
      required: ['structureId'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract_tile',
    description:
      'Extract resources from a tile adjacent to one of your structures. Higher extraction gives more now but damages the tile faster.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        tileId: { type: 'string', description: 'Id of the tile to extract from.' },
        resource: { type: 'string', description: 'Resource to extract.' },
        level: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Extraction intensity.',
        },
      },
      required: ['tileId', 'resource', 'level'],
      additionalProperties: false,
    },
  },
  {
    name: 'convert_timber_to_energy',
    description: 'Convert 2 timber into 1 energy.',
    mcpExpose: true,
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, description: 'Amount of energy to produce.' },
      },
      required: ['amount'],
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

const ROUND_TOOLS_V2 = GAME_TOOLS_V2.filter((tool) => tool.name !== PLACE_STARTING_CAMP_TOOL.name);

export const TragedyOfTheCommonsV2Plugin: CoordinationGame<
  TragedyV2Config,
  TragedyV2State,
  TragedyV2Action,
  TragedyV2Outcome
> = {
  gameType: TRAGEDY_GAME_ID,
  version: '0.2.0',
  entryCost: credits(1),
  spectatorDelay: 0,
  progressUnit: 'round',
  chatScopes: ['all', 'dm'] as const,
  guide: TRAGEDY_GUIDE_V2,

  lobby: {
    phases: [new OpenQueuePhase(TRAGEDY_LOBBY_SIZE_POLICY.default, TRAGEDY_LOBBY_SIZE_POLICY)],
  },

  gameTools: GAME_TOOLS_V2,

  getCurrentGameTools(state: TragedyV2State, playerId: string | null): ToolDefinition[] {
    if (state.phase === 'waiting') {
      const currentPlayer = state.players[state.currentPlayerIndex];
      return playerId !== null &&
        currentPlayer?.id === playerId &&
        currentPlayer.ownedStructureIds.length === 0
        ? [PLACE_STARTING_CAMP_TOOL]
        : [];
    }
    if (state.phase !== 'playing') return [];
    return playerId !== null && state.submittedActions[playerId] === null ? ROUND_TOOLS_V2 : [];
  },

  requiredPlugins: ['basic-chat'],
  recommendedPlugins: ['reasoning', 'trust-projector-tragedy'],

  createInitialState: createV2InitialState,
  validateAction: validateV2Action,
  applyAction: applyV2Action,

  getVisibleState(state: TragedyV2State, playerId: string | null): unknown {
    if (playerId === null) return buildV2SpectatorView(state);
    return buildV2PlayerView(state, playerId) ?? buildV2SpectatorView(state);
  },

  buildSpectatorView(
    state: TragedyV2State,
    _prevState: TragedyV2State | null,
    context: SpectatorContext,
  ): unknown {
    return {
      ...buildV2SpectatorView(state),
      winner: state.winner,
      handles: context.handles,
      relayMessages: context.relayMessages,
    };
  },

  isOver(state: TragedyV2State): boolean {
    const finalRound = effectiveV2FinalRound(state);
    return state.phase === 'finished' && state.round === finalRound;
  },

  getCurrentPhaseKind(state: TragedyV2State): GamePhaseKind {
    if (state.phase === 'finished') return 'finished';
    if (state.phase === 'playing') return 'in_progress';
    return 'lobby';
  },

  getTeamForPlayer(_state: TragedyV2State, playerId: string): string {
    return playerId;
  },

  getProgressCounter(state: TragedyV2State): number {
    return state.round;
  },

  getOutcome: getV2Outcome,
  getLadderPlacements: getTragedyLadderPlacements,

  computePayouts(
    outcome: TragedyV2Outcome,
    playerIds: string[],
    entryCost: bigint,
  ): Map<string, bigint> {
    return computeCarrySafePayouts(outcome, playerIds, entryCost);
  },

  getPlayerStatus(state: TragedyV2State, playerId: string): string {
    const player = state.players.find((item) => item.id === playerId);
    if (!player) return '\n## Your Status\n- Unknown player';
    const horizon = state.config.hiddenHorizon;
    const publicHorizon =
      horizon === undefined
        ? ''
        : `\n- **Hidden horizon:** rounds ${horizon.minRounds}-${horizon.maxRounds}; hazard ${horizon.hazardNumerator}/${horizon.hazardDenominator}; commitment ${horizon.commitment}`;
    return `\n## Your Status\n- **Phase:** ${state.phase}\n- **Round:** ${state.round}/${state.config.maxRounds}\n- **VP:** ${player.vp}\n- **Influence:** ${player.influence}\n- **Structures:** ${player.ownedStructureIds.length}\n- **Roads:** ${player.ownedRoadIds.length}${publicHorizon}`;
  },

  getSummary(state: TragedyV2State): Record<string, unknown> {
    const horizon = state.config.hiddenHorizon;
    return {
      round: state.round,
      maxRounds: state.config.maxRounds,
      phase: state.phase,
      players: state.players.map((player) => player.id),
      flourishingEcosystems: state.tiles.filter((tile) => tile.status === 'flourishing').length,
      commonsHealthPercent: getV2Outcome(state).commonsHealthPercent,
      ...(horizon === undefined
        ? {}
        : {
            hiddenHorizon: {
              commitment: horizon.commitment,
              policyHash: horizon.policyHash,
              minRounds: horizon.minRounds,
              maxRounds: horizon.maxRounds,
              hazardNumerator: horizon.hazardNumerator,
              hazardDenominator: horizon.hazardDenominator,
            },
          }),
    };
  },

  getSummaryFromSpectator(snapshot: unknown): Record<string, unknown> {
    const s = snapshot as TragedyV2SpectatorView & { winner?: string | null };
    return {
      round: s.round,
      maxRounds: s.maxRounds,
      phase: s.phase,
      players: s.players.map((player) => player.id),
      flourishingEcosystems: s.tiles.filter((tile) => tile.status === 'flourishing').length,
      commonsHealthPercent: s.commonsHealthPercent,
      ...(s.hiddenHorizon === undefined ? {} : { hiddenHorizon: { ...s.hiddenHorizon } }),
    };
  },

  getReplayChrome(snapshot: unknown): {
    isFinished: boolean;
    winnerLabel?: string;
    statusVariant: 'in_progress' | 'win' | 'draw';
  } {
    const s = snapshot as TragedyV2SpectatorView & { winner?: string | null };
    const isFinished = s.phase === 'finished';
    if (!isFinished) return { isFinished: false, statusVariant: 'in_progress' };
    if (!s.winner) return { isFinished: true, statusVariant: 'draw' };
    return { isFinished: true, winnerLabel: s.winner, statusVariant: 'win' };
  },

  getPlayersNeedingAction(state: TragedyV2State): string[] {
    if (state.phase === 'waiting') {
      const currentPlayer = state.players[state.currentPlayerIndex];
      return currentPlayer && currentPlayer.ownedStructureIds.length === 0
        ? [currentPlayer.id]
        : [];
    }
    if (state.phase !== 'playing') return [];
    return state.players
      .filter((player) => state.submittedActions[player.id] === null)
      .map((player) => player.id);
  },

  createConfig(
    players: { id: string; handle: string; team?: string; role?: string }[],
    seed: string,
    options?: Record<string, unknown>,
  ): GameSetup<TragedyV2Config> {
    const maxRoundsOpt = options?.maxRounds;
    const maxRoundsOverride = typeof maxRoundsOpt === 'number' ? { maxRounds: maxRoundsOpt } : {};
    return {
      config: {
        ...DEFAULT_V2_CONFIG(),
        playerIds: players.map((player) => player.id),
        seed,
        ...maxRoundsOverride,
      },
      players: players.map((player) => ({ id: player.id, team: player.id })),
    };
  },
};

registerGame(TragedyOfTheCommonsV2Plugin);
