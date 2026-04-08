/**
 * Shared types for the Comedy of the Commons Agent SDK.
 */

export type ResourceType = "grain" | "timber" | "ore" | "fish" | "water" | "energy";

export interface ResourceInventory {
  grain: number;
  timber: number;
  ore: number;
  fish: number;
  water: number;
  energy: number;
}

export const RESOURCE_CAP = 14;

export const STRUCTURE_COSTS: Record<StructureType, ResourceInventory> = {
  road:       { grain: 1, timber: 1, ore: 0, fish: 0, water: 0, energy: 0 },
  village:    { grain: 1, timber: 1, ore: 1, fish: 0, water: 1, energy: 0 },
  township:   { grain: 2, timber: 1, ore: 1, fish: 0, water: 1, energy: 0 },
  city:       { grain: 2, timber: 0, ore: 2, fish: 0, water: 1, energy: 0 },
  beacon:     { grain: 0, timber: 0, ore: 1, fish: 0, water: 1, energy: 1 },
  trade_post: { grain: 0, timber: 1, ore: 0, fish: 1, water: 1, energy: 0 },
};

export type StructureType = "road" | "village" | "township" | "city" | "beacon" | "trade_post";

export interface HexCoord {
  q: number;
  r: number;
}

export type MessageChannel = "public" | "private" | "broadcast" | "diary";

export interface GameMessage {
  id: string;
  sender: string;
  recipient: string | "broadcast";
  content: string;
  type: "public" | "private" | "diary";
  round: number;
  timestamp: number;
}

export type ComedyActionType =
  | "build_road"
  | "build_village"
  | "upgrade_township"
  | "upgrade_city"
  | "build_beacon"
  | "build_trade_post"
  | "trade_player"
  | "trade_bank"
  | "explore"
  | "extract_commons"
  | "restore_ecosystem"
  | "sabotage"
  | "crisis_contribute"
  | "build_army"
  | "move_army"
  | "attack_structure"
  | "pass";

export type ExtractionLevel = "low" | "medium" | "high";

export interface ActionParams {
  partnerId?: string;
  give?: Partial<ResourceInventory>;
  receive?: Partial<ResourceInventory>;
  bankGiveType?: ResourceType;
  bankReceiveType?: ResourceType;
  bankGiveAmount?: number;
  ecosystemId?: string;
  extractionLevel?: ExtractionLevel;
  restoration?: Partial<ResourceInventory>;
  crisisId?: string;
  contribution?: Partial<ResourceInventory>;
  armyId?: string;
  targetHex?: HexCoord;
  targetAgent?: string;
  location?: HexCoord;
  targetStructureIndex?: number;
  upgradeTargetIndex?: number;
  [key: string]: unknown;
}

export interface GameAction {
  type: ComedyActionType;
  params: ActionParams;
}

export interface CrisisInfo {
  id: string;
  name: string;
  description: string;
  type: string;
  threshold: ResourceInventory;
  contributions: Record<string, ResourceInventory>;
  resolved: boolean;
  rewardVP: number;
  rewardInfluence: number;
}

export interface EcosystemInfo {
  id: string;
  name: string;
  kind: string;
  resource: ResourceType;
  health: number;
  maxHealth: number;
  status: "flourishing" | "stable" | "strained" | "collapsed";
  extractionProfiles: Array<{
    level: ExtractionLevel;
    yield: number;
    pressure: number;
  }>;
}

export interface CommonsHealth {
  score: number;
  payableFraction: number;
  reasons: string[];
}

export interface PlayerInfo {
  id: string;
  score: number;
  influence: number;
  trust: number;
}

export interface ComedyAgentView {
  gameId: string;
  round: number;
  phase: string;
  myId: string;
  visibleHexes: Array<{ coord: HexCoord; terrain: string }>;
  ecosystemStates: EcosystemInfo[];
  myResources: ResourceInventory;
  myInfluence: number;
  myVP: number;
  myStructures: {
    villages: number;
    townships: number;
    cities: number;
    beacons: number;
    tradePosts: number;
    roads: number;
  };
  allScores: Record<string, number>;
  allInfluence: Record<string, number>;
  trustScores: Record<string, number>;
  productionWheel: number[];
  wheelPosition: number;
  nextProduction: number[];
  activeCrisis: CrisisInfo | null;
  prizePool: string;
  payablePrizePool: string;
  slashedPrizePool: string;
  carryoverPrizePool: string;
  currentCommonsHealth: CommonsHealth;
  messageHistory: GameMessage[];
}

export interface GameGuide {
  game: "comedy-of-the-commons";
  rules: string;
  tools: string[];
  resources: string[];
}

export interface RoundResult {
  gameId: string;
  round: number;
  actions: Record<string, GameAction[]>;
  outcomes: Array<{
    action: GameAction;
    success: boolean;
    description: string;
  }>;
  scoreChanges: Record<string, number>;
  trustUpdates: Array<{
    from: string;
    to: string;
    delta: number;
    reason: string;
  }>;
  messages: GameMessage[];
}
