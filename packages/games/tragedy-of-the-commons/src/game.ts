import {
  type ActionResult,
  type AttestationV1,
  type GameDeadline,
  type JsonObject,
  keccak256CanonicalJson,
  type RelayEnvelope,
} from '@coordination-games/engine';
import {
  type ExtractionLevel,
  type ResourceInventory,
  type ResourceType,
  type TragedyAction,
  type TragedyBoardTile,
  type TragedyConfig,
  type TragedyEcosystem,
  type TragedyHexRef,
  type TragedyOutcome,
  type TragedyPlayerState,
  type TragedyRegion,
  type TragedyResolvedAction,
  type TragedyRoadLocation,
  type TragedyState,
  type TragedyStructureLocation,
  type TragedyTerrain,
  type TragedyTradeOffer,
  type TragedyV2Action,
  type TragedyV2Config,
  type TragedyV2Intersection,
  type TragedyV2Outcome,
  type TragedyV2PlayerState,
  type TragedyV2Road,
  type TragedyV2SpectatorPlayer,
  type TragedyV2SpectatorView,
  type TragedyV2State,
  type TragedyV2Structure,
  type TragedyV2StructureType,
  type TragedyV2Tile,
  V2_BUILD_COST,
  V2_EXTRACTION_CAPACITY,
  V2_OIL_ENERGY_YIELD,
  V2_SOLAR_ENERGY,
  V2_STRUCTURE_VP,
  V2_TIMBER_TO_ENERGY_RATIO,
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

const INTERSECTION_LOCATIONS: Record<string, { hexes: TragedyHexRef[] }> = {
  northOuter: {
    hexes: [
      { q: 0, r: -2 },
      { q: 1, r: -2 },
      { q: 0, r: -1 },
    ],
  },
  northWest: {
    hexes: [
      { q: -1, r: 0 },
      { q: 0, r: -1 },
      { q: 0, r: 0 },
    ],
  },
  northEast: {
    hexes: [
      { q: 0, r: -1 },
      { q: 1, r: -1 },
      { q: 0, r: 0 },
    ],
  },
  north: {
    hexes: [
      { q: 1, r: -1 },
      { q: 0, r: 0 },
      { q: 1, r: 0 },
    ],
  },
  east: {
    hexes: [
      { q: 0, r: 0 },
      { q: 0, r: 1 },
      { q: 1, r: 0 },
    ],
  },
  south: {
    hexes: [
      { q: 0, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ],
  },
  west: {
    hexes: [
      { q: -1, r: 0 },
      { q: 0, r: 0 },
      { q: -1, r: 1 },
    ],
  },
  westOuter: {
    hexes: [
      { q: -2, r: 0 },
      { q: -2, r: 1 },
      { q: -1, r: 0 },
    ],
  },
  southOuter: {
    hexes: [
      { q: -1, r: 2 },
      { q: 0, r: 1 },
      { q: 0, r: 2 },
    ],
  },
};

const REGION_INTERSECTIONS: Record<string, keyof typeof INTERSECTION_LOCATIONS> = {
  'central-river': 'northWest',
  ironcrest: 'northEast',
  'sunspine-basin': 'north',
  'monsoon-wetland': 'east',
  riverwake: 'south',
  mistbarrow: 'west',
};

const INTERSECTION_RING: Array<keyof typeof INTERSECTION_LOCATIONS> = [
  'northWest',
  'northEast',
  'north',
  'east',
  'south',
  'west',
];

const V2_INTERSECTION_IDS: Array<keyof typeof INTERSECTION_LOCATIONS> = [
  ...INTERSECTION_RING,
  'northOuter',
  'westOuter',
  'southOuter',
];

const EXTRACTION_PROFILES: Record<ExtractionLevel, { yield: number; pressure: number }> = {
  low: { yield: 1, pressure: 1 },
  medium: { yield: 2, pressure: 3 },
  high: { yield: 3, pressure: 6 },
};

const TRUST_PROJECTOR_PLUGIN_ID = 'trust-projector-tragedy';
const ATTESTATION_RELAY_TYPE = 'attestation';

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

function withRelayMessages(
  result: ActionResult<TragedyState, TragedyAction>,
  relayMessages: RelayEnvelope[],
): ActionResult<TragedyState, TragedyAction> {
  if (relayMessages.length === 0) return result;
  return {
    ...result,
    relayMessages: [...(result.relayMessages ?? []), ...relayMessages],
  };
}

function actionPayload(action: TragedyAction): JsonObject {
  if (action.type === 'extract_commons') {
    return { ecosystemId: action.ecosystemId, level: action.level };
  }
  if (action.type === 'build_settlement') {
    return { regionId: action.regionId };
  }
  if (action.type === 'offer_trade') {
    return {
      to: action.to,
      give: jsonResourceBundle(action.give),
      receive: jsonResourceBundle(action.receive),
    };
  }
  return {};
}

function jsonResourceBundle(resources: Partial<ResourceInventory>): JsonObject {
  const out: JsonObject = {};
  for (const resource of RESOURCE_TYPES) {
    const amount = resources[resource];
    if (typeof amount === 'number' && Number.isSafeInteger(amount)) out[resource] = amount;
  }
  return out;
}

function createActionAttestationRelay(input: {
  readonly state: TragedyState;
  readonly player: TragedyPlayerState;
  readonly action: TragedyAction;
  readonly note?: string;
}): RelayEnvelope<AttestationV1> {
  const data: JsonObject = {
    gameType: 'tragedy-of-the-commons',
    round: input.state.round,
    actor: input.player.id,
    actionType: input.action.type,
    action: actionPayload(input.action),
    before: {
      resources: jsonResourceBundle(input.player.resources),
      influence: input.player.influence,
      vp: input.player.vp,
      regionsControlled: [...input.player.regionsControlled],
    },
  };
  const attestation: AttestationV1 = {
    schemaVersion: 'attestation/v1',
    id: keccak256CanonicalJson({
      gameType: 'tragedy-of-the-commons',
      round: input.state.round,
      subject: input.player.id,
      claimType: 'tragedy.round_choice.v1',
      data,
    }),
    issuer: 'tragedy-of-the-commons:system',
    issuerKind: 'system',
    subject: input.player.id,
    claim: { type: 'tragedy.round_choice.v1', data },
    confidence: 1,
    round: input.state.round,
    ...(input.note ? { note: input.note } : {}),
  };
  return {
    type: ATTESTATION_RELAY_TYPE,
    index: -1,
    sender: 'system',
    scope: { kind: 'all' },
    data: attestation,
    pluginId: TRUST_PROJECTOR_PLUGIN_ID,
    turn: input.state.round,
    timestamp: Date.now(),
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
      secondaryResources: ['fish'],
      ecosystemIds: ['sunspine-river'],
    },
    {
      id: 'central-river',
      name: 'Central River',
      primaryResource: 'water',
      secondaryResources: ['fish'],
      ecosystemIds: ['sunspine-river', 'silver-tide-wetland'],
    },
    {
      id: 'sunspine-basin',
      name: 'East Oil Field',
      primaryResource: 'energy',
      secondaryResources: ['ore'],
      ecosystemIds: ['east-oil-field'],
    },
    {
      id: 'ironcrest',
      name: 'Ironcrest',
      primaryResource: 'ore',
      secondaryResources: ['energy'],
      ecosystemIds: ['ironcrest-vein'],
    },
    {
      id: 'monsoon-wetland',
      name: 'Monsoon Wetland',
      primaryResource: 'fish',
      secondaryResources: ['water'],
      ecosystemIds: ['silver-tide-wetland'],
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
      regionIds: ['mistbarrow'],
      health: 16,
      maxHealth: 20,
      collapseThreshold: 4,
      flourishThreshold: 16,
    },
    {
      id: 'sunspine-river',
      name: 'Sunspine River',
      kind: 'river',
      resource: 'water',
      regionIds: ['riverwake', 'central-river'],
      health: 15,
      maxHealth: 20,
      collapseThreshold: 4,
      flourishThreshold: 16,
    },
    {
      id: 'silver-tide-wetland',
      name: 'Silver Tide Wetland',
      kind: 'wetland',
      resource: 'fish',
      regionIds: ['monsoon-wetland', 'central-river'],
      health: 14,
      maxHealth: 20,
      collapseThreshold: 4,
      flourishThreshold: 16,
    },
    {
      id: 'ironcrest-vein',
      name: 'Ironcrest Vein',
      kind: 'mineral',
      resource: 'ore',
      regionIds: ['ironcrest'],
      health: 12,
      maxHealth: 20,
      collapseThreshold: 4,
      flourishThreshold: 16,
    },
    {
      id: 'east-oil-field',
      name: 'East Oil Field',
      kind: 'oil-field',
      resource: 'energy',
      regionIds: ['sunspine-basin'],
      health: 12,
      maxHealth: 20,
      collapseThreshold: 4,
      flourishThreshold: 16,
    },
  ];
}

function terrainForRegion(region: TragedyRegion): TragedyTerrain {
  if (region.primaryResource === 'timber') return 'forest';
  if (region.primaryResource === 'ore') return 'mountains';
  if (region.primaryResource === 'energy') return 'oil-field';
  if (region.primaryResource === 'water' || region.primaryResource === 'fish') return 'rivers';
  return 'wetland';
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
    { q: 0, r: 0, regionId: 'central-river' },
    { q: -1, r: 0, regionId: 'mistbarrow' },
    { q: -1, r: 1, regionId: 'riverwake' },
    { q: 1, r: -1, regionId: 'sunspine-basin' },
    { q: 0, r: -1, regionId: 'ironcrest' },
    { q: 1, r: 0, regionId: 'monsoon-wetland' },
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
    { q: -2, r: 2, terrain: 'wetland', ecosystemIds: ['sunspine-river'] },
    { q: -1, r: -1, terrain: 'forest', ecosystemIds: ['old-growth-ring'] },
    { q: -1, r: 2, terrain: 'wetland', ecosystemIds: ['sunspine-river', 'silver-tide-wetland'] },
    { q: 0, r: -2, terrain: 'mountains', ecosystemIds: ['ironcrest-vein'] },
    { q: 0, r: 1, terrain: 'rivers', ecosystemIds: ['sunspine-river'] },
    { q: 0, r: 2, terrain: 'wetland', ecosystemIds: ['silver-tide-wetland'] },
    { q: 1, r: -2, terrain: 'mountains', ecosystemIds: ['ironcrest-vein'] },
    { q: 1, r: 1, terrain: 'wetland', ecosystemIds: ['silver-tide-wetland'] },
    { q: 2, r: -2, terrain: 'oil-field', ecosystemIds: ['east-oil-field'] },
    { q: 2, r: -1, terrain: 'rivers', ecosystemIds: ['sunspine-river'] },
    { q: 2, r: 0, terrain: 'wetland', ecosystemIds: ['silver-tide-wetland'] },
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

function commonsHealthPercent(ecosystems: readonly TragedyEcosystem[]): number {
  const totals = ecosystems.reduce(
    (acc, ecosystem) => ({
      health: acc.health + ecosystem.health,
      maxHealth: acc.maxHealth + ecosystem.maxHealth,
    }),
    { health: 0, maxHealth: 0 },
  );
  if (totals.maxHealth <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((totals.health / totals.maxHealth) * 100)));
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

function cloneHexes(hexes: readonly TragedyHexRef[]): TragedyHexRef[] {
  return hexes.map((hex) => ({ q: hex.q, r: hex.r }));
}

function structureTypeForRegionIndex(index: number): TragedyStructureLocation['type'] {
  return index === 0 ? 'camp' : 'village';
}

function roadKey(from: string, to: string): string {
  return from < to ? `${from}:${to}` : `${to}:${from}`;
}

function ringRoadPath(
  from: keyof typeof INTERSECTION_LOCATIONS,
  to: keyof typeof INTERSECTION_LOCATIONS,
): Array<[keyof typeof INTERSECTION_LOCATIONS, keyof typeof INTERSECTION_LOCATIONS]> {
  if (from === to) return [];
  const fromIndex = INTERSECTION_RING.indexOf(from);
  const toIndex = INTERSECTION_RING.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return [];

  const clockwiseSteps =
    (toIndex - fromIndex + INTERSECTION_RING.length) % INTERSECTION_RING.length;
  const counterSteps = (fromIndex - toIndex + INTERSECTION_RING.length) % INTERSECTION_RING.length;
  const direction = clockwiseSteps <= counterSteps ? 1 : -1;
  const steps = Math.min(clockwiseSteps, counterSteps);
  const edges: Array<[keyof typeof INTERSECTION_LOCATIONS, keyof typeof INTERSECTION_LOCATIONS]> =
    [];

  let currentIndex = fromIndex;
  for (let step = 0; step < steps; step += 1) {
    const nextIndex =
      (currentIndex + direction + INTERSECTION_RING.length) % INTERSECTION_RING.length;
    const current = INTERSECTION_RING[currentIndex];
    const next = INTERSECTION_RING[nextIndex];
    if (current && next) edges.push([current, next]);
    currentIndex = nextIndex;
  }
  return edges;
}

function derivePlayerGeometry(player: TragedyPlayerState): {
  structureLocations: TragedyStructureLocation[];
  roadLocations: TragedyRoadLocation[];
} {
  const locatedRegions = player.regionsControlled.flatMap((regionId, index) => {
    const intersectionId = REGION_INTERSECTIONS[regionId];
    const intersection = intersectionId ? INTERSECTION_LOCATIONS[intersectionId] : undefined;
    if (!intersectionId || !intersection) return [];
    return [{ index, intersectionId, intersection, regionId }];
  });

  const structureLocations = locatedRegions.map(
    ({ index, intersection, regionId }): TragedyStructureLocation => ({
      type: structureTypeForRegionIndex(index),
      hexes: cloneHexes(intersection.hexes),
      regionId,
      regionIds: [regionId],
    }),
  );

  const roadLocations: TragedyRoadLocation[] = [];
  const usedRoads = new Set<string>();
  for (let index = 1; index < locatedRegions.length; index += 1) {
    const previous = locatedRegions[index - 1];
    const current = locatedRegions[index];
    if (!previous || !current) continue;
    for (const [fromId, toId] of ringRoadPath(previous.intersectionId, current.intersectionId)) {
      const key = roadKey(fromId, toId);
      if (usedRoads.has(key)) continue;
      usedRoads.add(key);
      const from = INTERSECTION_LOCATIONS[fromId];
      const to = INTERSECTION_LOCATIONS[toId];
      if (!from || !to) continue;
      roadLocations.push({
        from: { hexes: cloneHexes(from.hexes) },
        to: { hexes: cloneHexes(to.hexes) },
        type: 'straight',
        regionIds: [previous.regionId, current.regionId],
      });
    }
  }

  return { structureLocations, roadLocations };
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
  const lastResolvedActions: TragedyResolvedAction[] = submittedByPlayer.map((submitted) => ({
    playerId: submitted.playerId,
    action: submitted.action,
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
    lastResolvedActions,
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
    lastResolvedActions: [],
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

    return withRelayMessages(advanceTurn(timedOutState), [
      createActionAttestationRelay({
        state,
        player: currentPlayer,
        action: { type: 'pass' },
        note: 'Round timer expired; system recorded a pass for the current player.',
      }),
    ]);
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

  return withRelayMessages(advanceTurn(nextState), [
    createActionAttestationRelay({ state, player: currentPlayer, action }),
  ]);
}

export interface TragedyPlayerView {
  round: number;
  maxRounds: number;
  phase: TragedyState['phase'];
  you: TragedyPlayerState & {
    structureLocations: TragedyStructureLocation[];
    roadLocations: TragedyRoadLocation[];
  };
  scoreboard: Array<{ id: string; vp: number; influence: number; regionsControlled: number }>;
  regions: TragedyRegion[];
  boardTiles: TragedyBoardTile[];
  ecosystems: Array<TragedyEcosystem & { status: EcosystemStatus }>;
  activeTrades: TragedyTradeOffer[];
  lastResolvedActions: TragedyResolvedAction[];
  submitted: boolean;
  isYourTurn: boolean;
  currentPlayer: { id: string; handle: string };
}

export interface TragedySpectatorView {
  round: number;
  maxRounds: number;
  phase: TragedyState['phase'];
  players: Array<
    TragedyPlayerState & {
      totalResources: number;
      structureLocations: TragedyStructureLocation[];
      roadLocations: TragedyRoadLocation[];
    }
  >;
  regions: TragedyRegion[];
  boardTiles: TragedyBoardTile[];
  ecosystems: Array<TragedyEcosystem & { status: EcosystemStatus }>;
  activeTrades: TragedyTradeOffer[];
  lastResolvedActions: TragedyResolvedAction[];
  winner: string | null;
  handles: Record<string, string>;
  relayMessages?: RelayEnvelope[];
  commonsHealthPercent: number;
}

export function getPlayerView(state: TragedyState, playerId: string): TragedyPlayerView | null {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return null;
  const playerGeometry = derivePlayerGeometry(player);
  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    you: {
      ...clonePlayer(player),
      ...playerGeometry,
    },
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
    lastResolvedActions: state.lastResolvedActions.map((resolved) => ({
      playerId: resolved.playerId,
      action: { ...resolved.action },
    })),
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
      ...derivePlayerGeometry(player),
      totalResources: totalResources(player.resources),
    })),
    regions: state.regions.map(cloneRegion),
    boardTiles: state.boardTiles.map(cloneBoardTile),
    ecosystems: state.ecosystems.map((ecosystem) => ({
      ...cloneEcosystem(ecosystem),
      status: ecosystemStatus(ecosystem),
    })),
    activeTrades: state.activeTrades.map(cloneTradeOffer),
    lastResolvedActions: state.lastResolvedActions.map((resolved) => ({
      playerId: resolved.playerId,
      action: { ...resolved.action },
    })),
    winner: state.winner,
    handles,
    relayMessages,
    commonsHealthPercent: commonsHealthPercent(state.ecosystems),
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
    commonsHealthPercent: commonsHealthPercent(state.ecosystems),
  };
}

// ════════════════════════════════════════════════════════════════
// V2 authoritative engine — tile/intersection/road/structure model.
// The v0 exports above remain unchanged for plugin compatibility.
// ════════════════════════════════════════════════════════════════

type V2SubmittedActions = Record<string, TragedyV2Action | null>;

const V2_RECOVERY_PER_ROUND = 2;
const V2_EXTRACTION_UNITS: Record<ExtractionLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const V2_TILE_SPECS: Array<{
  q: number;
  r: number;
  terrain: TragedyTerrain;
  ecosystemIds: string[];
}> = [
  { q: 0, r: 0, terrain: 'rivers', ecosystemIds: ['sunspine-river', 'silver-tide-wetland'] },
  { q: -1, r: 0, terrain: 'forest', ecosystemIds: ['old-growth-ring'] },
  { q: -1, r: 1, terrain: 'rivers', ecosystemIds: ['sunspine-river'] },
  { q: 1, r: -1, terrain: 'oil-field', ecosystemIds: ['east-oil-field'] },
  { q: 0, r: -1, terrain: 'mountains', ecosystemIds: ['ironcrest-vein'] },
  { q: 1, r: 0, terrain: 'wetland', ecosystemIds: ['silver-tide-wetland'] },
  { q: -2, r: 0, terrain: 'forest', ecosystemIds: ['old-growth-ring'] },
  { q: -2, r: 1, terrain: 'forest', ecosystemIds: ['old-growth-ring'] },
  { q: -2, r: 2, terrain: 'wetland', ecosystemIds: ['sunspine-river'] },
  { q: -1, r: -1, terrain: 'forest', ecosystemIds: ['old-growth-ring'] },
  { q: -1, r: 2, terrain: 'wetland', ecosystemIds: ['sunspine-river', 'silver-tide-wetland'] },
  { q: 0, r: -2, terrain: 'mountains', ecosystemIds: ['ironcrest-vein'] },
  { q: 0, r: 1, terrain: 'rivers', ecosystemIds: ['sunspine-river'] },
  { q: 0, r: 2, terrain: 'wetland', ecosystemIds: ['silver-tide-wetland'] },
  { q: 1, r: -2, terrain: 'mountains', ecosystemIds: ['ironcrest-vein'] },
  { q: 1, r: 1, terrain: 'wetland', ecosystemIds: ['silver-tide-wetland'] },
  { q: 2, r: -2, terrain: 'oil-field', ecosystemIds: ['east-oil-field'] },
  { q: 2, r: -1, terrain: 'rivers', ecosystemIds: ['sunspine-river'] },
  { q: 2, r: 0, terrain: 'wetland', ecosystemIds: ['silver-tide-wetland'] },
];

function v2RoundTimeoutDeadline(turnTimerSeconds: number): GameDeadline<TragedyV2Action> {
  return {
    kind: 'absolute',
    at: Date.now() + turnTimerSeconds * 1000,
    action: { type: 'round_timeout' },
  };
}

function makeV2SubmittedActions(playerIds: string[]): V2SubmittedActions {
  return Object.fromEntries(playerIds.map((id) => [id, null]));
}

function v2SubmittedActions(state: TragedyV2State): V2SubmittedActions {
  return state.submittedActions as unknown as V2SubmittedActions;
}

function v2LastResolvedAction(playerId: string, action: TragedyV2Action): TragedyResolvedAction {
  return { playerId, action: action as unknown as TragedyAction };
}

function v2TerrainResource(terrain: TragedyTerrain): ResourceType {
  if (terrain === 'forest') return 'timber';
  if (terrain === 'mountains') return 'ore';
  if (terrain === 'oil-field') return 'energy';
  if (terrain === 'wetland') return 'fish';
  return 'water';
}

function v2TileStatus(input: {
  health: number;
  maxHealth: number;
  collapseThreshold: number;
  flourishThreshold: number;
}): TragedyV2Tile['status'] {
  if (input.health <= input.collapseThreshold) return 'collapsed';
  if (input.health >= input.flourishThreshold) return 'flourishing';
  if (input.health <= Math.ceil(input.maxHealth / 2)) return 'strained';
  return 'stable';
}

function createV2Tiles(ecosystems: TragedyEcosystem[]): TragedyV2Tile[] {
  const ecosystemById = new Map(ecosystems.map((ecosystem) => [ecosystem.id, ecosystem]));
  return V2_TILE_SPECS.map((spec) => {
    const primaryResource = v2TerrainResource(spec.terrain);
    const ecosystem =
      spec.ecosystemIds
        .map((id) => ecosystemById.get(id))
        .find((item): item is TragedyEcosystem => item?.resource === primaryResource) ??
      spec.ecosystemIds.map((id) => ecosystemById.get(id)).find(Boolean);
    const health = ecosystem?.health ?? 14;
    const maxHealth = ecosystem?.maxHealth ?? 20;
    const collapseThreshold = ecosystem?.collapseThreshold ?? 4;
    const flourishThreshold = ecosystem?.flourishThreshold ?? 16;
    return {
      id: `${spec.q},${spec.r}`,
      q: spec.q,
      r: spec.r,
      terrain: spec.terrain,
      primaryResource,
      ecosystemIds: [...spec.ecosystemIds],
      health,
      maxHealth,
      collapseThreshold,
      flourishThreshold,
      status: v2TileStatus({ health, maxHealth, collapseThreshold, flourishThreshold }),
    };
  }).sort((left, right) => left.r - right.r || left.q - right.q);
}

function createV2Intersections(): TragedyV2Intersection[] {
  return V2_INTERSECTION_IDS.map((id) => {
    const location = INTERSECTION_LOCATIONS[id];
    if (!location) throw new Error(`missing V2 intersection location: ${id}`);
    return {
      id,
      hexes: cloneHexes(location.hexes),
    };
  });
}

function v2SeededHash(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomizedV2PlayerOrder(playerIds: string[], seed: string): string[] {
  return [...playerIds].sort((left, right) => {
    const leftHash = v2SeededHash(`${seed}:${left}`);
    const rightHash = v2SeededHash(`${seed}:${right}`);
    return leftHash - rightHash || comparePlayerId(left, right);
  });
}

function createV2Players(playerIds: string[]): {
  players: TragedyV2PlayerState[];
  structures: TragedyV2Structure[];
} {
  return {
    structures: [],
    players: playerIds.map((id) => ({
      id,
      resources: cloneResources(STARTING_RESOURCES),
      influence: 0,
      vp: 0,
      ownedStructureIds: [],
      ownedRoadIds: [],
    })),
  };
}

function cloneV2Tile(tile: TragedyV2Tile): TragedyV2Tile {
  return { ...tile, ecosystemIds: [...tile.ecosystemIds] };
}

function cloneV2Intersection(intersection: TragedyV2Intersection): TragedyV2Intersection {
  return { ...intersection, hexes: cloneHexes(intersection.hexes) };
}

function cloneV2Road(road: TragedyV2Road): TragedyV2Road {
  return { ...road };
}

function cloneV2Structure(structure: TragedyV2Structure): TragedyV2Structure {
  return { ...structure };
}

function cloneV2Player(player: TragedyV2PlayerState): TragedyV2PlayerState {
  return {
    ...player,
    resources: cloneResources(player.resources),
    ownedStructureIds: [...player.ownedStructureIds],
    ownedRoadIds: [...player.ownedRoadIds],
  };
}

function averageV2TileHealthPercent(tiles: readonly TragedyV2Tile[]): number {
  const totals = tiles.reduce(
    (acc, tile) => ({
      health: acc.health + tile.health,
      maxHealth: acc.maxHealth + tile.maxHealth,
    }),
    { health: 0, maxHealth: 0 },
  );
  if (totals.maxHealth <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((totals.health / totals.maxHealth) * 100)));
}

function v2HexKey(hex: TragedyHexRef): string {
  return `${hex.q},${hex.r}`;
}

function v2SharedHexCount(left: TragedyV2Intersection, right: TragedyV2Intersection): number {
  const rightHexes = new Set(right.hexes.map(v2HexKey));
  return left.hexes.filter((hex) => rightHexes.has(v2HexKey(hex))).length;
}

function v2TileDistance(left: TragedyV2Tile, right: TragedyV2Tile): number {
  const dq = left.q - right.q;
  const dr = left.r - right.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

function v2RoadKey(fromIntersectionId: string, toIntersectionId: string): string {
  return fromIntersectionId < toIntersectionId
    ? `${fromIntersectionId}:${toIntersectionId}`
    : `${toIntersectionId}:${fromIntersectionId}`;
}

function v2OwnedNetworkIntersections(
  player: TragedyV2PlayerState,
  roads: readonly TragedyV2Road[],
  structures: readonly TragedyV2Structure[],
): Set<string> {
  const network = new Set<string>();
  for (const structure of structures) {
    if (structure.ownerId === player.id) network.add(structure.intersectionId);
  }
  for (const road of roads) {
    if (road.ownerId !== player.id) continue;
    network.add(road.fromIntersectionId);
    network.add(road.toIntersectionId);
  }
  return network;
}

function v2AllowedResources(tile: TragedyV2Tile): ResourceType[] {
  if (tile.terrain === 'rivers' || tile.terrain === 'wetland') return ['fish', 'water'];
  if (tile.terrain === 'oil-field') return ['energy'];
  return [tile.primaryResource];
}

function v2StructureAdjacentToTile(
  structure: TragedyV2Structure,
  intersectionsById: Map<string, TragedyV2Intersection>,
  tile: TragedyV2Tile,
): boolean {
  const intersection = intersectionsById.get(structure.intersectionId);
  return intersection?.hexes.some((hex) => hex.q === tile.q && hex.r === tile.r) ?? false;
}

function v2NextUpgradeType(structureType: TragedyV2StructureType): TragedyV2StructureType | null {
  if (structureType === 'camp') return 'village';
  if (structureType === 'village') return 'city';
  if (structureType === 'solar-farm') return 'solar-array';
  return null;
}

function v2FindExtractionStructure(
  state: TragedyV2State,
  player: TragedyV2PlayerState,
  tile: TragedyV2Tile,
  units: number,
): TragedyV2Structure | undefined {
  const intersectionsById = new Map(
    state.intersections.map((intersection) => [intersection.id, intersection]),
  );
  return state.structures.find((structure) => {
    if (structure.ownerId !== player.id) return false;
    const capacity = V2_EXTRACTION_CAPACITY[structure.type];
    if (capacity <= 0 || structure.extractionsThisRound + units > capacity) return false;
    return v2StructureAdjacentToTile(structure, intersectionsById, tile);
  });
}

function validateV2BuildRoad(
  state: TragedyV2State,
  player: TragedyV2PlayerState,
  action: Extract<TragedyV2Action, { type: 'build_road' }>,
): boolean {
  const roadCost = V2_BUILD_COST.road ?? {};
  if (!canAfford(player.resources, roadCost)) return false;
  if (action.fromIntersectionId === action.toIntersectionId) return false;
  const intersectionsById = new Map(
    state.intersections.map((intersection) => [intersection.id, intersection]),
  );
  const from = intersectionsById.get(action.fromIntersectionId);
  const to = intersectionsById.get(action.toIntersectionId);
  if (!from || !to || v2SharedHexCount(from, to) !== 2) return false;
  const newRoadKey = v2RoadKey(action.fromIntersectionId, action.toIntersectionId);
  if (
    state.roads.some(
      (road) => v2RoadKey(road.fromIntersectionId, road.toIntersectionId) === newRoadKey,
    )
  ) {
    return false;
  }
  const network = v2OwnedNetworkIntersections(player, state.roads, state.structures);
  return network.has(action.fromIntersectionId) || network.has(action.toIntersectionId);
}

function validateV2StartingCamp(
  state: TragedyV2State,
  player: TragedyV2PlayerState,
  action: Extract<TragedyV2Action, { type: 'place_starting_camp' }>,
): boolean {
  if (player.ownedStructureIds.length > 0) return false;
  const intersection = state.intersections.find((item) => item.id === action.intersectionId);
  if (!intersection || intersection.occupantStructureId) return false;
  const intersectionsById = new Map(state.intersections.map((item) => [item.id, item]));
  return state.structures.every((structure) => {
    const existing = intersectionsById.get(structure.intersectionId);
    return !existing || v2SharedHexCount(intersection, existing) < 2;
  });
}

function placeV2StartingCamp(
  state: TragedyV2State,
  playerId: string,
  action: Extract<TragedyV2Action, { type: 'place_starting_camp' }>,
): ActionResult<TragedyV2State, TragedyV2Action> {
  const players = state.players.map(cloneV2Player);
  const intersections = state.intersections.map(cloneV2Intersection);
  const structures = state.structures.map(cloneV2Structure);
  const player = players.find((item) => item.id === playerId);
  const intersection = intersections.find((item) => item.id === action.intersectionId);
  if (!player || !intersection) return { state };
  const structureId = `${playerId}-starter-camp`;
  intersection.occupantStructureId = structureId;
  player.ownedStructureIds.push(structureId);
  player.vp += V2_STRUCTURE_VP.camp;
  structures.push({
    id: structureId,
    ownerId: playerId,
    intersectionId: action.intersectionId,
    type: 'camp',
    extractionsThisRound: 0,
  });
  const placedState: TragedyV2State = { ...state, players, intersections, structures };
  const allPlaced = players.every((item) => item.ownedStructureIds.length > 0);
  if (allPlaced) {
    const started = startV2Round(placedState);
    return { state: started, deadline: v2RoundTimeoutDeadline(started.config.turnTimerSeconds) };
  }
  const nextIndex = players.findIndex((item) => item.ownedStructureIds.length === 0);
  return {
    state: {
      ...placedState,
      currentPlayerIndex: nextIndex >= 0 ? nextIndex : state.currentPlayerIndex,
    },
  };
}

function validateV2BuildStructure(
  state: TragedyV2State,
  player: TragedyV2PlayerState,
  action: Extract<TragedyV2Action, { type: 'build_structure' }>,
): boolean {
  if (action.structureType !== 'camp' && action.structureType !== 'solar-farm') return false;
  const structureCost = V2_BUILD_COST[action.structureType] ?? {};
  if (!canAfford(player.resources, structureCost)) return false;
  const intersection = state.intersections.find((item) => item.id === action.intersectionId);
  if (!intersection || intersection.occupantStructureId) return false;
  const hasStarterException =
    player.ownedStructureIds.length === 0 && action.structureType === 'camp';
  if (hasStarterException) return true;
  return state.roads.some(
    (road) =>
      road.ownerId === player.id &&
      (road.fromIntersectionId === action.intersectionId ||
        road.toIntersectionId === action.intersectionId),
  );
}

function validateV2ExtractTile(
  state: TragedyV2State,
  player: TragedyV2PlayerState,
  action: Extract<TragedyV2Action, { type: 'extract_tile' }>,
): boolean {
  const tile = state.tiles.find((item) => item.id === action.tileId);
  if (!tile || tile.status === 'collapsed' || !EXTRACTION_PROFILES[action.level]) return false;
  if (!v2AllowedResources(tile).includes(action.resource)) return false;
  const resourceMatchesTile = tile.terrain === 'oil-field' ? action.resource === 'energy' : true;
  if (!resourceMatchesTile) return false;
  const units = V2_EXTRACTION_UNITS[action.level];
  return Boolean(v2FindExtractionStructure(state, player, tile, units));
}

export function createV2InitialState(config: TragedyV2Config): TragedyV2State {
  const ecosystems = getBaseEcosystems();
  const intersections = createV2Intersections();
  const orderedPlayerIds = randomizedV2PlayerOrder(config.playerIds, config.seed);
  const { players, structures } = createV2Players(orderedPlayerIds);
  return {
    round: 0,
    phase: 'waiting',
    players,
    tiles: createV2Tiles(ecosystems),
    intersections,
    roads: [],
    structures,
    ecosystems,
    activeTrades: [],
    lastResolvedActions: [],
    submittedActions: makeV2SubmittedActions(config.playerIds) as unknown as Record<
      string,
      TragedyAction | null
    >,
    currentPlayerIndex: 0,
    winner: null,
    config,
  };
}

export function applyV2Production(state: TragedyV2State): TragedyV2State {
  const players = state.players.map(cloneV2Player);
  const playersById = new Map(players.map((player) => [player.id, player]));
  const structures = state.structures.map((structure) => {
    const clone = cloneV2Structure(structure);
    clone.extractionsThisRound = 0;
    const solarEnergy = V2_SOLAR_ENERGY[clone.type];
    if (solarEnergy > 0) {
      const owner = playersById.get(clone.ownerId);
      if (owner) addResource(owner.resources, 'energy', solarEnergy);
    }
    return clone;
  });
  return { ...state, players, structures };
}

function startV2Round(state: TragedyV2State): TragedyV2State {
  const started: TragedyV2State = {
    ...state,
    round: state.round + 1,
    phase: 'playing',
    activeTrades: [],
    submittedActions: makeV2SubmittedActions(
      state.players.map((player) => player.id),
    ) as unknown as Record<string, TragedyAction | null>,
    currentPlayerIndex: 0,
  };
  return applyV2Production(started);
}

export function validateV2Action(
  state: TragedyV2State,
  playerId: string | null,
  action: TragedyV2Action,
): boolean {
  if (action.type === 'game_start') {
    return playerId === null && state.phase === 'waiting';
  }
  if (action.type === 'round_timeout') return playerId === null && state.phase === 'playing';
  if (playerId === null) return false;
  if (state.players[state.currentPlayerIndex]?.id !== playerId) return false;
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return false;
  if (action.type === 'place_starting_camp') {
    return state.phase === 'waiting' && validateV2StartingCamp(state, player, action);
  }
  if (state.phase !== 'playing') return false;

  if (action.type === 'build_road') return validateV2BuildRoad(state, player, action);
  if (action.type === 'build_structure') return validateV2BuildStructure(state, player, action);
  if (action.type === 'upgrade_structure') {
    const structure = state.structures.find((item) => item.id === action.structureId);
    if (!structure || structure.ownerId !== player.id) return false;
    const nextType = v2NextUpgradeType(structure.type);
    const upgradeCost = nextType ? V2_BUILD_COST[nextType] : undefined;
    return Boolean(upgradeCost && canAfford(player.resources, upgradeCost));
  }
  if (action.type === 'extract_tile') return validateV2ExtractTile(state, player, action);
  if (action.type === 'convert_timber_to_energy') {
    return (
      Number.isSafeInteger(action.amount) &&
      action.amount > 0 &&
      player.resources.timber >= action.amount * V2_TIMBER_TO_ENERGY_RATIO
    );
  }
  if (action.type === 'offer_trade') {
    return (
      action.to !== playerId &&
      state.players.some((item) => item.id === action.to) &&
      isValidResourceBundle(action.give) &&
      isValidResourceBundle(action.receive) &&
      hasPositiveResource(action.give) &&
      hasPositiveResource(action.receive) &&
      canAfford(player.resources, action.give) &&
      canFitTradeReceipt(player.resources, action.give, action.receive)
    );
  }
  return action.type === 'pass';
}

function resolveV2Trades(
  players: TragedyV2PlayerState[],
  submittedByPlayer: Array<{ playerId: string; action: TragedyV2Action }>,
): TragedyTradeOffer[] {
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const completed: TragedyTradeOffer[] = [];
  const used = new Set<number>();
  for (let i = 0; i < submittedByPlayer.length; i += 1) {
    const current = submittedByPlayer[i];
    if (!current || current.action.type !== 'offer_trade' || used.has(i)) continue;
    for (let j = i + 1; j < submittedByPlayer.length; j += 1) {
      const other = submittedByPlayer[j];
      if (!other || other.action.type !== 'offer_trade' || used.has(j)) continue;
      if (current.playerId === other.playerId) continue;
      if (current.action.to !== other.playerId || other.action.to !== current.playerId) continue;
      if (!inventoryEquals(current.action.give, other.action.receive)) continue;
      if (!inventoryEquals(current.action.receive, other.action.give)) continue;
      const currentPlayer = playerMap.get(current.playerId);
      const otherPlayer = playerMap.get(other.playerId);
      if (!currentPlayer || !otherPlayer) continue;
      if (!canAfford(currentPlayer.resources, current.action.give)) continue;
      if (!canAfford(otherPlayer.resources, other.action.give)) continue;
      if (
        !canFitTradeReceipt(currentPlayer.resources, current.action.give, current.action.receive)
      ) {
        continue;
      }
      if (!canFitTradeReceipt(otherPlayer.resources, other.action.give, other.action.receive)) {
        continue;
      }
      deductCost(currentPlayer.resources, current.action.give);
      deductCost(otherPlayer.resources, other.action.give);
      for (const [resource, amount] of Object.entries(current.action.receive)) {
        currentPlayer.resources[resource as ResourceType] += amount ?? 0;
      }
      for (const [resource, amount] of Object.entries(other.action.receive)) {
        otherPlayer.resources[resource as ResourceType] += amount ?? 0;
      }
      currentPlayer.influence += 1;
      otherPlayer.influence += 1;
      completed.push(
        {
          to: current.action.to,
          give: { ...current.action.give },
          receive: { ...current.action.receive },
        },
        {
          to: other.action.to,
          give: { ...other.action.give },
          receive: { ...other.action.receive },
        },
      );
      used.add(i);
      used.add(j);
      break;
    }
  }
  return completed;
}

export function resolveV2Round(state: TragedyV2State): TragedyV2State {
  const players = state.players.map(cloneV2Player);
  const tiles = state.tiles.map(cloneV2Tile);
  const intersections = state.intersections.map(cloneV2Intersection);
  const roads = state.roads.map(cloneV2Road);
  const structures = state.structures.map(cloneV2Structure);
  const playersById = new Map(players.map((player) => [player.id, player]));
  const structuresById = new Map(structures.map((structure) => [structure.id, structure]));
  const submitted = v2SubmittedActions(state);
  const submittedByPlayer = players.map((player) => ({
    playerId: player.id,
    action: submitted[player.id] ?? ({ type: 'pass' } as const),
  }));
  const lastResolvedActions = submittedByPlayer.map((item) =>
    v2LastResolvedAction(item.playerId, item.action),
  );
  const activeTrades = resolveV2Trades(players, submittedByPlayer);
  const pressureByTile = new Map<string, number>();

  for (const submittedAction of submittedByPlayer) {
    const player = playersById.get(submittedAction.playerId);
    if (!player) continue;
    const action = submittedAction.action;

    if (action.type === 'build_road') {
      const validationState = { ...state, players, tiles, intersections, roads, structures };
      if (!validateV2BuildRoad(validationState, player, action)) continue;
      deductCost(player.resources, V2_BUILD_COST.road ?? {});
      const road: TragedyV2Road = {
        id: `road-${v2RoadKey(action.fromIntersectionId, action.toIntersectionId)}`,
        ownerId: player.id,
        fromIntersectionId: action.fromIntersectionId,
        toIntersectionId: action.toIntersectionId,
        type: 'straight',
      };
      roads.push(road);
      player.ownedRoadIds.push(road.id);
      player.influence += 1;
      continue;
    }

    if (action.type === 'build_structure') {
      const validationState = { ...state, players, tiles, intersections, roads, structures };
      if (!validateV2BuildStructure(validationState, player, action)) continue;
      deductCost(player.resources, V2_BUILD_COST[action.structureType] ?? {});
      const structure: TragedyV2Structure = {
        id: `${player.id}-${action.structureType}-${action.intersectionId}`,
        ownerId: player.id,
        intersectionId: action.intersectionId,
        type: action.structureType,
        extractionsThisRound: 0,
      };
      structures.push(structure);
      structuresById.set(structure.id, structure);
      player.ownedStructureIds.push(structure.id);
      const intersection = intersections.find((item) => item.id === action.intersectionId);
      if (intersection) intersection.occupantStructureId = structure.id;
      player.vp += V2_STRUCTURE_VP[action.structureType];
      player.influence += 1;
      continue;
    }

    if (action.type === 'upgrade_structure') {
      const structure = structuresById.get(action.structureId);
      if (!structure || structure.ownerId !== player.id) continue;
      const nextType = v2NextUpgradeType(structure.type);
      const upgradeCost = nextType ? V2_BUILD_COST[nextType] : undefined;
      if (!nextType || !upgradeCost || !canAfford(player.resources, upgradeCost)) continue;
      deductCost(player.resources, upgradeCost);
      structure.type = nextType;
      player.vp += V2_STRUCTURE_VP[nextType];
      player.influence += 1;
      continue;
    }

    if (action.type === 'extract_tile') {
      const tile = tiles.find((item) => item.id === action.tileId);
      if (
        !tile ||
        tile.status === 'collapsed' ||
        !v2AllowedResources(tile).includes(action.resource)
      ) {
        continue;
      }
      const units = V2_EXTRACTION_UNITS[action.level];
      const extractionState = { ...state, players, tiles, intersections, roads, structures };
      const structure = v2FindExtractionStructure(extractionState, player, tile, units);
      if (!structure) continue;
      structure.extractionsThisRound += units;
      const amount = tile.terrain === 'oil-field' ? V2_OIL_ENERGY_YIELD : units;
      const resource = tile.terrain === 'oil-field' ? 'energy' : action.resource;
      const accepted = addResource(player.resources, resource, amount);
      if (accepted > 0) {
        const pressure =
          tile.terrain === 'oil-field'
            ? EXTRACTION_PROFILES.high.pressure
            : EXTRACTION_PROFILES[action.level].pressure;
        pressureByTile.set(tile.id, (pressureByTile.get(tile.id) ?? 0) + pressure);
        if (tile.terrain === 'oil-field') {
          for (const adjacent of tiles) {
            if (adjacent.id !== tile.id && v2TileDistance(tile, adjacent) === 1) {
              pressureByTile.set(adjacent.id, (pressureByTile.get(adjacent.id) ?? 0) + 2);
            }
          }
        }
      }
      continue;
    }

    if (action.type === 'convert_timber_to_energy') {
      const timberCost = action.amount * V2_TIMBER_TO_ENERGY_RATIO;
      if (
        Number.isSafeInteger(action.amount) &&
        action.amount > 0 &&
        player.resources.timber >= timberCost
      ) {
        player.resources.timber -= timberCost;
        addResource(player.resources, 'energy', action.amount);
      }
    }
  }

  for (const tile of tiles) {
    const pressure = pressureByTile.get(tile.id) ?? 0;
    tile.health = Math.max(
      0,
      Math.min(tile.maxHealth, tile.health + V2_RECOVERY_PER_ROUND - pressure),
    );
    tile.status = v2TileStatus(tile);
  }

  const rankings = rankV2Players(players);
  return {
    ...state,
    players,
    tiles,
    intersections,
    roads,
    structures,
    activeTrades,
    lastResolvedActions,
    winner: rankings[0]?.id ?? null,
  };
}

function advanceOrFinishV2(state: TragedyV2State): ActionResult<TragedyV2State, TragedyV2Action> {
  if (state.round >= state.config.maxRounds) {
    return { state: { ...state, phase: 'finished' }, deadline: { kind: 'none' } };
  }
  const started = startV2Round(state);
  return { state: started, deadline: v2RoundTimeoutDeadline(state.config.turnTimerSeconds) };
}

function advanceV2Turn(state: TragedyV2State): ActionResult<TragedyV2State, TragedyV2Action> {
  const nextIndex = (state.currentPlayerIndex + 1) % state.players.length;
  if (nextIndex === 0) return advanceOrFinishV2(resolveV2Round(state));
  return {
    state: { ...state, currentPlayerIndex: nextIndex },
    deadline: v2RoundTimeoutDeadline(state.config.turnTimerSeconds),
  };
}

export function applyV2Action(
  state: TragedyV2State,
  playerId: string | null,
  action: TragedyV2Action,
): ActionResult<TragedyV2State, TragedyV2Action> {
  if (!validateV2Action(state, playerId, action)) return { state };
  if (action.type === 'game_start') {
    return { state, deadline: v2RoundTimeoutDeadline(state.config.turnTimerSeconds) };
  }
  if (action.type === 'place_starting_camp' && playerId) {
    return placeV2StartingCamp(state, playerId, action);
  }
  if (action.type === 'round_timeout') {
    const currentPlayer = state.players[state.currentPlayerIndex];
    if (!currentPlayer) return { state };
    const nextState: TragedyV2State = {
      ...state,
      submittedActions: {
        ...v2SubmittedActions(state),
        [currentPlayer.id]: { type: 'pass' },
      } as unknown as Record<string, TragedyAction | null>,
    };
    return advanceV2Turn(nextState);
  }
  if (!playerId) return { state };
  const nextState: TragedyV2State = {
    ...state,
    submittedActions: {
      ...v2SubmittedActions(state),
      [playerId]: action,
    } as unknown as Record<string, TragedyAction | null>,
  };
  return advanceV2Turn(nextState);
}

function buildV2SpectatorPlayer(
  player: TragedyV2PlayerState,
  state: TragedyV2State,
): TragedyV2SpectatorPlayer {
  return {
    ...cloneV2Player(player),
    name: player.id,
    totalResources: totalResources(player.resources),
    tiles: state.tiles.map(cloneV2Tile),
    intersections: state.intersections.map(cloneV2Intersection),
    roads: state.roads.map(cloneV2Road),
    structures: state.structures.map(cloneV2Structure),
    ecosystems: state.ecosystems.map(cloneEcosystem),
  };
}

export function buildV2SpectatorView(state: TragedyV2State): TragedyV2SpectatorView {
  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    tiles: state.tiles.map(cloneV2Tile),
    intersections: state.intersections.map(cloneV2Intersection),
    roads: state.roads.map(cloneV2Road),
    structures: state.structures.map(cloneV2Structure),
    players: state.players.map((player) => buildV2SpectatorPlayer(player, state)),
    ecosystems: state.ecosystems.map(cloneEcosystem),
    lastResolvedActions: state.lastResolvedActions.map((resolved) => ({
      playerId: resolved.playerId,
      action: { ...resolved.action },
    })),
    commonsHealthPercent: averageV2TileHealthPercent(state.tiles),
  };
}

export function buildV2PlayerView(state: TragedyV2State, playerId: string): unknown | null {
  const player = state.players.find((item) => item.id === playerId);
  if (!player) return null;
  return {
    round: state.round,
    maxRounds: state.config.maxRounds,
    phase: state.phase,
    you: buildV2SpectatorPlayer(player, state),
    scoreboard: state.players.map((item) => ({
      id: item.id,
      vp: item.vp,
      influence: item.influence,
      structures: item.ownedStructureIds.length,
      roads: item.ownedRoadIds.length,
    })),
    tiles: state.tiles.map(cloneV2Tile),
    intersections: state.intersections.map(cloneV2Intersection),
    roads: state.roads.map(cloneV2Road),
    structures: state.structures.map(cloneV2Structure),
    ecosystems: state.ecosystems.map(cloneEcosystem),
    activeTrades: state.activeTrades.map(cloneTradeOffer),
    lastResolvedActions: state.lastResolvedActions.map((resolved) => ({
      playerId: resolved.playerId,
      action: { ...resolved.action },
    })),
    submitted: v2SubmittedActions(state)[playerId] !== null,
    isYourTurn: state.players[state.currentPlayerIndex]?.id === playerId,
    currentPlayer: {
      id: state.players[state.currentPlayerIndex]?.id ?? '',
      handle: state.players[state.currentPlayerIndex]?.id ?? 'unknown',
    },
    commonsHealthPercent: averageV2TileHealthPercent(state.tiles),
  };
}

function rankV2Players(players: TragedyV2PlayerState[]): TragedyV2PlayerState[] {
  return [...players].sort((left, right) => {
    if (right.vp !== left.vp) return right.vp - left.vp;
    if (right.influence !== left.influence) return right.influence - left.influence;
    return comparePlayerId(left.id, right.id);
  });
}

export function getV2Outcome(state: TragedyV2State): TragedyV2Outcome {
  const rankings = rankV2Players(state.players).map((player) => ({
    id: player.id,
    vp: player.vp,
    influence: player.influence,
  }));
  const averageTileHealthPercent = averageV2TileHealthPercent(state.tiles);
  return {
    rankings,
    roundsPlayed: state.round,
    flourishingEcosystems: state.tiles.filter((tile) => tile.status === 'flourishing').length,
    collapsedEcosystems: state.tiles.filter((tile) => tile.status === 'collapsed').length,
    commonsHealthPercent: averageTileHealthPercent,
    averageTileHealthPercent,
  };
}
