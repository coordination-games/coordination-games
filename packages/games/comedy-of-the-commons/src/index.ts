export type {
  ComedyAction,
  ComedyConfig,
  ComedyEcosystem,
  ComedyOutcome,
  ComedyPhase,
  ComedyPlayerRanking,
  ComedyPlayerState,
  ComedyRegion,
  ComedyState,
  ComedyTradeOffer,
  EcosystemKind,
  ExtractionLevel,
  ResourceInventory,
  ResourceType,
} from './types.js';

export { DEFAULT_COMEDY_CONFIG, EMPTY_INVENTORY } from './types.js';
export {
  applyAction,
  createInitialState,
  getOutcome,
  getPlayerView,
  getSpectatorView,
} from './game.js';
export { ComedyOfTheCommonsPlugin, COMEDY_SYSTEM_ACTION_TYPES } from './plugin.js';
