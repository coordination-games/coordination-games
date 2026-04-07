/**
 * Core types for the Coordination Games framework.
 *
 * A game plugin implements CoordinationGame<TConfig, TState, TAction, TOutcome>.
 * The framework is a dumb pipe: action -> state -> broadcast -> maybe set timer.
 * The game owns turns, phases, resolution, and visibility.
 */

// ---------------------------------------------------------------------------
// Ethereum primitives
// ---------------------------------------------------------------------------

/** An Ethereum address (0x-prefixed hex string). */
export type Address = string;

// ---------------------------------------------------------------------------
// Spectator context (passed to buildSpectatorView)
// ---------------------------------------------------------------------------

/** Context provided to buildSpectatorView by the framework. */
export interface SpectatorContext {
  /** Maps agent IDs to display names. */
  handles: Record<string, string>;
  /** Relay messages up to the current progress point (for delayed spectator views). */
  relayMessages: any[];
}

// ---------------------------------------------------------------------------
// Game plugin interface (v2 — action-based)
// ---------------------------------------------------------------------------

/**
 * Action result returned by applyAction.
 * deadline: { seconds, action } -> set timer, fire action on expiry
 * deadline: null -> cancel current timer
 * deadline: undefined (omitted) -> leave timer unchanged
 */
export interface ActionResult<TState, TAction> {
  state: TState;
  deadline?: { seconds: number; action: TAction } | null;
  progressIncrement?: boolean;  // true = this action advanced the game clock (turn/round resolved)
}

/**
 * v2 game plugin interface — action-based.
 * Game owns turns, phases, resolution, visibility.
 * Framework is a dumb pipe: action -> state -> broadcast -> maybe set timer.
 *
 * Hard requirements for all games:
 * 1. Deterministic — applyAction must produce the same output for the same input
 * 2. Discrete entry — player joins a lobby, entry fee deducted, game starts
 * 3. Finite — games must have a termination condition (isOver returns true)
 *
 * @template TConfig - Game configuration (map seed, team size, player IDs, etc.)
 * @template TState - Full game state (board, units, scores, turn info, etc.)
 * @template TAction - A single action (player move, system tick, timer expiry, etc.)
 * @template TOutcome - Game result (winner, scores, etc.)
 */
export interface CoordinationGame<TConfig, TState, TAction, TOutcome> {
  /** Unique game type identifier, e.g. "capture-the-lobster", "oathbreaker" */
  readonly gameType: string;

  /** Semantic version for replay compatibility */
  readonly version: string;

  /** Create initial game state from config (config includes playerIds). */
  createInitialState(config: TConfig): TState;

  /** Can this player do this action right now? playerId null for system actions. */
  validateAction(state: TState, playerId: string | null, action: TAction): boolean;

  /** THE CORE — apply action, return new state + optional deadline. Must be deterministic. */
  applyAction(state: TState, playerId: string | null, action: TAction): ActionResult<TState, TAction>;

  /** What should this player see? null = spectator view. Game controls all visibility. */
  getVisibleState(state: TState, playerId: string | null): unknown;

  /** Is the game over? */
  isOver(state: TState): boolean;

  /** Final outcome. Only valid when isOver() is true. */
  getOutcome(state: TState): TOutcome;

  /** Entry cost in credits per player. */
  readonly entryCost: number;

  /** Credit payouts from outcome. Must be zero-sum. */
  computePayouts(outcome: TOutcome, playerIds: string[]): Map<string, number>;

  /** Lobby configuration. */
  readonly lobby?: GameLobbyConfig;

  /** Delay in progress units (turns for CtL, rounds for OATHBREAKER). Default 0. */
  spectatorDelay?: number;

  /**
   * Build the spectator view for a given state. Required.
   * Called by the engine's GameRoom.getSpectatorView() to produce the
   * frontend-ready spectator payload. Each game defines its own shape.
   */
  buildSpectatorView(state: TState, prevState: TState | null, context: SpectatorContext): unknown;

  /** Game rules text (Markdown). Shown to agents via get_guide(). */
  guide?: string;

  /** Player-specific status text for the guide. */
  getPlayerStatus?(state: TState, playerId: string): string;

  /** Summary for game listing (lobby browser). */
  getSummary?(state: TState): Record<string, any>;

  /** IDs of players that need to submit an action in the current state. */
  getPlayersNeedingAction?(state: TState): string[];

  /** Required plugin IDs. */
  readonly requiredPlugins?: string[];

  /** Recommended plugin IDs. */
  readonly recommendedPlugins?: string[];
}

// ---------------------------------------------------------------------------
// Game result for on-chain anchoring
// ---------------------------------------------------------------------------

/** Game result for on-chain anchoring. */
export interface GameResult {
  gameId: string;
  gameType: string;
  players: string[];    // Player IDs (agentIds)
  outcome: unknown;     // Game-specific outcome data
  actionsRoot: string;  // Merkle root of all actions
  configHash: string;   // Hash of the game config
  actionCount: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Lobby types (shared across games)
// ---------------------------------------------------------------------------

/** A player in a lobby. */
export interface LobbyPlayer {
  id: string;
  handle: string;
  elo: number;
}

/** A team in a lobby. */
export interface LobbyTeam {
  id: string;
  members: string[];
  invites: Set<string>;
}

/** Chat message in a lobby or game. */
export interface ChatMessage {
  from: string;
  message: string;
  timestamp: number;
}

/** Lobby configuration. */
export interface LobbyConfig {
  teamSize: number;
  numTeams: number;
  timeoutMs: number;
  gameType: string;
}

// ---------------------------------------------------------------------------
// Framework server configuration
// ---------------------------------------------------------------------------

/** Configuration for the game server framework. */
export interface FrameworkConfig {
  /** Port to listen on */
  port: number;
  /** Registered game plugins */
  games: Map<string, CoordinationGame<any, any, any, any>>;
  /** Spectator delay in turns */
  spectatorDelay?: number;
}

// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

/** Challenge issued during auth handshake. */
export interface AuthChallenge {
  nonce: string;
  expiresAt: number;
  message: string;
}

/** Session token issued after successful auth. */
export interface SessionToken {
  token: string;
  playerId: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Balance tracking
// ---------------------------------------------------------------------------

/** Server-side balance snapshot for a player. */
export interface PlayerBalance {
  playerId: string;
  onChainBalance: number;
  committed: number;       // Locked in active games
  pendingBurns: number;    // Awaiting burn execution
  available: number;       // onChainBalance - committed - pendingBurns
}

// ---------------------------------------------------------------------------
// ToolPlugin — extend what agents can do during gameplay
// ---------------------------------------------------------------------------

/** A tool plugin that extends agent capabilities during gameplay. */
export interface ToolPlugin {
  /** Unique plugin identifier, e.g. "basic-chat", "elo" */
  readonly id: string;

  /** Semantic version */
  readonly version: string;

  /** Operating modes — defines data flow via consumes/provides */
  readonly modes: PluginMode[];

  /** Whether plugin output is deterministic per turn */
  readonly purity: 'pure' | 'stateful';

  /** MCP tools exposed to agents (optional) */
  readonly tools?: ToolDefinition[];

  /** Initialize plugin with game context */
  init?(ctx: PluginContext): void;

  /** Process data through the plugin pipeline */
  handleData(mode: string, inputs: Map<string, any>): Map<string, any>;

  /** Handle a direct tool call from an agent */
  handleCall?(tool: string, args: unknown, caller: AgentInfo): unknown;
}

/** A single operating mode for a plugin. */
export interface PluginMode {
  /** Mode name */
  name: string;

  /** Capability types consumed as input */
  consumes: string[];

  /** Capability types produced as output */
  provides: string[];
}

/** Runtime context passed to plugin init. */
export interface PluginContext {
  gameType: string;
  gameId: string;
  turnCursor: number;
  relay: RelayClient;
  playerId: string;
}

/** Minimal relay client interface for plugins. */
export interface RelayClient {
  send(data: { pluginId: string; type: string; data: unknown; scope?: string }): void;
  receive(pluginId: string): unknown[];
}

/** Information about an agent calling a tool or in a game. */
export interface AgentInfo {
  id: string;
  handle: string;
  team?: string;
}

/** Tool definition declared by a plugin. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  /**
   * If true, this tool is also exposed as an MCP tool (not just CLI).
   * MCP tools are for mid-turn actions agents need in the flow.
   * CLI-only tools are for between-game or setup actions.
   * Default: false (CLI only via `coga tool <pluginId> <toolName>`).
   */
  mcpExpose?: boolean;
}

// ---------------------------------------------------------------------------
// LobbyPhase — pre-game pipeline stages
// ---------------------------------------------------------------------------

/** A single phase in the lobby pipeline. */
export interface LobbyPhase<TPhaseState = any> {
  /** Unique phase identifier */
  readonly id: string;

  /** Human-readable phase name */
  readonly name: string;

  /** Min players needed (null = whatever it receives) */
  readonly minPlayers?: number;

  /** Max players allowed */
  readonly maxPlayers?: number;

  /** Timeout in seconds before auto-advance */
  readonly timeout?: number;

  /** MCP tools available during this phase */
  readonly tools?: ToolDefinition[];

  /** Run the phase */
  run(ctx: PhaseContext): Promise<PhaseResult>;
}

/** Context passed to a lobby phase's run method. */
export interface PhaseContext {
  players: AgentInfo[];
  gameConfig: Record<string, any>;
  relay: RelayAccess;
  onTimeout(): PhaseResult;
}

/** Relay access scoped to a lobby phase. */
export interface RelayAccess {
  send(playerId: string, data: unknown): void;
  broadcast(data: unknown): void;
  receive(playerId: string): unknown[];
}

/** Result produced by a lobby phase. */
export interface PhaseResult {
  /** Players grouped for next phase or game start */
  groups: AgentInfo[][];
  /** Data collected during the phase (class picks, stakes, etc.) */
  metadata: Record<string, any>;
  /** Players removed during this phase */
  removed?: AgentInfo[];
}

// ---------------------------------------------------------------------------
// LobbyConfig — game-declared lobby flow
// ---------------------------------------------------------------------------

/** Lobby configuration declared by a game plugin. */
export interface GameLobbyConfig {
  queueType: 'open' | 'stake-tiered' | 'invite';
  phases: LobbyPhaseConfig[];
  matchmaking: MatchmakingConfig;
}

/** Reference to a lobby phase with its configuration. */
export interface LobbyPhaseConfig {
  phaseId: string;
  config: Record<string, any>;
}

/** Matchmaking parameters. */
export interface MatchmakingConfig {
  minPlayers: number;
  maxPlayers: number;
  teamSize: number;
  numTeams: number;
  queueTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Message type — canonical message with extensible tags
// ---------------------------------------------------------------------------

/** A chat message flowing through the plugin pipeline. */
export interface Message {
  /** Agent ID of sender */
  from: number;
  /** Message text */
  body: string;
  /** Turn number when sent */
  turn: number;
  /** Audience scope */
  scope: 'team' | 'all';
  /** Extensible tag bag — plugins enrich this */
  tags: Record<string, any>;
}
