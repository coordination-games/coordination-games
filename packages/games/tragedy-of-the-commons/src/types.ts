/**
 * Tragedy of the Commons — initial upstream plugin type surface.
 *
 * This is the smallest playable slice of the local Commons prototype, adapted
 * to Lucian's post-PR #29 plugin contract. Rich trust/evidence and ERC-8004
 * integration stay at the platform/harness layer for later slices.
 */

export type TragedyPhase = 'waiting' | 'playing' | 'finished';

export type ResourceType = 'grain' | 'timber' | 'ore' | 'fish' | 'water' | 'energy';

export interface ResourceInventory {
  grain: number;
  timber: number;
  ore: number;
  fish: number;
  water: number;
  energy: number;
}

export const EMPTY_INVENTORY: ResourceInventory = {
  grain: 0,
  timber: 0,
  ore: 0,
  fish: 0,
  water: 0,
  energy: 0,
};

export type EcosystemKind = 'forest' | 'river' | 'wetland' | 'mineral' | 'oil-field';

export type ExtractionLevel = 'low' | 'medium' | 'high';

export type TragedyTerrain = 'forest' | 'mountains' | 'rivers' | 'wetland' | 'oil-field';

export interface TragedyBoardTile {
  id: string;
  q: number;
  r: number;
  terrain: TragedyTerrain;
  productionNumber: number;
  revealed: boolean;
  ecosystemIds: string[];
  regionId?: string;
  regionName?: string;
  primaryResource?: ResourceType;
}

export interface TragedyRegion {
  id: string;
  name: string;
  primaryResource: ResourceType;
  secondaryResources: ResourceType[];
  ecosystemIds: string[];
}

export interface TragedyHexRef {
  q: number;
  r: number;
}

export interface TragedyStructureLocation {
  type: 'camp' | 'village' | 'city' | 'solar-farm' | 'solar-array';
  hexes: TragedyHexRef[];
  regionId?: string;
  regionIds?: string[];
}

export interface TragedyRoadEndpoint {
  hexes: TragedyHexRef[];
}

export interface TragedyRoadLocation {
  from: TragedyRoadEndpoint;
  to: TragedyRoadEndpoint;
  type?: 'straight' | 'curve' | 'terminal';
  regionIds?: string[];
}

export interface TragedyEcosystem {
  id: string;
  name: string;
  kind: EcosystemKind;
  resource: ResourceType;
  regionIds: string[];
  health: number;
  maxHealth: number;
  collapseThreshold: number;
  flourishThreshold: number;
}

export interface TragedyPlayerState {
  id: string;
  resources: ResourceInventory;
  influence: number;
  vp: number;
  regionsControlled: string[];
}

export interface TragedyTradeOffer {
  to: string;
  give: Partial<ResourceInventory>;
  receive: Partial<ResourceInventory>;
}

export interface TragedyResolvedAction {
  playerId: string;
  action: TragedyAction;
}

export type TragedyAction =
  | { type: 'game_start' }
  | {
      type: 'offer_trade';
      to: string;
      give: Partial<ResourceInventory>;
      receive: Partial<ResourceInventory>;
    }
  | { type: 'extract_commons'; ecosystemId: string; level: ExtractionLevel }
  | { type: 'build_settlement'; regionId: string }
  | { type: 'pass' }
  | { type: 'round_timeout' };

export interface TragedyConfig {
  seed: string;
  playerIds: string[];
  maxRounds: number;
  turnTimerSeconds: number;
}

export interface TragedyState {
  round: number;
  phase: TragedyPhase;
  players: TragedyPlayerState[];
  regions: TragedyRegion[];
  boardTiles: TragedyBoardTile[];
  ecosystems: TragedyEcosystem[];
  activeTrades: TragedyTradeOffer[];
  lastResolvedActions: TragedyResolvedAction[];
  submittedActions: Record<string, TragedyAction | null>;
  currentPlayerIndex: number;
  winner: string | null;
  config: TragedyConfig;
}

export interface TragedyPlayerRanking {
  id: string;
  vp: number;
  influence: number;
}

export interface TragedyOutcome {
  rankings: TragedyPlayerRanking[];
  roundsPlayed: number;
  flourishingEcosystems: number;
  collapsedEcosystems: number;
  commonsHealthPercent: number;
}

export const DEFAULT_TRAGEDY_CONFIG: TragedyConfig = {
  seed: 'tragedy-v0',
  playerIds: [],
  maxRounds: 12,
  turnTimerSeconds: 60,
};

// ════════════════════════════════════════════════════════════════
// V2 Authoritative Model — Tragedy Simple Commons V2
//
// Tiles are resource ecosystems with health.
// Intersections are build spots at tile corners.
// Roads are tile-edge connections owned by players.
// Regions are NOT authoritative in V2.
//
// These coexist with v0 types above to allow phased migration.
// ════════════════════════════════════════════════════════════════

// ── V2 Tile ──

export interface TragedyV2Tile {
  id: string;
  q: number;
  r: number;
  terrain: TragedyTerrain;
  primaryResource: ResourceType;
  /** At least one ecosystem id for VFX/display resolution. */
  ecosystemIds: string[];
  health: number;
  maxHealth: number;
  collapseThreshold: number;
  flourishThreshold: number;
  status: 'flourishing' | 'stable' | 'strained' | 'collapsed';
}

// ── V2 Intersection ──

export interface TragedyV2Intersection {
  id: string;
  /** Exactly 3 hex corners that meet here. */
  hexes: TragedyHexRef[];
  occupantStructureId?: string;
}

// ── V2 Road (authoritative, owned) ──

export interface TragedyV2Road {
  id: string;
  ownerId: string;
  fromIntersectionId: string;
  toIntersectionId: string;
  type?: 'straight' | 'curve' | 'terminal';
}

// ── V2 Structure (authoritative, owned) ──

export type TragedyV2StructureType = 'camp' | 'village' | 'city' | 'solar-farm' | 'solar-array';

export interface TragedyV2Structure {
  id: string;
  ownerId: string;
  intersectionId: string;
  type: TragedyV2StructureType;
  /** Counter reset each round; caps at 1/2/3 for camp/village/city. */
  extractionsThisRound: number;
}

// ── V2 Build Costs ──

export const V2_BUILD_COST: Record<string, Partial<ResourceInventory>> = {
  road: { timber: 1, energy: 1 },
  camp: { timber: 1, fish: 1, water: 1, energy: 1 },
  village: { timber: 2, fish: 1, water: 1, energy: 2 },
  city: { ore: 2, fish: 2, water: 1, energy: 3 },
  'solar-farm': { ore: 1, timber: 1, energy: 2 },
  'solar-array': { ore: 2, water: 2, energy: 3 },
};

/** VP awarded instantly when the structure is built or upgraded. */
export const V2_STRUCTURE_VP: Record<TragedyV2StructureType, number> = {
  camp: 1,
  village: 2,
  city: 3,
  'solar-farm': 1,
  'solar-array': 2,
};

/** Extraction capacity per round. Solar buildings do not extract. */
export const V2_EXTRACTION_CAPACITY: Record<TragedyV2StructureType, number> = {
  camp: 1,
  village: 2,
  city: 3,
  'solar-farm': 0,
  'solar-array': 0,
};

/** Passive energy per round from solar buildings. */
export const V2_SOLAR_ENERGY: Record<TragedyV2StructureType, number> = {
  camp: 0,
  village: 0,
  city: 0,
  'solar-farm': 1,
  'solar-array': 2,
};

/** Oil yields 2 Energy per extraction. */
export const V2_OIL_ENERGY_YIELD = 2;

/** 2 Timber → 1 Energy. */
export const V2_TIMBER_TO_ENERGY_RATIO = 2;

// ── V2 Player State ──

export interface TragedyV2PlayerState {
  id: string;
  resources: ResourceInventory;
  influence: number;
  vp: number;
  /** Replaces regionsControlled — structures the player owns. */
  ownedStructureIds: string[];
  /** Replaces regionsControlled — roads the player owns. */
  ownedRoadIds: string[];
}

// ── V2 Actions ──

export type TragedyV2Action =
  | { type: 'game_start' }
  | { type: 'place_starting_camp'; intersectionId: string }
  | {
      type: 'offer_trade';
      to: string;
      give: Partial<ResourceInventory>;
      receive: Partial<ResourceInventory>;
    }
  | {
      type: 'build_road';
      fromIntersectionId: string;
      toIntersectionId: string;
    }
  | {
      type: 'build_structure';
      intersectionId: string;
      structureType: TragedyV2StructureType;
    }
  | { type: 'upgrade_structure'; structureId: string }
  | {
      type: 'extract_tile';
      tileId: string;
      resource: ResourceType;
      level: ExtractionLevel;
    }
  | { type: 'convert_timber_to_energy'; amount: number }
  | { type: 'pass' }
  | { type: 'round_timeout' };

// ── V2 Config ──

export interface TragedyV2Config extends TragedyConfig {
  schemaVersion: 'v2';
}

export const DEFAULT_V2_CONFIG = (overrides?: Partial<TragedyV2Config>): TragedyV2Config => ({
  ...DEFAULT_TRAGEDY_CONFIG,
  schemaVersion: 'v2',
  ...overrides,
});

// ── V2 State ──

export interface TragedyV2State {
  round: number;
  phase: TragedyPhase;
  players: TragedyV2PlayerState[];
  tiles: TragedyV2Tile[];
  intersections: TragedyV2Intersection[];
  roads: TragedyV2Road[];
  structures: TragedyV2Structure[];
  ecosystems: TragedyEcosystem[];
  activeTrades: TragedyTradeOffer[];
  lastResolvedActions: TragedyResolvedAction[];
  submittedActions: Record<string, TragedyAction | null>;
  currentPlayerIndex: number;
  winner: string | null;
  config: TragedyConfig;
}

// ── V2 Spectator / Player View ──

export interface TragedyV2SpectatorPlayer {
  id: string;
  name: string;
  resources: ResourceInventory;
  influence: number;
  vp: number;
  ownedStructureIds: string[];
  ownedRoadIds: string[];
  totalResources: number;
  tiles: TragedyV2Tile[];
  intersections: TragedyV2Intersection[];
  roads: TragedyV2Road[];
  structures: TragedyV2Structure[];
  ecosystems: TragedyEcosystem[];
}

export interface TragedyV2SpectatorView {
  round: number;
  maxRounds: number;
  phase: string;
  tiles: TragedyV2Tile[];
  intersections: TragedyV2Intersection[];
  roads: TragedyV2Road[];
  structures: TragedyV2Structure[];
  players: TragedyV2SpectatorPlayer[];
  ecosystems: TragedyEcosystem[];
  lastResolvedActions: TragedyResolvedAction[];
  commonsHealthPercent: number;
}

// ── V2 Outcome ──

export interface TragedyV2Outcome extends TragedyOutcome {
  /** Average tile health at game end as percentage. */
  averageTileHealthPercent: number;
}
