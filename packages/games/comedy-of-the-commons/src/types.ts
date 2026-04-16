/**
 * Comedy of the Commons — initial upstream v0 type surface.
 *
 * These types intentionally describe the smallest believable upstream Comedy
 * shape, not the full local arena prototype.
 */

export type ComedyPhase = 'waiting' | 'playing' | 'finished';

export type ResourceType =
  | 'grain'
  | 'timber'
  | 'ore'
  | 'fish'
  | 'water'
  | 'energy';

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

export type EcosystemKind = 'fishery' | 'forest' | 'aquifer' | 'wetland';

export type ExtractionLevel = 'low' | 'medium' | 'high';

export interface ComedyRegion {
  id: string;
  name: string;
  primaryResource: ResourceType;
  secondaryResources: ResourceType[];
  ecosystemIds: string[];
}

export interface ComedyEcosystem {
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

export interface ComedyPlayerState {
  id: string;
  resources: ResourceInventory;
  influence: number;
  vp: number;
  regionsControlled: string[];
}

export interface ComedyTradeOffer {
  to: string;
  give: Partial<ResourceInventory>;
  receive: Partial<ResourceInventory>;
}

export type ComedyAction =
  | { type: 'game_start' }
  | { type: 'offer_trade'; offer: ComedyTradeOffer }
  | { type: 'extract_commons'; ecosystemId: string; level: ExtractionLevel }
  | { type: 'build_settlement'; regionId: string }
  | { type: 'pass' }
  | { type: 'round_timeout' };

export interface ComedyConfig {
  seed: string;
  playerIds: string[];
  maxRounds: number;
  turnTimerSeconds: number;
}

export interface ComedyState {
  round: number;
  phase: ComedyPhase;
  players: ComedyPlayerState[];
  regions: ComedyRegion[];
  ecosystems: ComedyEcosystem[];
  activeTrades: ComedyTradeOffer[];
  submittedActions: Record<string, ComedyAction | null>;
  winner: string | null;
  config: ComedyConfig;
}

export interface ComedyPlayerRanking {
  id: string;
  vp: number;
  influence: number;
}

export interface ComedyOutcome {
  rankings: ComedyPlayerRanking[];
  roundsPlayed: number;
  flourishingEcosystems: number;
  collapsedEcosystems: number;
}

export const DEFAULT_COMEDY_CONFIG: ComedyConfig = {
  seed: 'comedy-v0',
  playerIds: [],
  maxRounds: 12,
  turnTimerSeconds: 60,
};
