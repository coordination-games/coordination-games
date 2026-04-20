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
// Relay envelope — the canonical wire/storage shape for relay messages
// ---------------------------------------------------------------------------

/**
 * Discriminated audience scope for a relay envelope. Replaces the pre-4.1
 * `string` scope where 'all'/'team' were sentinels and any other value was a
 * recipient handle/playerId for DMs.
 */
export type RelayScope =
  | { kind: 'all' }
  | { kind: 'team'; teamId: string }
  | { kind: 'dm'; recipientHandle: string };

/**
 * The canonical relay message envelope — single shape used by LobbyDO,
 * GameRoomDO, plugins, and clients. `TBody` lets producers/consumers narrow
 * the payload type per `type` (e.g. chat body, vision update, etc.).
 */
export interface RelayEnvelope<TBody = unknown> {
  /** Monotonic per game/lobby. */
  index: number;
  /** Plugin-owned envelope type, e.g. 'chat:message'. */
  type: string;
  /** Plugin id that produced this envelope. */
  pluginId: string;
  /** playerId of the sender; 'system' for engine-emitted envelopes. */
  sender: string;
  /** Discriminated audience. */
  scope: RelayScope;
  /** Progress counter at send time. `null` in lobby (no turn yet). */
  turn: number | null;
  /** Wall-clock send time (ms epoch). */
  timestamp: number;
  /** Plugin-defined body. */
  data: TBody;
}

// ---------------------------------------------------------------------------
// Spectator context (passed to buildSpectatorView)
// ---------------------------------------------------------------------------

/** Context provided to buildSpectatorView by the framework. */
export interface SpectatorContext {
  /** Maps agent IDs to display names. */
  handles: Record<string, string>;
  /** Relay messages up to the current progress point (for delayed spectator views). */
  relayMessages: RelayEnvelope[];
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
  progressIncrement?: boolean; // true = this action advanced the game clock (turn/round resolved)
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
  applyAction(
    state: TState,
    playerId: string | null,
    action: TAction,
  ): ActionResult<TState, TAction>;

  /** What should this player see? null = spectator view. Game controls all visibility. */
  getVisibleState(state: TState, playerId: string | null): unknown;

  /** Is the game over? */
  isOver(state: TState): boolean;

  /**
   * Final outcome. Only valid when isOver() is true.
   *
   * The returned outcome is fed through `canonicalEncode` (see
   * `canonical-encoding.ts`) to produce deterministic `outcomeBytes` for
   * Merkle leaves and on-chain anchoring. The encoder enforces:
   *   - sorted-key JSON (insertion order does not matter)
   *   - `bigint` for all money values, serialized via `{ "__bigint": "..." }`
   *   - `number` only for counts/indices and only if `Number.isSafeInteger`;
   *     floats / `NaN` / `Infinity` are rejected
   *   - POJO + array only — `Map`, `Set`, `Date`, `undefined`, class
   *     instances, and functions are rejected
   *
   * Convert non-POJO state (Maps, Sets, etc.) to plain objects/arrays before
   * returning. See `wiki/architecture/contracts.md` for the full policy.
   */
  getOutcome(state: TState): TOutcome;

  /** Entry cost in credits per player. */
  readonly entryCost: number;

  /**
   * Credit payouts from outcome. Must be zero-sum and no single player delta may
   * be more negative than -entryCost (a player never loses more than their stake).
   * The framework re-validates both invariants before anchoring on-chain.
   *
   * All money values are `bigint` per the locked number policy
   * (`wiki/architecture/contracts.md`). Plugins MUST floor any divisions so the
   * result is integer-valued and deterministic.
   */
  computePayouts(outcome: TOutcome, playerIds: string[], entryCost: bigint): Map<string, bigint>;

  /** Lobby configuration. */
  readonly lobby?: GameLobbyConfig;

  /**
   * Player-callable tools during the game phase. Dispatcher reconstructs
   * `{type: tool.name, ...args}` before passing to validateAction/applyAction.
   */
  readonly gameTools?: ToolDefinition[];

  /** Delay in progress units (turns for CtL, rounds for OATHBREAKER). Default 0. */
  spectatorDelay?: number;

  /**
   * Build the spectator view for a given state. Required.
   * Called by GameRoomDO.getSpectatorView() to produce the frontend-ready
   * spectator payload. Each game defines its own shape.
   */
  buildSpectatorView(state: TState, prevState: TState | null, context: SpectatorContext): unknown;

  /** Game rules text (Markdown). Shown to agents via get_guide(). */
  guide?: string;

  /** Player-specific status text for the guide. */
  getPlayerStatus?(state: TState, playerId: string): string;

  /** Summary for game listing (lobby browser). */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  getSummary?(state: TState): Record<string, any>;

  /**
   * Summary derived from a *public* spectator-view snapshot instead of raw
   * game state. Called by the server to publish the live `/api/games`
   * summary without leaking fields that the delayed spectator view does
   * not yet reveal.
   *
   * If absent, the server falls back to calling `getSummary` with the
   * snapshot cast — which only works if the snapshot shape exposes the
   * same fields `getSummary` reads (same names, same types). Games whose
   * `getSummary` reads private fields (e.g. `state.config.turnLimit`)
   * MUST implement this. Games whose `getSummary` reads only fields that
   * are named identically on their SpectatorView can omit it.
   */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  getSummaryFromSpectator?(snapshot: unknown): Record<string, any>;

  /** IDs of players that need to submit an action in the current state. */
  getPlayersNeedingAction?(state: TState): string[];

  /** Required plugin IDs. */
  readonly requiredPlugins?: string[];

  /** Recommended plugin IDs. */
  readonly recommendedPlugins?: string[];

  /**
   * Chat scopes supported by this game. The server validates incoming
   * `type: 'messaging'` relay envelopes against this list and rejects
   * scopes that aren't allowed. Effective scope kinds:
   *   - 'all': broadcast to every participant
   *   - 'team': broadcast to the sender's team only (games with team structure)
   *   - 'dm':  directed at a specific player handle
   * Omit to accept all three. Games without teams (FFA like OATHBREAKER)
   * should declare `['all', 'dm']`.
   */
  readonly chatScopes?: ReadonlyArray<'all' | 'team' | 'dm'>;

  /**
   * Build a game config from a player list.
   * Called by the server when creating a game from a lobby or waiting room.
   * Returns the config plus relay-relevant player info (team assignments for message routing).
   */
  createConfig?(
    players: { id: string; handle: string; team?: string; role?: string }[],
    seed: string,
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    options?: Record<string, any>,
  ): GameSetup<TConfig>;
}

// ---------------------------------------------------------------------------
// GameSetup — returned by createConfig
// ---------------------------------------------------------------------------

/** Result of a plugin's createConfig — config plus relay-relevant player info. */
export interface GameSetup<TConfig> {
  /** The game config to pass to createInitialState. */
  config: TConfig;
  /** Player-to-team mapping for relay routing. Use 'FFA' for free-for-all games. */
  players: { id: string; team: string }[];
}

// ---------------------------------------------------------------------------
// Game result for on-chain anchoring
// ---------------------------------------------------------------------------

/** Game result for on-chain anchoring. */
export interface GameResult {
  gameId: string;
  gameType: string;
  players: string[]; // Player IDs (agentIds)
  outcome: unknown; // Game-specific outcome data
  movesRoot: string; // Merkle root of all actions
  configHash: string; // Hash of the game config
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
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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
  committed: number; // Locked in active games
  pendingBurns: number; // Awaiting burn execution
  available: number; // onChainBalance - committed - pendingBurns
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
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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
  send(data: { pluginId: string; type: string; data: unknown; scope?: RelayScope }): void;
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
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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
// LobbyPhase — pre-game pipeline stages (request-driven)
// ---------------------------------------------------------------------------

/** A single phase in the lobby pipeline (request-driven). */
// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
export interface LobbyPhase<TPhaseState = any> {
  readonly id: string;
  readonly name: string;

  /** Tools available during this phase (beyond always-on plugin tools). */
  readonly tools?: ToolDefinition[];

  /** Timeout in seconds. null = no timeout (rely on lobby-level timeout). */
  readonly timeout?: number | null;

  /**
   * Does this phase accept new players mid-phase?
   * true = handleJoin() will be called. false = joins rejected during this phase.
   * Default: false.
   */
  readonly acceptsJoins?: boolean;

  /** Create initial state for this phase. */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  init(players: AgentInfo[], config: Record<string, any>): TPhaseState;

  /**
   * Handle a player action during this phase.
   * Returns updated state + optional phase completion signal.
   *
   * Errors should be returned via the `error` field, not thrown.
   * The LobbyDO translates `error` into an HTTP 400/409 response.
   */
  handleAction(
    state: TPhaseState,
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    action: { type: string; playerId: string; payload?: any },
    players: AgentInfo[],
  ): PhaseActionResult<TPhaseState>;

  /**
   * Handle a player joining mid-phase.
   * Only called if `acceptsJoins` is true.
   */
  handleJoin?(
    state: TPhaseState,
    player: AgentInfo,
    allPlayers: AgentInfo[],
  ): PhaseActionResult<TPhaseState>;

  /**
   * Handle timeout expiry.
   * Must produce a PhaseResult (possibly with removed players) or null to fail the lobby.
   */
  handleTimeout(state: TPhaseState, players: AgentInfo[]): PhaseResult | null;

  /**
   * Build the lobby state view for a given player (or spectator if undefined).
   * This is what gets returned in GET /state under `currentPhase.view`.
   */
  getView(state: TPhaseState, playerId?: string): unknown;

  /**
   * Optional: resolve team membership for relay routing.
   * If omitted, team-scoped messages fall back to "all" scope.
   */
  getTeamForPlayer?(state: TPhaseState, playerId: string): string | null;
}

/** Result of handling an action within a phase. */
// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
export interface PhaseActionResult<TPhaseState = any> {
  /** Updated phase state. */
  state: TPhaseState;
  /** If set, this phase is complete. Advance to next or start game. */
  completed?: PhaseResult;
  /** Relay messages to broadcast (chat, team updates, etc.). */
  relay?: Array<{ type: string; data: unknown; scope: RelayScope; pluginId: string }>;
  /** If set, the action failed. LobbyDO returns this as an HTTP error response. */
  error?: { message: string; status?: number };
}

/** Result when a phase completes. */
export interface PhaseResult {
  /** Players grouped for next phase or game start.
   *  For team games: each group = a team.
   *  For FFA: single group with all players.
   */
  groups: AgentInfo[][];
  /**
   * Data collected during the phase.
   * MUST include player-level assignments that createConfig() needs.
   * E.g. TeamFormation: { teams: [{ id, members }] }
   * E.g. ClassSelection: { classPicks: { [playerId]: 'rogue' | 'knight' | 'mage' } }
   */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  metadata: Record<string, any>;
  /** Players removed during this phase. */
  removed?: AgentInfo[];
}

// ---------------------------------------------------------------------------
// LobbyConfig — game-declared lobby flow
// ---------------------------------------------------------------------------

/** Lobby configuration declared by a game plugin. */
export interface GameLobbyConfig {
  queueType: 'open' | 'stake-tiered' | 'invite';
  /** Phase instances. Every game must have at least one. */
  phases: LobbyPhase[];
  matchmaking: MatchmakingConfig;
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
  /** Sender — playerId string (mirrors RelayEnvelope.sender). */
  from: string;
  /** Message text */
  body: string;
  /** Turn number when sent (null in lobby). */
  turn: number | null;
  /** Audience scope */
  scope: 'team' | 'all';
  /** Extensible tag bag — plugins enrich this */
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred
  tags: Record<string, any>;
}
