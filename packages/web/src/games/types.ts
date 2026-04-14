/** Props passed to a game's spectator view component. */
export interface SpectatorViewProps {
  /** Raw game state from the server (game-specific shape). */
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
  /** All replay snapshots (only set in replay mode). Plugins use this for cross-snapshot accumulation (e.g. kill feed). */
  replaySnapshots?: any[];
  /** Current replay snapshot index (only set in replay mode). */
  replayIndex?: number;
}

/** Props for a compact game card shown in lobby/game lists. */
export interface GameCardProps {
  gameId: string;
  gameState: any;
  handles: Record<string, string>;
  gameType: string;
  phase: string;
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
}
