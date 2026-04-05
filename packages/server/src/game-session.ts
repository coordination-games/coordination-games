/**
 * CtL game session helpers.
 *
 * The server uses the generic GameSession<CtlGameState, CtlMove> from platform.
 * These helpers provide typed access to CtL-specific state and wrap the pure
 * game functions for server-side operations.
 */

import { GameSession } from '@coordination-games/platform';
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
  getStateForAgent as pureGetStateForAgent,
  resolveTurn as pureResolveTurn,
  allMovesSubmitted as pureAllMovesSubmitted,
  submitMove as pureSubmitMove,
  isGameOver as pureIsGameOver,
  CaptureTheLobsterPlugin,
  getMapRadiusForTeamSize,
  getTurnLimitForRadius,
  getUnitVision,
} from '@coordination-games/game-ctl';
import type { CtlMove } from '@coordination-games/game-ctl';

export type CtlSession = GameSession<CtlGameState, CtlMove>;

// Re-export for convenience
export type { CtlGameState, CtlMove, GameUnit, FlagState, GamePhase, GameState, GameConfig, Direction, TurnRecord, UnitClass, GameMap };
export { GameSession, CaptureTheLobsterPlugin, createGameState, getMapRadiusForTeamSize, getTurnLimitForRadius, getUnitVision };

// ---------------------------------------------------------------------------
// CtL-specific server operations
// ---------------------------------------------------------------------------

/** Submit a directional move for an agent. */
export function submitCtlMove(
  session: CtlSession,
  agentId: string,
  path: Direction[],
): { success: boolean; error?: string } {
  return session.submitMove(agentId, { path });
}

/** Check if all alive units have submitted moves. */
export function allMovesSubmitted(session: CtlSession): boolean {
  return pureAllMovesSubmitted(session.state);
}

/** Resolve the current turn — fills empty moves for AFK units, then resolves. */
export function resolveCtlTurn(session: CtlSession): TurnRecord {
  // Fill empty moves for alive units that haven't submitted
  for (const unit of session.state.units) {
    if (unit.alive && !session.hasSubmitted(unit.id)) {
      session.submitMove(unit.id, { path: [] });
    }
  }

  // The generic session calls plugin.resolveTurn which handles the actual resolution
  const prevState = session.state;
  session.resolveTurn();

  // Build the turn record from the pure function (for history/spectator)
  const { record } = pureResolveTurn(prevState);
  recordTurn(session.gameId, record);
  return record;
}

/** Get the fog-filtered state for an agent. */
export function getStateForAgent(session: CtlSession, agentId: string): GameState {
  return pureGetStateForAgent(session.state, agentId, new Set(session.submittedMoves.keys()));
}

/** Check if the game is over. */
export function isGameOver(session: CtlSession): boolean {
  return pureIsGameOver(session.state);
}

// ---------------------------------------------------------------------------
// Turn history tracking (server-side, not in generic GameSession)
// ---------------------------------------------------------------------------

const turnHistories = new Map<string, TurnRecord[]>();

/** Get the turn history for a game. */
export function getTurnHistory(session: CtlSession): TurnRecord[] {
  return turnHistories.get(session.gameId) ?? [];
}

/** Record a turn in the history. Called by resolveCtlTurn. */
function recordTurn(gameId: string, record: TurnRecord): void {
  let history = turnHistories.get(gameId);
  if (!history) {
    history = [];
    turnHistories.set(gameId, history);
  }
  history.push(record);
}

/** Clean up turn history when game is done. */
export function clearTurnHistory(gameId: string): void {
  turnHistories.delete(gameId);
}

/** Create a new CtL game session. */
export function createCtlSession(
  gameId: string,
  map: GameMap,
  players: { id: string; team: 'A' | 'B'; unitClass: UnitClass }[],
  config?: GameConfig,
): CtlSession {
  const state = createGameState(map, players, config);
  return new GameSession(CaptureTheLobsterPlugin, state, gameId);
}
