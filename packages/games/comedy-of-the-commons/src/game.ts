import type { ActionResult } from '@coordination-games/engine';
import {
  type ComedyAction,
  type ComedyConfig,
  type ComedyEcosystem,
  type ComedyOutcome,
  type ComedyPlayerState,
  type ComedyRegion,
  type ComedyState,
  type ComedyTradeOffer,
  type ExtractionLevel,
  type ResourceInventory,
  type ResourceType,
} from './types.js';

function toTradeOffer(action: Extract<ComedyAction, { type: 'offer_trade' }>): ComedyTradeOffer {
  return {
    to: action.to,
    give: { ...action.give },
    receive: { ...action.receive },
  };
}

const RESOURCE_CAP = 14;
const SETTLEMENT_COST: Partial<ResourceInventory> = {
  grain: 1,
  timber: 1,
  ore: 1,
  water: 1,
};

const EXTRACTION_PROFILES: Record<ExtractionLevel, { yield: number; pressure: number }> = {
  low: { yield: 1, pressure: 1 },
  medium: { yield: 2, pressure: 3 },
  high: { yield: 3, pressure: 6 },
};

const STARTING_RESOURCES: ResourceInventory = {
  grain: 2,
  timber: 2,
  ore: 1,
  fish: 1,
  water: 1,
  energy: 1,
};

function cloneResources(resources: ResourceInventory): ResourceInventory {
  return { ...resources };
}

function totalResources(resources: ResourceInventory): number {
  return Object.values(resources).reduce((sum, value) => sum + value, 0);
}

function canAfford(resources: ResourceInventory, cost: Partial<ResourceInventory>): boolean {
  return Object.entries(cost).every(([key, value]) => resources[key as ResourceType] >= (value ?? 0));
}

function deductCost(resources: ResourceInventory, cost: Partial<ResourceInventory>): void {
  for (const [key, value] of Object.entries(cost)) {
    resources[key as ResourceType] -= value ?? 0;
  }
}

function addResource(resources: ResourceInventory, resource: ResourceType, amount: number): number {
  const currentTotal = totalResources(resources);
  if (currentTotal >= RESOURCE_CAP) return 0;
  const accepted = Math.min(amount, RESOURCE_CAP - currentTotal);
  resources[resource] += accepted;
  return accepted;
}

function inventoryEquals(left: Partial<ResourceInventory>, right: Partial<ResourceInventory>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key as ResourceType] ?? 0) !== (right[key as ResourceType] ?? 0)) return false;
  }
  return true;
}

function getBaseRegions(): ComedyRegion[] {
  return [
    { id: 'mistbarrow', name: 'Mistbarrow', primaryResource: 'timber', secondaryResources: ['water'], ecosystemIds: ['old-growth-ring'] },
    { id: 'riverwake', name: 'Riverwake', primaryResource: 'water', secondaryResources: ['fish', 'grain'], ecosystemIds: ['sunspine-aquifer'] },
    { id: 'commons-heart', name: 'Commons Heart', primaryResource: 'grain', secondaryResources: ['timber', 'water'], ecosystemIds: ['old-growth-ring', 'sunspine-aquifer'] },
    { id: 'sunspine-basin', name: 'Sunspine Basin', primaryResource: 'energy', secondaryResources: ['ore'], ecosystemIds: ['sunspine-aquifer'] },
    { id: 'ironcrest', name: 'Ironcrest', primaryResource: 'ore', secondaryResources: ['energy'], ecosystemIds: [] },
    { id: 'monsoon-reach', name: 'Monsoon Reach', primaryResource: 'fish', secondaryResources: ['water', 'grain'], ecosystemIds: ['silver-tide-fishery'] },
  ];
}

function getBaseEcosystems(): ComedyEcosystem[] {
  return [
    {
      id: 'old-growth-ring',
      name: 'Old Growth Ring',
      kind: 'forest',
      resource: 'timber',
      regionIds: ['mistbarrow', 'commons-heart'],
      health: 16,
      maxHealth: 20,
      collapseThreshold: 4,
      flourishThreshold: 16,
    },
    {
      id: 'sunspine-aquifer',
      name: 'Sunspine Aquifer',
      kind: 'aquifer',
      resource: 'water',
      regionIds: ['riverwake', 'commons-heart', 'sunspine-basin'],
      health: 15,
      maxHealth: 20,
      collapseThreshold: 4,
      flourishThreshold: 16,
    },
    {
      id: 'silver-tide-fishery',
      name: 'Silver Tide Fishery',
      kind: 'fishery',
      resource: 'fish',
      regionIds: ['monsoon-reach'],
      health: 14,
      maxHealth: 20,
      collapseThreshold: 4,
      flourishThreshold: 16,
    },
  ];
}

function createPlayers(playerIds: string[], regions: ComedyRegion[]): ComedyPlayerState[] {
  return playerIds.map((id, index) => ({
    id,
    resources: cloneResources(STARTING_RESOURCES),
    influence: 0,
    vp: 1,
    regionsControlled: [regions[index % regions.length].id],
  }));
}

function makeSubmittedActions(playerIds: string[]): Record<string, ComedyAction | null> {
  return Object.fromEntries(playerIds.map((id) => [id, null]));
}

function ecosystemStatus(ecosystem: ComedyEcosystem): 'flourishing' | 'stable' | 'strained' | 'collapsed' {
  if (ecosystem.health <= ecosystem.collapseThreshold) return 'collapsed';
  if (ecosystem.health >= ecosystem.flourishThreshold) return 'flourishing';
  if (ecosystem.health <= Math.ceil(ecosystem.maxHealth / 2)) return 'strained';
  return 'stable';
}

function getYieldMultiplier(ecosystem: ComedyEcosystem): number {
  const status = ecosystemStatus(ecosystem);
  if (status === 'flourishing') return 1.5;
  if (status === 'collapsed') return 0.5;
  if (status === 'strained') return 0.8;
  return 1;
}

function applyProduction(state: ComedyState): ComedyState {
  const ecosystems = state.ecosystems.map((ecosystem) => ({ ...ecosystem }));
  const ecosystemById = new Map(ecosystems.map((ecosystem) => [ecosystem.id, ecosystem]));
  const players = state.players.map((player) => ({ ...player, resources: cloneResources(player.resources), regionsControlled: [...player.regionsControlled] }));
  const regionsById = new Map(state.regions.map((region) => [region.id, region]));

  for (const player of players) {
    for (const regionId of player.regionsControlled) {
      const region = regionsById.get(regionId);
      if (!region) continue;
      addResource(player.resources, region.primaryResource, 1);
      for (const ecosystemId of region.ecosystemIds) {
        const ecosystem = ecosystemById.get(ecosystemId);
        if (ecosystem && ecosystemStatus(ecosystem) === 'flourishing') {
          addResource(player.resources, ecosystem.resource, 1);
          break;
        }
      }
    }
  }

  return { ...state, players, ecosystems };
}

function startRound(state: ComedyState): ComedyState {
  const round = state.round + 1;
  const started = {
    ...state,
    round,
    phase: 'playing' as const,
    activeTrades: [],
    submittedActions: makeSubmittedActions(state.players.map((player) => player.id)),
  };
  return applyProduction(started);
}

function allPlayersSubmitted(state: ComedyState): boolean {
  return state.players.every((player) => state.submittedActions[player.id] !== null);
}

function resolveTrades(
  players: ComedyPlayerState[],
  submittedByPlayer: Array<{ playerId: string; action: ComedyAction }>,
): ComedyTradeOffer[] {
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const completed: ComedyTradeOffer[] = [];
  const used = new Set<number>();

  for (let i = 0; i < submittedByPlayer.length; i++) {
    const current = submittedByPlayer[i];
    if (current.action.type !== 'offer_trade' || used.has(i)) continue;
    for (let j = i + 1; j < submittedByPlayer.length; j++) {
      const other = submittedByPlayer[j];
      if (other.action.type !== 'offer_trade' || used.has(j)) continue;
      if (current.playerId === other.playerId) continue;
      if (current.action.to !== other.playerId) continue;
      if (other.action.to !== current.playerId) continue;
      if (!inventoryEquals(current.action.give, other.action.receive)) continue;
      if (!inventoryEquals(current.action.receive, other.action.give)) continue;

      const actionSender = playerMap.get(current.playerId);
      const otherSender = playerMap.get(other.playerId);
      if (!actionSender || !otherSender) continue;
      if (!canAfford(actionSender.resources, current.action.give)) continue;
      if (!canAfford(otherSender.resources, other.action.give)) continue;

      deductCost(actionSender.resources, current.action.give);
      deductCost(otherSender.resources, other.action.give);
      for (const [resource, amount] of Object.entries(current.action.receive)) {
        actionSender.resources[resource as ResourceType] += amount ?? 0;
      }
      for (const [resource, amount] of Object.entries(other.action.receive)) {
        otherSender.resources[resource as ResourceType] += amount ?? 0;
      }
      actionSender.influence += 1;
      otherSender.influence += 1;
      completed.push(toTradeOffer(current.action), toTradeOffer(other.action));
      used.add(i);
      used.add(j);
      break;
    }
  }

  return completed;
}

function resolveRound(state: ComedyState): ComedyState {
  const players = state.players.map((player) => ({ ...player, resources: cloneResources(player.resources), regionsControlled: [...player.regionsControlled] }));
  const ecosystems = state.ecosystems.map((ecosystem) => ({ ...ecosystem }));
  const ecosystemById = new Map(ecosystems.map((ecosystem) => [ecosystem.id, ecosystem]));
  const submittedByPlayer = players.map((player) => ({
    playerId: player.id,
    action: state.submittedActions[player.id] ?? ({ type: 'pass' } as ComedyAction),
  }));

  const completedTrades = resolveTrades(players, submittedByPlayer);
  const pressureByEcosystem = new Map<string, number>();

  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    const action = submittedByPlayer[index].action;
    if (action.type === 'extract_commons') {
      const ecosystem = ecosystemById.get(action.ecosystemId);
      if (!ecosystem) continue;
      const controlsRegion = ecosystem.regionIds.some((regionId) => player.regionsControlled.includes(regionId));
      if (!controlsRegion) continue;
      const profile = EXTRACTION_PROFILES[action.level];
      const accepted = addResource(player.resources, ecosystem.resource, Math.max(1, Math.round(profile.yield * getYieldMultiplier(ecosystem))));
      if (accepted > 0) {
        pressureByEcosystem.set(ecosystem.id, (pressureByEcosystem.get(ecosystem.id) ?? 0) + profile.pressure);
      }
      continue;
    }

    if (action.type === 'build_settlement') {
      if (!action.regionId) continue;
      if (!canAfford(player.resources, SETTLEMENT_COST)) continue;
      const regionTaken = players.some((other) => other.regionsControlled.includes(action.regionId));
      if (regionTaken) continue;
      deductCost(player.resources, SETTLEMENT_COST);
      player.regionsControlled.push(action.regionId);
      player.vp += 1;
      player.influence += 1;
    }
  }

  for (const ecosystem of ecosystems) {
    const pressure = pressureByEcosystem.get(ecosystem.id) ?? 0;
    const nextHealth = Math.max(0, Math.min(ecosystem.maxHealth, ecosystem.health + 2 - pressure));
    ecosystem.health = nextHealth;
  }

  const flourishingEcosystems = ecosystems.filter((ecosystem) => ecosystemStatus(ecosystem) === 'flourishing');
  for (const ecosystem of flourishingEcosystems) {
    for (const player of players) {
      if (ecosystem.regionIds.some((regionId) => player.regionsControlled.includes(regionId))) {
        player.influence += 1;
      }
    }
  }

  const rankings = [...players].sort((left, right) => {
    if (right.vp !== left.vp) return right.vp - left.vp;
    return right.influence - left.influence;
  });
  const winner = rankings[0]?.id ?? null;

  return {
    ...state,
    players,
    ecosystems,
    activeTrades: completedTrades,
    winner,
  };
}

function advanceOrFinish(state: ComedyState): ActionResult<ComedyState, ComedyAction> {
  if (state.round >= state.config.maxRounds) {
    return {
      state: { ...state, phase: 'finished' },
      deadline: null,
      progressIncrement: true,
    };
  }

  return {
    state: startRound(state),
    deadline: {
      seconds: state.config.turnTimerSeconds,
      action: { type: 'round_timeout' },
    },
    progressIncrement: true,
  };
}

export function createInitialState(config: ComedyConfig): ComedyState {
  const regions = getBaseRegions();
  return {
    round: 0,
    phase: 'waiting',
    players: createPlayers(config.playerIds, regions),
    regions,
    ecosystems: getBaseEcosystems(),
    activeTrades: [],
    submittedActions: makeSubmittedActions(config.playerIds),
    winner: null,
    config,
  };
}

export function validateAction(state: ComedyState, playerId: string | null, action: ComedyAction): boolean {
  if (action.type === 'game_start') {
    return playerId === null && state.phase === 'waiting';
  }

  if (action.type === 'round_timeout') {
    return playerId === null && state.phase === 'playing';
  }

  if (playerId === null || state.phase !== 'playing') return false;
  if (state.submittedActions[playerId] !== null) return false;
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return false;

  if (action.type === 'build_settlement') {
    return Boolean(action.regionId && !player.regionsControlled.includes(action.regionId));
  }

  if (action.type === 'extract_commons') {
    return Boolean(action.ecosystemId && EXTRACTION_PROFILES[action.level]);
  }

  if (action.type === 'offer_trade') {
    return Boolean(action.to && action.to !== playerId);
  }

  return true;
}

export function applyAction(state: ComedyState, playerId: string | null, action: ComedyAction): ActionResult<ComedyState, ComedyAction> {
  if (action.type === 'game_start') {
    return {
      state: startRound(state),
      deadline: {
        seconds: state.config.turnTimerSeconds,
        action: { type: 'round_timeout' },
      },
      progressIncrement: true,
    };
  }

  if (action.type === 'round_timeout') {
    const completed = resolveRound({
      ...state,
      submittedActions: Object.fromEntries(
        Object.entries(state.submittedActions).map(([id, submitted]) => [id, submitted ?? { type: 'pass' }]),
      ),
    });
    return advanceOrFinish(completed);
  }

  if (!playerId) {
    return { state };
  }

  const nextState: ComedyState = {
    ...state,
    submittedActions: {
      ...state.submittedActions,
      [playerId]: action,
    },
  };

  if (!allPlayersSubmitted(nextState)) {
    return { state: nextState };
  }

  const completed = resolveRound(nextState);
  return advanceOrFinish(completed);
}

export interface ComedyPlayerView {
  round: number;
  maxRounds: number;
  phase: ComedyState['phase'];
  you: ComedyPlayerState;
  scoreboard: Array<{ id: string; vp: number; influence: number; regionsControlled: number }>;
  regions: ComedyRegion[];
  ecosystems: Array<ComedyEcosystem & { status: ReturnType<typeof ecosystemStatus> }>;
  activeTrades: ComedyTradeOffer[];
  submitted: boolean;
}

export interface ComedySpectatorView {
  round: number;
  maxRounds: number;
  phase: ComedyState['phase'];
  players: Array<ComedyPlayerState & { totalResources: number }>;
  regions: ComedyRegion[];
  ecosystems: Array<ComedyEcosystem & { status: ReturnType<typeof ecosystemStatus> }>;
  activeTrades: ComedyTradeOffer[];
  winner: string | null;
  handles: Record<string, string>;
  relayMessages?: any[];
}

export function getPlayerView(state: ComedyState, playerId: string): ComedyPlayerView | null {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return null;
  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    you: { ...player, resources: cloneResources(player.resources), regionsControlled: [...player.regionsControlled] },
    scoreboard: state.players.map((item) => ({
      id: item.id,
      vp: item.vp,
      influence: item.influence,
      regionsControlled: item.regionsControlled.length,
    })),
    regions: state.regions.map((region) => ({ ...region, secondaryResources: [...region.secondaryResources], ecosystemIds: [...region.ecosystemIds] })),
    ecosystems: state.ecosystems.map((ecosystem) => ({ ...ecosystem, regionIds: [...ecosystem.regionIds], status: ecosystemStatus(ecosystem) })),
    activeTrades: state.activeTrades.map((offer) => ({ ...offer, give: { ...offer.give }, receive: { ...offer.receive } })),
    submitted: state.submittedActions[playerId] !== null,
  };
}

export function getSpectatorView(state: ComedyState, handles: Record<string, string>, relayMessages: any[] = []): ComedySpectatorView {
  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    players: state.players.map((player) => ({
      ...player,
      resources: cloneResources(player.resources),
      regionsControlled: [...player.regionsControlled],
      totalResources: totalResources(player.resources),
    })),
    regions: state.regions.map((region) => ({ ...region, secondaryResources: [...region.secondaryResources], ecosystemIds: [...region.ecosystemIds] })),
    ecosystems: state.ecosystems.map((ecosystem) => ({ ...ecosystem, regionIds: [...ecosystem.regionIds], status: ecosystemStatus(ecosystem) })),
    activeTrades: state.activeTrades.map((offer) => ({ ...offer, give: { ...offer.give }, receive: { ...offer.receive } })),
    winner: state.winner,
    handles,
    relayMessages,
  };
}

export function getOutcome(state: ComedyState): ComedyOutcome {
  const rankings = [...state.players]
    .sort((left, right) => {
      if (right.vp !== left.vp) return right.vp - left.vp;
      return right.influence - left.influence;
    })
    .map((player) => ({ id: player.id, vp: player.vp, influence: player.influence }));

  return {
    rankings,
    roundsPlayed: state.round,
    flourishingEcosystems: state.ecosystems.filter((ecosystem) => ecosystemStatus(ecosystem) === 'flourishing').length,
    collapsedEcosystems: state.ecosystems.filter((ecosystem) => ecosystemStatus(ecosystem) === 'collapsed').length,
  };
}
