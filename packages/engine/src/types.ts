/**
 * Core types for the Coordination Games framework.
 *
 * A game plugin implements CoordinationGame<TConfig, TState, TMove, TOutcome>.
 * The platform handles lobbies, auth, turn resolution, spectator feeds,
 * move signing, and on-chain settlement.
 */

// ---------------------------------------------------------------------------
// Ethereum / EIP-712 primitives
// ---------------------------------------------------------------------------

/** An Ethereum address (0x-prefixed hex string). */
export type Address = string;

/** A single field in an EIP-712 type definition. */
export interface EIP712Field {
  name: string;
  type: string;
}

/** EIP-712 type definitions — maps type names to their field arrays. */
export type EIP712TypeDef = Record<string, EIP712Field[]>;

/** EIP-712 domain separator. */
export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

// ---------------------------------------------------------------------------
// Game plugin interface
// ---------------------------------------------------------------------------

/**
 * The core game plugin interface. Each game (CtL, OATHBREAKER, etc.)
 * implements this interface. The platform handles everything else.
 *
 * Hard requirements for all games:
 * 1. Turn-based — simultaneous moves within a turn, sequential turns
 * 2. Deterministic resolution — same inputs always produce same outputs
 * 3. Discrete entry — player joins a lobby, entry fee deducted, game starts
 * 4. Signed moves — every move is EIP-712 typed data signed by player's wallet
 * 5. Finite — games must have a termination condition
 *
 * @template TConfig - Game configuration (map seed, team size, etc.)
 * @template TState - Full game state (board, units, scores, etc.)
 * @template TMove - A single player's move for one turn
 * @template TOutcome - Game result (winner, scores, etc.)
 */
export interface CoordinationGame<TConfig, TState, TMove, TOutcome> {
  /** Unique game type identifier, e.g. "capture-the-lobster", "oathbreaker" */
  readonly gameType: string;

  /** Semantic version for replay compatibility */
  readonly version: string;

  /**
   * EIP-712 type definition for this game's moves.
   * gameId + turnNumber are always included by the platform wrapper.
   * The rest is game-specific.
   */
  readonly moveSchema: EIP712TypeDef;

  /**
   * Create the initial game state from configuration.
   * Must be deterministic given the same config.
   */
  createInitialState(config: TConfig): TState;

  /**
   * Validate whether a move is legal in the current state for a given player.
   * Returns true if the move is valid.
   */
  validateMove(state: TState, playerId: string, move: TMove): boolean;

  /**
   * THE CORE LOOP — resolve a turn. MUST be deterministic.
   * Given current state and all player moves, produce the next state.
   */
  resolveTurn(state: TState, moves: Map<string, TMove>): TState;

  /** Is the game over? */
  isOver(state: TState): boolean;

  /** Get the game outcome. Only valid when isOver() returns true. */
  getOutcome(state: TState): TOutcome;

  /** Entry cost in credits per player. */
  readonly entryCost: number;

  /**
   * Compute credit payouts from the game outcome.
   * Returns a map of playerId -> credit delta (positive = win, negative = loss).
   * Must be zero-sum: all deltas must sum to zero.
   */
  computePayouts(outcome: TOutcome, playerIds: string[]): Map<string, number>;

  /** Lobby flow configuration (phases, matchmaking, queue type). */
  readonly lobby?: GameLobbyConfig;

  /** Plugin IDs that must be installed to play this game. */
  readonly requiredPlugins?: string[];

  /** Plugin IDs that are recommended but not required. */
  readonly recommendedPlugins?: string[];
}

// ---------------------------------------------------------------------------
// Game state metadata (managed by the framework, not the plugin)
// ---------------------------------------------------------------------------

/** Phases of a game room's lifecycle. */
export type GameRoomPhase =
  | 'lobby'       // Waiting for players
  | 'pre_game'    // Team formation, class selection
  | 'in_progress' // Game is running
  | 'finished'    // Game is over
  | 'settled';    // On-chain settlement complete

/** A signed move submission from a player. */
export interface SignedMove<TMove> {
  playerId: string;
  move: TMove;
  signature?: string;  // EIP-712 signature (optional during transition)
  turnNumber: number;
  gameId: string;
}

/** Turn record stored by the framework for Merkle tree construction. */
export interface TurnData<TMove> {
  turnNumber: number;
  moves: SignedMove<TMove>[];
  stateHash: string;  // Hash of the state after resolution
}

/** Game result for on-chain anchoring. */
export interface GameResult {
  gameId: string;
  gameType: string;
  players: string[];    // Player IDs (agentIds)
  outcome: unknown;     // Game-specific outcome data
  movesRoot: string;    // Merkle root of all turns
  configHash: string;   // Hash of the game config
  turnCount: number;
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
  /** Turn timeout in milliseconds */
  turnTimeoutMs?: number;
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

/** MCP tool definition exposed by a plugin. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
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
