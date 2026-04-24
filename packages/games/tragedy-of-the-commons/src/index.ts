export {
  applyAction,
  createInitialState,
  getOutcome,
  getPlayerView,
  getSpectatorView,
} from './game.js';
export {
  TRAGEDY_GAME_ID,
  TRAGEDY_SYSTEM_ACTION_TYPES,
  TragedyOfTheCommonsPlugin,
} from './plugin.js';
export type {
  EcosystemKind,
  ExtractionLevel,
  ResourceInventory,
  ResourceType,
  TragedyAction,
  TragedyConfig,
  TragedyEcosystem,
  TragedyOutcome,
  TragedyPhase,
  TragedyPlayerRanking,
  TragedyPlayerState,
  TragedyRegion,
  TragedyState,
  TragedyTradeOffer,
} from './types.js';
export { DEFAULT_TRAGEDY_CONFIG, EMPTY_INVENTORY } from './types.js';
