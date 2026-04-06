/**
 * Game room helpers — thin wrapper around engine's GameRoom for server use.
 */

import { GameRoom } from '@coordination-games/engine';
import {
  CtlGameState,
  GameUnit,
  FlagState,
  GamePhase,
  GameState,
  GameConfig,
  Direction,
  TurnRecord,
  UnitClass,
  GameMap,
  createGameState,
  CaptureTheLobsterPlugin,
  getMapRadiusForTeamSize,
  getTurnLimitForRadius,
  getUnitVision,
  CtlAction,
  CtlConfig,
  CtlOutcome,
} from '@coordination-games/game-ctl';

export type CtlGameRoom = GameRoom<CtlConfig, CtlGameState, CtlAction, CtlOutcome>;

// Re-export for convenience
export type { CtlGameState, GameUnit, FlagState, GamePhase, GameState, GameConfig, Direction, TurnRecord, UnitClass, GameMap, CtlAction };
export { GameRoom, CaptureTheLobsterPlugin, createGameState, getMapRadiusForTeamSize, getTurnLimitForRadius, getUnitVision };

/** Create a new CtL game room using the v2 GameRoom. */
export function createCtlGameRoom(
  gameId: string,
  config: CtlConfig,
): CtlGameRoom {
  return GameRoom.create(CaptureTheLobsterPlugin, config, gameId);
}
