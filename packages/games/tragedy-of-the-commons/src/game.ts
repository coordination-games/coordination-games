import type { ActionResult, GameDeadline, RelayEnvelope } from '@coordination-games/engine';
import type {
  ExtractionLevel,
  ResourceInventory,
  ResourceType,
  TragedyAction,
  TragedyBoardTile,
  TragedyConfig,
  TragedyEcosystem,
  TragedyOutcome,
  TragedyPlayerState,
  TragedyRegion,
  TragedyState,
  TragedyTerrain,
  TragedyTradeOffer,
} from './types.js';

type EcosystemStatus = 'flourishing' | 'stable' | 'strained' | 'collapsed';

function toTradeOffer(action: Extract<TragedyAction, { type: 'offer_trade' }>): TragedyTradeOffer {
  return {
    to: action.to,
    give: { ...action.give },
    receive: { ...action.receive },
  };
}

const RESOURCE_CAP = 14;
const RESOURCE_TYPES: readonly ResourceType[] = [
  'grain',
  'timber',
  'ore',
  'fish',
  'water',
  'energy',
];
const RESOURCE_TYPE_SET = new Set<string>(RESOURCE_TYPES);
const PRODUCTION_WHEEL = [5, 8, 10, 6, 11, 9, 4, 3, 12, 2, 5, 8, 10, 6, 11, 9, 4, 3, 12];

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

function roundTimeoutDeadline(turnTimerSeconds: number): GameDeadline<TragedyAction> {
  return {
    kind: 'absolute',
    at: Date.now() + turnTimerSeconds * 1000,
    action: { type: 'round_timeout' },
  };
}

function turnTimeoutDeadline(turnTimerSeconds: number): GameDeadline<TragedyAction> {
  return roundTimeoutDeadline(turnTimerSeconds);
}

function isPlayersTurn(state: TragedyState, playerId: string): boolean {
  const currentPlayer = state.players[state.currentPlayerIndex];
  return currentPlayer?.id === playerId;
}

function advanceTurn(state: TragedyState): ActionResult<TragedyState, TragedyAction> {
  const nextIndex = (state.currentPlayerIndex + 1) % state.players.length;

  // If we've gone full circle, resolve the round
  if (nextIndex === 0) {
    const completed = resolveRound(state);
    return advanceOrFinish(completed);
  }

  // Move to next player's turn
  const nextPlayer = state.players[nextIndex];
  const nextState: TragedyState = {
    ...state,
    currentPlayerIndex: nextIndex,
  };

  const relayMessages: RelayEnvelope[] = [];

  // Broadcast turn change to all players
  const turnChangeRelay: RelayEnvelope = {
    type: 'messaging',
    index: -1,
    sender: 'system',
    scope: { kind: 'all' },
    data: {
      body: `Turn passes to ${nextPlayer?.id ?? 'next player'}.`,
    },
    pluginId: 'basic-chat',
    turn: state.round,
    timestamp: Date.now(),
  };
  relayMessages.push(turnChangeRelay);

  // Targeted DM to the player whose turn it is
  if (nextPlayer) {
    const turnDm: RelayEnvelope = {
      type: 'messaging',
      index: -1,
      sender: 'system',
      scope: { kind: 'dm', recipientHandle: nextPlayer.id },
      data: {
        body: `It is now your turn. You are player ${nextPlayer.id}.`,
      },
      pluginId: 'basic-chat',
      turn: state.round,
      timestamp: Date.now(),
    };
    relayMessages.push(turnDm);
  }

  return {
    state: nextState,
    deadline: turnTimeoutDeadline(state.config.turnTimerSeconds),
    relayMessages,
  };
}

function cloneResources(resources: ResourceInventory): ResourceInventory {
  return { ...resources };
}

function totalResources(resources: ResourceInventory): number {
  return Object.values(resources).reduce((sum, value) => sum + value, 0);
}

function hasPositiveResource(resources: Partial<ResourceInventory> | null | undefined): boolean {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return false;
  return Object.values(resources).some((value) => (value ?? 0) > 0);
}

function isValidResourceBundle(resources: Partial<ResourceInventory> | null | undefined): boolean {
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return false;
  return Object.entries(resources).every(([key, value]) => {
    return (
      RESOURCE_TYPE_SET.has(key) &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
    );
  });
}

function isValidTradeOffer(action: Extract<TragedyAction, { type: 'offer_trade' }>): boolean {
  return (
    isValidResourceBundle(action.give) &&
    isValidResourceBundle(action.receive) &&
    hasPositiveResource(action.give) &&
    hasPositiveResource(action.receive)
  );
}

function canAfford(resources: ResourceInventory, cost: Partial<ResourceInventory>): boolean {
  return Object.entries(cost).every(
    ([key, value]) => resources[key as ResourceType] >= (value ?? 0),
  );
}

function totalAfterExchange(
  resources: ResourceInventory,
  give: Partial<ResourceInventory>,
  receive: Partial<ResourceInventory>,
): number {
  let total = totalResources(resources);
  for (const amount of Object.values(give)) total -= amount ?? 0;
  for (const amount of Object.values(receive)) total += amount ?? 0;
  return total;
}

function canFitTradeReceipt(
  resources: ResourceInventory,
  give: Partial<ResourceInventory>,
  receive: Partial<ResourceInventory>,
): boolean {
  return totalAfterExchange(resources, give, receive) <= RESOURCE_CAP;
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

function inventoryEquals(
  left: Partial<ResourceInventory>,
  right: Partial<ResourceInventory>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key as ResourceType] ?? 0) !== (right[key as ResourceType] ?? 0)) return false;
  }
  return true;
}

function getBaseRegions(): TragedyRegion[] {
  return [
    {
      id: 'mistbarrow',
      name: 'Mistbarrow',
      primaryResource: 'timber',
      secondaryResources: ['water'],
      ecosystemIds: ['old-growth-ring'],
    },
    {
      id: 'riverwake',
      name: 'Riverwake',
      primaryResource: 'water',
      secondaryResources: ['fish', 'grain'],
      ecosystemIds: ['sunspine-aquifer'],
    },
    {
      id: 'commons-heart',
      name: 'Commons Heart',
      primaryResource: 'grain',
      secondaryResources: ['timber', 'water'],
      ecosystemIds: ['old-growth-ring', 'sunspine-aquifer'],
    },
    {
      id: 'sunspine-basin',
      name: 'Sunspine Basin',
      primaryResource: 'energy',
      secondaryResources: ['ore'],
      ecosystemIds: ['sunspine-aquifer'],
    },
    {
      id: 'ironcrest',
      name: 'Ironcrest',
      primaryResource: 'ore',
      secondaryResources: ['energy'],
      ecosystemIds: [],
    },
    {
      id: 'monsoon-reach',
      name: 'Monsoon Reach',
      primaryResource: 'fish',
      secondaryResources: ['water', 'grain'],
      ecosystemIds: ['silver-tide-fishery'],
    },
  ];
}

function getBaseEcosystems(): TragedyEcosystem[] {
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

function terrainForRegion(region: TragedyRegion): TragedyTerrain {
  if (region.id === 'commons-heart') return 'commons';
  if (region.primaryResource === 'timber') return 'forest';
  if (region.primaryResource === 'ore') return 'mountains';
  if (region.primaryResource === 'water' || region.primaryResource === 'fish') return 'rivers';
  return 'plains';
}

function boardTile(
  q: number,
  r: number,
  terrain: TragedyTerrain,
  productionNumber: number,
  ecosystemIds: string[] = [],
  region?: TragedyRegion,
): TragedyBoardTile {
  const tileEcosystemIds = region ? region.ecosystemIds : ecosystemIds;
  return {
    id: `${q},${r}`,
    q,
    r,
    terrain,
    productionNumber,
    revealed: true,
    ecosystemIds: [...tileEcosystemIds],
    ...(region
      ? {
          regionId: region.id,
          regionName: region.name,
          primaryResource: region.primaryResource,
        }
      : {}),
  };
}

function getBaseBoardTiles(regions: TragedyRegion[]): TragedyBoardTile[] {
  const regionById = new Map(regions.map((region) => [region.id, region]));
  const regionTileSpecs: Array<{ q: number; r: number; regionId: string }> = [
    { q: 0, r: 0, regionId: 'commons-heart' },
    { q: -1, r: 0, regionId: 'mistbarrow' },
    { q: -1, r: 1, regionId: 'riverwake' },
    { q: 1, r: -1, regionId: 'sunspine-basin' },
    { q: 0, r: -1, regionId: 'ironcrest' },
    { q: 1, r: 0, regionId: 'monsoon-reach' },
  ];
  const keyed = new Map<string, TragedyBoardTile>();

  for (const [index, spec] of regionTileSpecs.entries()) {
    const region = regionById.get(spec.regionId);
    if (!region) continue;
    keyed.set(
      `${spec.q},${spec.r}`,
      boardTile(
        spec.q,
        spec.r,
        terrainForRegion(region),
        PRODUCTION_WHEEL[index] ?? 0,
        region.ecosystemIds,
        region,
      ),
    );
  }

  const nativeCommonsHorizon: Array<{
    q: number;
    r: number;
    terrain: TragedyTerrain;
    ecosystemIds: string[];
  }> = [
    { q: -2, r: 0, terrain: 'forest', ecosystemIds: ['old-growth-ring'] },
    { q: -2, r: 1, terrain: 'forest', ecosystemIds: ['old-growth-ring'] },
    { q: -2, r: 2, terrain: 'wetland', ecosystemIds: ['sunspine-aquifer'] },
    { q: -1, r: -1, terrain: 'forest', ecosystemIds: ['old-growth-ring'] },
    { q: -1, r: 2, terrain: 'wetland', ecosystemIds: ['sunspine-aquifer', 'silver-tide-fishery'] },
    { q: 0, r: -2, terrain: 'mountains', ecosystemIds: [] },
    { q: 0, r: 1, terrain: 'commons', ecosystemIds: ['sunspine-aquifer'] },
    { q: 0, r: 2, terrain: 'rivers', ecosystemIds: ['silver-tide-fishery'] },
    { q: 1, r: -2, terrain: 'mountains', ecosystemIds: [] },
    { q: 1, r: 1, terrain: 'rivers', ecosystemIds: ['silver-tide-fishery'] },
    { q: 2, r: -2, terrain: 'wasteland', ecosystemIds: [] },
    { q: 2, r: -1, terrain: 'rivers', ecosystemIds: ['silver-tide-fishery'] },
    { q: 2, r: 0, terrain: 'wetland', ecosystemIds: ['silver-tide-fishery'] },
  ];

  for (const [index, spec] of nativeCommonsHorizon.entries()) {
    const key = `${spec.q},${spec.r}`;
    if (keyed.has(key)) continue;
    keyed.set(
      key,
      boardTile(
        spec.q,
        spec.r,
        spec.terrain,
        PRODUCTION_WHEEL[(regionTileSpecs.length + index) % PRODUCTION_WHEEL.length] ?? 0,
        spec.ecosystemIds,
      ),
    );
  }

  return [...keyed.values()].sort((left, right) => left.r - right.r || left.q - right.q);
}

function createPlayers(playerIds: string[], regions: TragedyRegion[]): TragedyPlayerState[] {
  return playerIds.map((id, index) => {
    const region = regions[index % regions.length];
    if (!region) throw new Error('Tragedy setup requires at least one region');
    return {
      id,
      resources: cloneResources(STARTING_RESOURCES),
      influence: 0,
      vp: 1,
      regionsControlled: [region.id],
    };
  });
}

function makeSubmittedActions(playerIds: string[]): Record<string, TragedyAction | null> {
  return Object.fromEntries(playerIds.map((id) => [id, null]));
}

function ecosystemStatus(ecosystem: TragedyEcosystem): EcosystemStatus {
  if (ecosystem.health <= ecosystem.collapseThreshold) return 'collapsed';
  if (ecosystem.health >= ecosystem.flourishThreshold) return 'flourishing';
  if (ecosystem.health <= Math.ceil(ecosystem.maxHealth / 2)) return 'strained';
  return 'stable';
}

function getYieldMultiplier(ecosystem: TragedyEcosystem): number {
  const status = ecosystemStatus(ecosystem);
  if (status === 'flourishing') return 1.5;
  if (status === 'collapsed') return 0.5;
  if (status === 'strained') return 0.8;
  return 1;
}

function cloneRegion(region: TragedyRegion): TragedyRegion {
  return {
    ...region,
    secondaryResources: [...region.secondaryResources],
    ecosystemIds: [...region.ecosystemIds],
  };
}

function cloneEcosystem(ecosystem: TragedyEcosystem): TragedyEcosystem {
  return { ...ecosystem, regionIds: [...ecosystem.regionIds] };
}

function clonePlayer(player: TragedyPlayerState): TragedyPlayerState {
  return {
    ...player,
    resources: cloneResources(player.resources),
    regionsControlled: [...player.regionsControlled],
  };
}

function cloneTradeOffer(offer: TragedyTradeOffer): TragedyTradeOffer {
  return { ...offer, give: { ...offer.give }, receive: { ...offer.receive } };
}

function cloneBoardTile(tile: TragedyBoardTile): TragedyBoardTile {
  return { ...tile, ecosystemIds: [...tile.ecosystemIds] };
}

function applyProduction(state: TragedyState): TragedyState {
  const ecosystems = state.ecosystems.map(cloneEcosystem);
  const ecosystemById = new Map(ecosystems.map((ecosystem) => [ecosystem.id, ecosystem]));
  const players = state.players.map(clonePlayer);
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

function startRound(state: TragedyState): TragedyState {
  const round = state.round + 1;
  const started: TragedyState = {
    ...state,
    round,
    phase: 'playing' as const,
    activeTrades: [],
    submittedActions: makeSubmittedActions(state.players.map((player) => player.id)),
    currentPlayerIndex: 0,
  };
  return applyProduction(started);
}

function resolveTrades(
  players: TragedyPlayerState[],
  submittedByPlayer: Array<{ playerId: string; action: TragedyAction }>,
): TragedyTradeOffer[] {
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const completed: TragedyTradeOffer[] = [];
  const used = new Set<number>();

  for (let i = 0; i < submittedByPlayer.length; i++) {
    const current = submittedByPlayer[i];
    if (!current || current.action.type !== 'offer_trade' || used.has(i)) continue;
    if (!isValidTradeOffer(current.action)) continue;
    for (let j = i + 1; j < submittedByPlayer.length; j++) {
      const other = submittedByPlayer[j];
      if (!other || other.action.type !== 'offer_trade' || used.has(j)) continue;
      if (!isValidTradeOffer(other.action)) continue;
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
      if (
        !canFitTradeReceipt(actionSender.resources, current.action.give, current.action.receive)
      ) {
        continue;
      }
      if (!canFitTradeReceipt(otherSender.resources, other.action.give, other.action.receive)) {
        continue;
      }

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

function resolveRound(state: TragedyState): TragedyState {
  const players = state.players.map(clonePlayer);
  const ecosystems = state.ecosystems.map(cloneEcosystem);
  const ecosystemById = new Map(ecosystems.map((ecosystem) => [ecosystem.id, ecosystem]));
  const submittedByPlayer = players.map((player) => ({
    playerId: player.id,
    action: state.submittedActions[player.id] ?? ({ type: 'pass' } as const),
  }));

  const completedTrades = resolveTrades(players, submittedByPlayer);
  const pressureByEcosystem = new Map<string, number>();

  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    const submitted = submittedByPlayer[index];
    if (!player || !submitted) continue;
    const action = submitted.action;
    if (action.type === 'extract_commons') {
      const ecosystem = ecosystemById.get(action.ecosystemId);
      if (!ecosystem) continue;
      const controlsRegion = ecosystem.regionIds.some((regionId) =>
        player.regionsControlled.includes(regionId),
      );
      if (!controlsRegion) continue;
      const profile = EXTRACTION_PROFILES[action.level];
      const rawYield = Math.max(1, Math.round(profile.yield * getYieldMultiplier(ecosystem)));
      const accepted = addResource(player.resources, ecosystem.resource, rawYield);
      if (accepted > 0) {
        pressureByEcosystem.set(
          ecosystem.id,
          (pressureByEcosystem.get(ecosystem.id) ?? 0) + profile.pressure,
        );
      }
      continue;
    }

    if (action.type === 'build_settlement') {
      if (!action.regionId) continue;
      if (!canAfford(player.resources, SETTLEMENT_COST)) continue;
      const regionTaken = players.some((other) =>
        other.regionsControlled.includes(action.regionId),
      );
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

  const flourishingEcosystems = ecosystems.filter(
    (ecosystem) => ecosystemStatus(ecosystem) === 'flourishing',
  );
  for (const ecosystem of flourishingEcosystems) {
    for (const player of players) {
      if (ecosystem.regionIds.some((regionId) => player.regionsControlled.includes(regionId))) {
        player.influence += 1;
      }
    }
  }

  const rankings = rankPlayers(players);
  const winner = rankings[0]?.id ?? null;

  return {
    ...state,
    players,
    ecosystems,
    activeTrades: completedTrades,
    winner,
  };
}

function advanceOrFinish(state: TragedyState): ActionResult<TragedyState, TragedyAction> {
  const relayMessages: RelayEnvelope[] = [];

  // Halftime mark: when we cross the midpoint
  const halftime = Math.floor(state.config.maxRounds / 2);
  if (state.round === halftime && halftime > 0) {
    const halftimeRelay: RelayEnvelope = {
      type: 'messaging',
      index: -1,
      sender: 'system',
      scope: { kind: 'all' },
      data: {
        body: `Halftime! Round ${state.round} of ${state.config.maxRounds}. Plan your strategy for the second half.`,
      },
      pluginId: 'basic-chat',
      turn: state.round,
      timestamp: Date.now(),
    };
    relayMessages.push(halftimeRelay);
  }

  if (state.round >= state.config.maxRounds) {
    return {
      state: { ...state, phase: 'finished' },
      deadline: { kind: 'none' },
      ...(relayMessages.length > 0 ? { relayMessages } : {}),
    };
  }

  const started = startRound(state);
  return {
    state: started,
    deadline: roundTimeoutDeadline(state.config.turnTimerSeconds),
    ...(relayMessages.length > 0 ? { relayMessages } : {}),
  };
}

function comparePlayerId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rankPlayers(players: TragedyPlayerState[]): TragedyPlayerState[] {
  return [...players].sort((left, right) => {
    if (right.vp !== left.vp) return right.vp - left.vp;
    if (right.influence !== left.influence) return right.influence - left.influence;
    return comparePlayerId(left.id, right.id);
  });
}

export function createInitialState(config: TragedyConfig): TragedyState {
  const regions = getBaseRegions();
  return {
    round: 0,
    phase: 'waiting',
    players: createPlayers(config.playerIds, regions),
    regions,
    boardTiles: getBaseBoardTiles(regions),
    ecosystems: getBaseEcosystems(),
    activeTrades: [],
    submittedActions: makeSubmittedActions(config.playerIds),
    currentPlayerIndex: 0,
    winner: null,
    config,
  };
}

export function validateAction(
  state: TragedyState,
  playerId: string | null,
  action: TragedyAction,
): boolean {
  if (action.type === 'game_start') {
    return playerId === null && state.phase === 'waiting';
  }

  if (action.type === 'round_timeout') {
    return playerId === null && state.phase === 'playing';
  }

  if (playerId === null || state.phase !== 'playing') return false;

  // Check if it's this player's turn
  if (!isPlayersTurn(state, playerId)) return false;

  const player = state.players.find((item) => item.id === playerId);
  if (!player) return false;

  if (action.type === 'build_settlement') {
    const targetRegion = state.regions.find((region) => region.id === action.regionId);
    if (!targetRegion) return false;
    const regionTaken = state.players.some((item) =>
      item.regionsControlled.includes(action.regionId),
    );
    return !regionTaken && canAfford(player.resources, SETTLEMENT_COST);
  }

  if (action.type === 'extract_commons') {
    const ecosystem = state.ecosystems.find((item) => item.id === action.ecosystemId);
    if (!ecosystem || !EXTRACTION_PROFILES[action.level]) return false;
    return ecosystem.regionIds.some((regionId) => player.regionsControlled.includes(regionId));
  }

  if (action.type === 'offer_trade') {
    return (
      action.to !== playerId &&
      state.players.some((item) => item.id === action.to) &&
      isValidTradeOffer(action) &&
      canAfford(player.resources, action.give) &&
      canFitTradeReceipt(player.resources, action.give, action.receive)
    );
  }

  return action.type === 'pass';
}

export function applyAction(
  state: TragedyState,
  playerId: string | null,
  action: TragedyAction,
): ActionResult<TragedyState, TragedyAction> {
  if (action.type === 'game_start') {
    const started = startRound(state);
    return {
      state: started,
      deadline: turnTimeoutDeadline(started.config.turnTimerSeconds),
    };
  }

  if (action.type === 'round_timeout') {
    // Timeout for current player - auto-pass
    const currentPlayer = state.players[state.currentPlayerIndex];
    if (!currentPlayer) {
      return { state };
    }

    const timedOutState: TragedyState = {
      ...state,
      submittedActions: {
        ...state.submittedActions,
        [currentPlayer.id]: { type: 'pass' },
      },
    };

    return advanceTurn(timedOutState);
  }

  if (!playerId) {
    return { state };
  }

  // Validate it's this player's turn
  const currentPlayer = state.players[state.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.id !== playerId) {
    return { state };
  }

  // Record the action and advance to next player
  const nextState: TragedyState = {
    ...state,
    submittedActions: {
      ...state.submittedActions,
      [playerId]: action,
    },
  };

  return advanceTurn(nextState);
}

export interface TragedyPlayerView {
  round: number;
  maxRounds: number;
  phase: TragedyState['phase'];
  you: TragedyPlayerState;
  scoreboard: Array<{ id: string; vp: number; influence: number; regionsControlled: number }>;
  regions: TragedyRegion[];
  boardTiles: TragedyBoardTile[];
  ecosystems: Array<TragedyEcosystem & { status: EcosystemStatus }>;
  activeTrades: TragedyTradeOffer[];
  submitted: boolean;
  isYourTurn: boolean;
  currentPlayer: { id: string; handle: string };
}

export interface TragedySpectatorView {
  round: number;
  maxRounds: number;
  phase: TragedyState['phase'];
  players: Array<TragedyPlayerState & { totalResources: number }>;
  regions: TragedyRegion[];
  boardTiles: TragedyBoardTile[];
  ecosystems: Array<TragedyEcosystem & { status: EcosystemStatus }>;
  activeTrades: TragedyTradeOffer[];
  winner: string | null;
  handles: Record<string, string>;
  relayMessages?: RelayEnvelope[];
}

export function getPlayerView(state: TragedyState, playerId: string): TragedyPlayerView | null {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return null;
  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    you: clonePlayer(player),
    scoreboard: state.players.map((item) => ({
      id: item.id,
      vp: item.vp,
      influence: item.influence,
      regionsControlled: item.regionsControlled.length,
    })),
    regions: state.regions.map(cloneRegion),
    boardTiles: state.boardTiles.map(cloneBoardTile),
    ecosystems: state.ecosystems.map((ecosystem) => ({
      ...cloneEcosystem(ecosystem),
      status: ecosystemStatus(ecosystem),
    })),
    activeTrades: state.activeTrades.map(cloneTradeOffer),
    submitted: state.submittedActions[playerId] !== null,
    isYourTurn: isPlayersTurn(state, playerId),
    currentPlayer: {
      id: state.players[state.currentPlayerIndex]?.id ?? '',
      handle: state.players[state.currentPlayerIndex]?.id ?? 'unknown',
    },
  };
}

export function getSpectatorView(
  state: TragedyState,
  handles: Record<string, string> = {},
  relayMessages: RelayEnvelope[] = [],
): TragedySpectatorView {
  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    players: state.players.map((player) => ({
      ...clonePlayer(player),
      totalResources: totalResources(player.resources),
    })),
    regions: state.regions.map(cloneRegion),
    boardTiles: state.boardTiles.map(cloneBoardTile),
    ecosystems: state.ecosystems.map((ecosystem) => ({
      ...cloneEcosystem(ecosystem),
      status: ecosystemStatus(ecosystem),
    })),
    activeTrades: state.activeTrades.map(cloneTradeOffer),
    winner: state.winner,
    handles,
    relayMessages,
  };
}

export function getOutcome(state: TragedyState): TragedyOutcome {
  const rankings = rankPlayers(state.players).map((player) => ({
    id: player.id,
    vp: player.vp,
    influence: player.influence,
  }));

  return {
    rankings,
    roundsPlayed: state.round,
    flourishingEcosystems: state.ecosystems.filter(
      (ecosystem) => ecosystemStatus(ecosystem) === 'flourishing',
    ).length,
    collapsedEcosystems: state.ecosystems.filter(
      (ecosystem) => ecosystemStatus(ecosystem) === 'collapsed',
    ).length,
  };
}
