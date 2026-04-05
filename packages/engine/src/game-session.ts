/**
 * GameSession — generic state holder for a live game.
 *
 * Works with any CoordinationGame implementation. Tracks:
 * - Current game state
 * - Move submissions per turn
 * - Turn history (state hashes for Merkle proofs)
 *
 * Does NOT track messages, cursors, or relay state — that's the relay's job.
 */

import type { CoordinationGame } from './types.js';

export class GameSession<TState, TMove> {
  private _state: TState;
  private _stateHistory: TState[] = [];
  private _submittedMoves = new Map<string, TMove>();
  readonly gameId: string;

  constructor(
    private readonly game: CoordinationGame<unknown, TState, TMove, unknown>,
    initialState: TState,
    gameId: string,
  ) {
    this._state = initialState;
    this._stateHistory = [initialState];
    this.gameId = gameId;
  }

  // --- State accessors ---

  get state(): TState { return this._state; }

  get submittedMoves(): ReadonlyMap<string, TMove> { return this._submittedMoves; }

  hasSubmitted(playerId: string): boolean {
    return this._submittedMoves.has(playerId);
  }

  get submissionCount(): number {
    return this._submittedMoves.size;
  }

  // --- Mutating operations ---

  submitMove(playerId: string, move: TMove): { success: boolean; error?: string } {
    if (!this.game.validateMove(this._state, playerId, move)) {
      return { success: false, error: 'Invalid move' };
    }
    this._submittedMoves.set(playerId, move);
    return { success: true };
  }

  resolveTurn(): TState {
    const newState = this.game.resolveTurn(this._state, this._submittedMoves);
    this._state = newState;
    this._stateHistory.push(newState);
    this._submittedMoves.clear();
    return newState;
  }

  isOver(): boolean {
    return this.game.isOver(this._state);
  }

  getStateHistory(): readonly TState[] {
    return this._stateHistory;
  }

  // --- Static factory ---

  static create<TConfig, TState, TMove, TOutcome>(
    game: CoordinationGame<TConfig, TState, TMove, TOutcome>,
    config: TConfig,
    gameId: string,
  ): GameSession<TState, TMove> {
    const initialState = game.createInitialState(config);
    return new GameSession(game, initialState, gameId);
  }
}
