/**
 * GameRoom — manages a live game instance.
 *
 * Single-threaded per room (mutex). One timer per room (deadline).
 * Framework calls handleAction, game decides everything else.
 */

import type { CoordinationGame, ActionResult } from './types.js';

export class GameRoom<TConfig, TState, TAction, TOutcome> {
  private _state: TState;
  private _stateHistory: TState[] = [];
  private _timerId = 0;
  private _currentTimer: ReturnType<typeof setTimeout> | null = null;
  private _lock = false; // simple mutex (single-threaded JS, just prevents reentrant calls)
  private _actionLog: { playerId: string | null; action: TAction; stateHash?: string }[] = [];
  readonly gameId: string;
  private readonly game: CoordinationGame<TConfig, TState, TAction, TOutcome>;

  // Callbacks the server wires up
  onStateChange?: (room: GameRoom<TConfig, TState, TAction, TOutcome>) => void;
  onGameOver?: (room: GameRoom<TConfig, TState, TAction, TOutcome>) => void;

  constructor(
    game: CoordinationGame<TConfig, TState, TAction, TOutcome>,
    initialState: TState,
    gameId: string,
  ) {
    this.game = game;
    this._state = initialState;
    this._stateHistory = [initialState];
    this.gameId = gameId;
  }

  // --- State accessors ---

  get state(): TState { return this._state; }
  get actionLog() { return this._actionLog; }
  get gamePlugin() { return this.game; }

  /**
   * THE SINGLE ENTRY POINT — submit an action.
   * Validates, applies, updates state, handles deadline, checks game over.
   */
  async handleAction(playerId: string | null, action: TAction): Promise<{ success: boolean; error?: string }> {
    if (this._lock) {
      return { success: false, error: 'Action already being processed' };
    }
    this._lock = true;
    try {
      if (!this.game.validateAction(this._state, playerId, action)) {
        return { success: false, error: 'Invalid action' };
      }

      const result: ActionResult<TState, TAction> = this.game.applyAction(this._state, playerId, action);
      this._state = result.state;
      this._stateHistory.push(result.state);
      this._actionLog.push({ playerId, action });

      // Handle deadline
      if (result.deadline !== undefined) {
        this.setDeadline(result.deadline);
      }

      // Notify state change
      this.onStateChange?.(this);

      // Check game over
      if (this.game.isOver(this._state)) {
        this.setDeadline(null); // cancel timer
        this.onGameOver?.(this);
      }

      return { success: true };
    } finally {
      this._lock = false;
    }
  }

  /** Get visible state for a player (or spectator if null). */
  getVisibleState(playerId: string | null): unknown {
    return this.game.getVisibleState(this._state, playerId);
  }

  /** Check if game is over. */
  isOver(): boolean {
    return this.game.isOver(this._state);
  }

  /** Get outcome (only valid when isOver). */
  getOutcome(): TOutcome {
    return this.game.getOutcome(this._state);
  }

  /** Get payouts (only valid when isOver). */
  computePayouts(playerIds: string[]): Map<string, number> {
    return this.game.computePayouts(this.getOutcome(), playerIds);
  }

  getStateHistory(): readonly TState[] {
    return this._stateHistory;
  }

  /** Cancel any active timer. */
  cancelTimer(): void {
    this.setDeadline(null);
  }

  private setDeadline(deadline: { seconds: number; action: TAction } | null): void {
    this._timerId++;
    if (this._currentTimer) {
      clearTimeout(this._currentTimer);
      this._currentTimer = null;
    }
    if (!deadline) return;

    const myId = this._timerId;
    this._currentTimer = setTimeout(() => {
      if (myId !== this._timerId) return; // stale
      this._currentTimer = null;
      this.handleAction(null, deadline.action);
    }, deadline.seconds * 1000);
  }

  // --- Static factory ---

  static create<TConfig, TState, TAction, TOutcome>(
    game: CoordinationGame<TConfig, TState, TAction, TOutcome>,
    config: TConfig,
    gameId: string,
  ): GameRoom<TConfig, TState, TAction, TOutcome> {
    const initialState = game.createInitialState(config);
    return new GameRoom(game, initialState, gameId);
  }
}
