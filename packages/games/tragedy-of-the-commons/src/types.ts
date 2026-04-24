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

export type EcosystemKind = 'fishery' | 'forest' | 'aquifer' | 'wetland';

export type ExtractionLevel = 'low' | 'medium' | 'high';

export interface TragedyRegion {
  id: string;
  name: string;
  primaryResource: ResourceType;
  secondaryResources: ResourceType[];
  ecosystemIds: string[];
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
  ecosystems: TragedyEcosystem[];
  activeTrades: TragedyTradeOffer[];
  submittedActions: Record<string, TragedyAction | null>;
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
}

export const DEFAULT_TRAGEDY_CONFIG: TragedyConfig = {
  seed: 'tragedy-v0',
  playerIds: [],
  maxRounds: 12,
  turnTimerSeconds: 60,
};
