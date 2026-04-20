/** Props passed to a game's spectator view component. */
export interface SpectatorViewProps {
  /** Raw game state from the server (game-specific shape). */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  gameState: any;
  /** Chat messages from the relay. */
  chatMessages: { from: string; message: string; timestamp: number }[];
  /** Map of agentId → display name. */
  handles: Record<string, string>;
  /** Game ID. */
  gameId: string;
  /** Game type identifier. */
  gameType: string;
  /** Current game phase. */
  phase: 'in_progress' | 'finished';
  /** Kill feed entries. */
  killFeed?: { turn: number; text: string }[];
  /** Currently selected team perspective (for fog of war). */
  perspective?: 'all' | 'A' | 'B';
  /** Callback to change perspective. */
  onPerspectiveChange?: (perspective: 'all' | 'A' | 'B') => void;
  /** All replay snapshots (only set in replay mode). Each snapshot is self-contained. */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  replaySnapshots?: any[];
  /** Previous snapshot for diffing (movement, kills, state changes). Null on first snapshot. */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  prevGameState?: any;
  /** Whether to animate the transition from prevGameState to gameState. False during scrubbing. */
  animate?: boolean;
}

/** Props for a compact game card shown in lobby/game lists. */
export interface GameCardProps {
  gameId: string;
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  gameState: any;
  handles: Record<string, string>;
  gameType: string;
  phase: string;
}

/**
 * Replay/finish chrome derived from a spectator snapshot. Mirrors
 * `CoordinationGame.getReplayChrome` on the engine side so the frontend
 * stays game-agnostic. Per-plugin implementations should delegate to the
 * engine plugin when possible.
 */
export interface ReplayChrome {
  isFinished: boolean;
  /** Human-readable winner name (e.g. "Team A", playerId). Undefined for draws. */
  winnerLabel?: string;
  statusVariant: 'in_progress' | 'win' | 'draw';
}

/** A spectator plugin for a specific game type. */
export interface SpectatorPlugin {
  /** Game type identifier (must match server's gameType). */
  gameType: string;
  /** Human-readable display name. */
  displayName: string;
  /** Main spectator view component. */
  SpectatorView: React.ComponentType<SpectatorViewProps>;
  /** Compact card for lobby/game lists. */
  GameCard?: React.ComponentType<GameCardProps>;
  /** Total animation duration in ms. ReplayPage waits this + read time before advancing. */
  animationDuration?: number;
  /**
   * Compute the replay/finish chrome from a public spectator snapshot.
   * Required — the generic ReplayPage uses this to render the finish
   * badge without knowing the game's state shape.
   */
  // biome-ignore lint/suspicious/noExplicitAny: snapshot shape is per-game
  getReplayChrome(snapshot: any): ReplayChrome;
}
