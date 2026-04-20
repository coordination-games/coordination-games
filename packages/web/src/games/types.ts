/** Props passed to a game's spectator view component. */
export interface SpectatorViewProps {
  /** Raw game state from the server (game-specific shape); narrowed at the per-game view boundary. */
  gameState: unknown;
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
  /** All replay snapshots (only set in replay mode). Each snapshot is self-contained. */
  replaySnapshots?: unknown[];
  /** Previous snapshot for diffing (movement, kills, state changes). Null on first snapshot. */
  prevGameState?: unknown;
  /** Whether to animate the transition from prevGameState to gameState. False during scrubbing. */
  animate?: boolean;
  /**
   * Phase 7.2 — live spectator stream forwarded by GamePage. The single
   * WS lifecycle now lives in GamePage's `useSpectatorStream`; per-game
   * SpectatorViews must NOT open their own. In replay mode these are
   * undefined (replay state arrives via `gameState` / `replaySnapshots`).
   *
   * Typed as `unknown` here to keep `SpectatorPayload` out of this shared
   * types file — CtL / OATHBREAKER views narrow it locally at the entry
   * point.
   */
  liveSnapshot?: unknown;
  /** True while the live WS is OPEN; false during HTTP polling fallback. */
  liveIsLive?: boolean;
  /** Last live-stream error (transport-level), if any. */
  liveError?: string | null;
}

/** Props for a compact game card shown in lobby/game lists. */
export interface GameCardProps {
  gameId: string;
  /** Per-game state shape; cards narrow it at their entry point. */
  gameState: unknown;
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

/**
 * Per-game branding metadata. Read by the shell (Layout, HomePage,
 * JoinInstructions) so the chrome stays game-agnostic — no `lobster`
 * literals in shared components.
 */
export interface GameBranding {
  /** Short identifier shown in compact chrome (e.g. mobile header). */
  shortName: string;
  /** Full display name (e.g. HomePage tile heading, Layout header). */
  longName: string;
  /** Emoji or asset path used as the game's icon. */
  icon: string;
  /** Brand color for primary highlights. CSS color string. */
  primaryColor: string;
  /** One- or two-sentence summary used on HomePage tiles. */
  intro: string;
}

/** A spectator plugin for a specific game type. */
export interface SpectatorPlugin {
  /** Game type identifier (must match server's gameType). */
  gameType: string;
  /** Human-readable display name. */
  displayName: string;
  /** Branding metadata consumed by shared shell components. */
  branding: GameBranding;
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
  /** Snapshot shape is per-game — plugins narrow via a type guard. */
  getReplayChrome(snapshot: unknown): ReplayChrome;
}
