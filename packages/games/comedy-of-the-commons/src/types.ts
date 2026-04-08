/**
 * Comedy of the Commons — Game types
 *
 * Minimal first slice:
 * - 4 players, FFA, fixed 19-hex world map, 3 ecosystems
 * - Production wheel, building/trading, ecosystem extraction
 * - First to 10 VP or max rounds wins
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for creating a new Comedy game. */
export interface ComedyConfig {
  mapSeed: string;
  players: ComedyPlayerConfig[];
}

/** Player config at game creation. */
export interface ComedyPlayerConfig {
  id: string;
  handle: string;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/** Terrain types on the world map. */
export type Terrain = 'plains' | 'forest' | 'mountain' | 'ocean' | 'commons';

/** A single hex on the world map. */
export interface ComedyHex {
  q: number;
  r: number;
  terrain: Terrain;
  ecosystem: 0 | 1 | 2;
  owner: string | null;
  structure: Structure | null;
  extractionLevel: number;
}

/** Buildings that can be built on hexes. */
export type Structure = 'farm' | 'mine' | 'port' | 'tower';

/** Production resources. */
export type Resource = 'grain' | 'timber' | 'ore' | 'fish' | 'energy';

/** Ecosystem health state. */
export interface EcosystemHealth {
  ecosystem: 0 | 1 | 2;
  health: number;
  extractionYield: number;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Per-player state. */
export interface ComedyPlayer {
  id: string;
  handle: string;
  vp: number;
  resources: Record<Resource, number>;
  builtStructures: number;
}

/** Trade offer between two players. */
export interface TradeOffer {
  id: string;
  from: string;
  to: string;
  give: Partial<Record<Resource, number>>;
  want: Partial<Record<Resource, number>>;
  accepted: boolean;
  rejected: boolean;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

/** The full Comedy game state. */
export interface ComedyState {
  phase: ComedyPhase;
  turn: number;
  maxTurns: number;
  hexes: ComedyHex[];
  players: Map<string, ComedyPlayer>;
  ecosystems: [EcosystemHealth, EcosystemHealth, EcosystemHealth];
  trades: TradeOffer[];
  productionWheel: number[];
  winner: string | null;
}

/** Phases within a turn. */
export type ComedyPhase =
  | 'production'
  | 'negotiation'
  | 'building'
  | 'extraction'
  | 'resolution';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** All actions a player can submit. */
export type ComedyAction =
  | { type: 'game_start' }
  | { type: 'submit_trade'; offer: Omit<TradeOffer, 'id' | 'accepted' | 'rejected'> }
  | { type: 'accept_trade'; tradeId: string }
  | { type: 'reject_trade'; tradeId: string }
  | { type: 'build'; hexQ: number; hexR: number; structure: Structure }
  | { type: 'extract'; hexQ: number; hexR: number }
  | { type: 'pass' };

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** Game outcome when isOver() returns true. */
export interface ComedyOutcome {
  winner: string | null;
  vp: Map<string, number>;
  turnsPlayed: number;
}
