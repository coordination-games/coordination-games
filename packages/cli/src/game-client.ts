/**
 * GameClient — shared REST API wrapper with client-side pipeline.
 *
 * Used by both the CLI MCP server and the bot harness. Wraps ApiClient for
 * REST calls and runs the client-side plugin pipeline over relay messages
 * in responses.
 *
 * Since the unified-tool-surface cutover, all player-callable actions go
 * through a single endpoint: POST /api/player/tool { toolName, args }.
 * The server dispatches by declarer (game / lobby phase / plugin relay).
 */

import { OATH_GAME_ID } from '@coordination-games/game-oathbreaker';
import { ethers } from 'ethers';
import * as agentPersistence from './agent-persistence.js';
import { AgentStateDiffer } from './agent-state-differ.js';
import { ApiClient } from './api-client.js';
import { processState } from './pipeline.js';
import type {
  CreateLobbyResponse,
  JoinLobbyResponse,
  LobbySummary,
  StateResponse,
  ToolResult,
} from './types.js';

export interface GameClientOptions {
  /** Pre-existing auth token (skips challenge-response). */
  token?: string;
  /** Private key for wallet-based challenge-response auth. */
  privateKey?: string;
  /** Display name to register with the server. */
  name?: string;
}

export class GameClient {
  private api: ApiClient;
  private token: string | null = null;
  private privateKey: string | null = null;
  private name: string | null = null;
  private authPromise: Promise<void> | null = null;
  private authenticated = false;
  /**
   * Cached wallet address derived from `privateKey`. Used as the agent
   * identity for persisted per-scope state. Null when GameClient was
   * constructed without a key (token-only mode) — in that case no
   * scope-based persistence happens, which matches the plan's "scoped
   * code paths only" rule.
   */
  private agentAddress: string | null = null;
  /**
   * Current scope ID — a game-or-lobby ID. Null for unscoped commands
   * (`listLobbies`, `getGuide`). When set (and `agentAddress` is set),
   * state-fetching methods propagate this to ApiClient so cursor reads
   * and writes go through `~/.coordination/agent-state.json`.
   */
  private scopeId: string | null = null;
  /**
   * Per-client top-level-key diff. Only applied to state-fetching methods
   * when a scope is active (scope rule, matches persistence). The baseline
   * round-trips through `agent-persistence` so `coga state` invoked from
   * separate shell processes against the same `(agent, scope)` correctly
   * dedups the second call. In-memory is just a hot-path optimization; the
   * disk copy is the source of truth.
   */
  private differ: AgentStateDiffer = new AgentStateDiffer();

  constructor(serverUrl: string, options?: GameClientOptions) {
    this.api = new ApiClient(serverUrl);
    if (options?.token) {
      this.token = options.token;
      this.api.setAuthToken(options.token);
      this.authenticated = true;
    }
    if (options?.privateKey) {
      this.privateKey = options.privateKey;
      try {
        this.agentAddress = new ethers.Wallet(options.privateKey).address;
      } catch {
        // Invalid key — auth will fail later with a clearer error; leave
        // agentAddress null so persistence is skipped.
      }
    }
    if (options?.name) {
      this.name = options.name;
    }
  }

  /**
   * Set the active scope (game ID or lobby ID) for persisted cursor state.
   *
   * Callers: game/lobby-scoped code paths ONLY. After `joinLobby`, after
   * `createLobby` for OATHBREAKER (which auto-starts a game), and
   * opportunistically from state responses that carry a gameId. Unscoped
   * commands (list lobbies, balance, identity) must not call this.
   *
   * Calling with the same scopeId twice is a no-op; switching scopes
   * rebinds ApiClient immediately. Passing an empty string clears the
   * scope (equivalent to unscoped mode).
   */
  setScope(scopeId: string): void {
    if (!scopeId) {
      this.clearScope();
      return;
    }
    if (this.scopeId === scopeId) return;
    // Scope change — reset every per-scope piece of state so the old
    // game's cursor/baseline can't contaminate the new scope's first
    // fetch. `ApiClient.setScope` below then hydrates the new scope's
    // persisted cursor (if any) via `loadPersistedCursor` on the next
    // state call; same goes for the differ, which reloads from the
    // new scope's persisted `lastSeen` at entry.
    this.api.resetSessionCursors();
    this.differ.reset();
    this.scopeId = scopeId;
    // Skip persistence entirely when we have no agent identity.
    if (!this.agentAddress) return;
    this.api.setScope(this.agentAddress, scopeId);
  }

  /** Clear any active scope. Used by tests and by token-only flows. */
  clearScope(): void {
    this.scopeId = null;
    this.api.clearScope();
    // An unscoped GameClient still has a differ instance but no caller
    // path reads from it — `applyAgentDiff` short-circuits on null scope.
    // Reset for hygiene: a later re-scope starts from a clean baseline.
    this.differ.reset();
  }

  /**
   * If a state response carries a gameId or lobbyId and we don't have a
   * scope yet (or have a coarser one), upgrade. Keeps `coga state` from a
   * freshly-restarted shell able to pick up a persisted cursor once it
   * learns which game it's in. Best-effort — never throws.
   */
  private maybeUpgradeScopeFromState(state: StateResponse): void {
    if (!state || typeof state !== 'object') return;
    const gameId = typeof state.gameId === 'string' ? state.gameId : undefined;
    // LobbyDO responses may expose lobbyId; `flattenStateEnvelope` spreads
    // `state.*` so any server-set `lobbyId` lands here.
    const lobbyId =
      typeof (state as { lobbyId?: unknown }).lobbyId === 'string'
        ? ((state as { lobbyId?: string }).lobbyId as string)
        : undefined;
    const next = gameId ?? lobbyId;
    if (!next) return;
    if (this.scopeId === next) return;
    this.setScope(next);
  }

  /** Get the current auth token (if any). */
  getToken(): string | null {
    return this.token;
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Authenticate with the server using wallet-based challenge-response.
   *
   * 1. Request a challenge nonce from the server
   * 2. Sign the challenge message with the private key
   * 3. Send signature + address + name to the server for verification
   * 4. Cache the returned token for all subsequent API calls
   */
  async authenticate(privateKey: string): Promise<void> {
    const wallet = new ethers.Wallet(privateKey);
    const name = this.name || wallet.address.slice(0, 10);

    // 1. Request challenge
    const challenge = await this.api.authChallenge();

    // 2. Sign the challenge message
    const signature = await wallet.signMessage(challenge.message);

    // 3. Verify with server
    const result = await this.api.authVerify({
      nonce: challenge.nonce,
      signature,
      address: wallet.address,
      name,
    });

    // 4. Cache the token
    this.token = result.token;
    this.api.setAuthToken(result.token);
    this.authenticated = true;
  }

  /**
   * Ensure we are authenticated before making API calls.
   * If a private key was provided but we haven't authenticated yet, do so now.
   * Uses a single promise to avoid concurrent auth attempts.
   */
  async ensureAuth(): Promise<void> {
    if (this.authenticated) return;
    if (!this.privateKey) return; // No key — caller must handle auth themselves
    if (!this.authPromise) {
      this.authPromise = this.authenticate(this.privateKey).catch((err) => {
        this.authPromise = null; // Allow retry on failure
        throw err;
      });
    }
    await this.authPromise;
  }

  // ---------------------------------------------------------------------------
  // Game operations — REST + pipeline
  // ---------------------------------------------------------------------------

  /** Get the dynamic game guide/playbook. */
  async getGuide(game?: string): Promise<unknown> {
    await this.ensureAuth();
    return this.api.getGuide(game);
  }

  /**
   * Get current game/lobby state (fog-filtered, with pipeline processing).
   *
   * Pass `fresh: true` to bypass the client-side ETag cache and force a
   * full state refetch — useful when the caller suspects drift, or when
   * the agent explicitly asks to re-sync. The default (false) echoes the
   * last-seen `stateVersion` and lets the server omit unchanged state.
   */
  async getState(options: { fresh?: boolean | undefined } = {}): Promise<StateResponse> {
    await this.ensureAuth();
    if (options.fresh) {
      // Clear BOTH in-memory cursors and the on-disk `(agent, scope)`
      // entry before the fetch. Without the on-disk clear, a fresh
      // process would immediately hydrate the old cursor back in
      // `ApiClient.loadPersistedCursor` and the fetch would still be
      // a delta. The disk clear is a no-op when we have no scope yet
      // (which matches pre-Phase-1 behaviour for unscoped callers).
      this.api.resetSessionCursors();
      this.differ.reset();
      if (this.agentAddress && this.scopeId) {
        agentPersistence.clear(this.agentAddress, this.scopeId);
      }
    }
    this.loadPersistedLastSeen();
    const raw = await this.api.getState();
    const processed = this.processResponse(raw);
    this.maybeUpgradeScopeFromState(processed);
    return this.applyAgentDiff(processed);
  }

  /**
   * Long-poll for next event (turn change, chat, phase change).
   *
   * Pass `fresh: true` to reset agent persistence (in-memory cursors +
   * on-disk `(agent, scope)` entry) before the wait. Mirrors `getState`'s
   * `fresh` semantics so shell parity with the MCP `fresh` option is
   * maintained across both read paths.
   */
  async waitForUpdate(options: { fresh?: boolean | undefined } = {}): Promise<StateResponse> {
    await this.ensureAuth();
    if (options.fresh) {
      // Same reset as getState({ fresh: true }): clear in-memory cursors
      // and the on-disk `(agent, scope)` entry. The subsequent
      // api.waitForUpdate() calls loadPersistedCursor() which, with the
      // entry gone, leaves the just-reset in-memory cursor at 0 so the
      // follow-up getState() refetches the full envelope.
      this.api.resetSessionCursors();
      this.differ.reset();
      if (this.agentAddress && this.scopeId) {
        agentPersistence.clear(this.agentAddress, this.scopeId);
      }
    }
    this.loadPersistedLastSeen();
    const raw = await this.api.waitForUpdate();
    const processed = this.processResponse(raw);
    this.maybeUpgradeScopeFromState(processed);
    return this.applyAgentDiff(processed);
  }

  /**
   * Call a tool by name. This is the sole dispatch path for all
   * player-callable actions since the unified-tool-surface cutover.
   *
   * - Game-phase tools (e.g. `move`): dispatcher reconstructs
   *   `{type: toolName, ...args}` and forwards to GameRoomDO.
   * - Lobby-phase tools (e.g. `propose-team`, `choose-class`): dispatcher
   *   forwards `{type: toolName, payload: args}` to LobbyDO.
   * - Plugin relay tools: call `callPluginRelay(...)` instead.
   *
   * On server error, the response payload carries a structured
   * `{ error: { code, message, ... } }` shape (see error taxonomy in
   * docs/plans/unified-tool-surface.md). ApiClient throws on non-2xx, so
   * the caller sees the JSON body in err.message — callers that need the
   * structured shape should use `callToolRaw` below.
   */
  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<StateResponse> {
    await this.ensureAuth();
    this.loadPersistedLastSeen();
    const raw = (await this.api.callTool(toolName, args)) as StateResponse;
    const processed = this.processResponse(raw);
    this.maybeUpgradeScopeFromState(processed);
    return this.applyAgentDiff(processed);
  }

  /**
   * Like `callTool` but returns the raw structured error payload instead of
   * throwing. Use this when the caller needs to inspect `error.code` to
   * self-correct (e.g. MCP tool handlers returning structured errors to the
   * agent).
   */
  async callToolRaw(toolName: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.ensureAuth();
    this.loadPersistedLastSeen();
    try {
      const raw = (await this.api.callTool(toolName, args)) as StateResponse;
      const processed = this.processResponse(raw);
      this.maybeUpgradeScopeFromState(processed);
      return { ok: true, data: this.applyAgentDiff(processed) };
    } catch (err: unknown) {
      // ApiClient throws `API error <status>: <body>` — try to parse the body.
      const msg = err instanceof Error ? err.message : String(err);
      const match = msg.match(/^API error \d+: (.*)$/s);
      if (match?.[1]) {
        try {
          const body = JSON.parse(match[1]) as {
            error?: { code: string; message: string; [k: string]: unknown };
          };
          if (body && typeof body === 'object' && body.error) {
            return { ok: false, error: body.error };
          }
        } catch {
          // fallthrough — treat as dispatch failure
        }
      }
      return { ok: false, error: { code: 'DISPATCH_FAILED', message: msg } };
    }
  }

  /**
   * Invoke a client-side ToolPlugin that posts a relay envelope to the
   * server. The plugin's `handleCall()` returns `{ relay: {...} }`; this
   * wraps that envelope into the unified endpoint's wire format.
   *
   * Error codes added per the plan's error taxonomy:
   * - `PLUGIN_ERROR`    — plugin.handleCall threw
   * - `RELAY_UNREACHABLE` — relay endpoint returned 5xx
   */
  async callPluginRelay(relay: {
    type: string;
    pluginId: string;
    data?: unknown;
    scope?: string;
  }): Promise<StateResponse> {
    await this.ensureAuth();
    this.loadPersistedLastSeen();
    try {
      const raw = (await this.api.callTool('plugin_relay', { relay })) as StateResponse;
      const processed = this.processResponse(raw);
      this.maybeUpgradeScopeFromState(processed);
      return this.applyAgentDiff(processed);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // 5xx = relay unreachable; parse status from "API error <status>: ..."
      const statusMatch = msg.match(/^API error (\d+):/);
      const status = statusMatch?.[1] ? parseInt(statusMatch[1], 10) : 0;
      if (status >= 500 && status < 600) {
        const structured = {
          error: {
            code: 'RELAY_UNREACHABLE',
            message: `Plugin relay endpoint unreachable (HTTP ${status}): ${msg}`,
          },
        };
        throw Object.assign(new Error(structured.error.message), { structured });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Lobby operations
  // ---------------------------------------------------------------------------

  /** List available lobbies. */
  async listLobbies(): Promise<LobbySummary[]> {
    await this.ensureAuth();
    return this.api.listLobbies();
  }

  /**
   * Join an existing lobby or OATHBREAKER waiting room. Sets this
   * GameClient's scope to the lobbyId so subsequent `getState`/`wait`
   * calls persist their cursor under `(agent, lobbyId)`. A later state
   * response carrying `gameId` will upgrade the scope automatically.
   */
  async joinLobby(lobbyId: string): Promise<JoinLobbyResponse> {
    await this.ensureAuth();
    const result = await this.api.joinLobby(lobbyId);
    // Only scope on success — a failed join shouldn't pin us to a lobby we
    // aren't in. `result.error` is the server's error envelope; absent =
    // success per `ErrorEnvelope`.
    if (!result.error) {
      this.setScope(lobbyId);
    }
    return result;
  }

  /**
   * Create a new lobby (auto-joins the creator). Scopes the GameClient
   * to the returned lobbyId (CtL) or gameId (OATHBREAKER, which skips the
   * lobby phase).
   */
  async createLobby(gameType?: string, size?: number): Promise<CreateLobbyResponse> {
    await this.ensureAuth();
    let result: CreateLobbyResponse;
    if (gameType === OATH_GAME_ID) {
      // For OATHBREAKER, teamSize is the total player count to auto-start (4-20)
      const teamSize = Math.min(20, Math.max(4, size || 4));
      result = await this.api.createLobby(gameType ? { gameType, teamSize } : { teamSize });
    } else {
      const teamSize = Math.min(6, Math.max(2, size || 2));
      result = await this.api.createLobby(gameType ? { gameType, teamSize } : { teamSize });
    }
    if (!result.error) {
      const scope = result.gameId ?? result.lobbyId;
      if (scope) this.setScope(scope);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Pipeline processing
  // ---------------------------------------------------------------------------

  /**
   * Run the client-side plugin pipeline over relay messages in a response
   * and splice each plugin's declared envelope extensions (see
   * `ToolPlugin.agentEnvelopeKeys`) onto the top-level response. The server
   * filters relay envelopes by the client's `sinceIdx` cursor, so plugin
   * outputs carry only items new since the last observation.
   */
  private processResponse(raw: StateResponse): StateResponse {
    if (!raw || typeof raw !== 'object') return raw;
    const { relayMessages: _r, ...rest } = raw;
    const hasRelay = Array.isArray(raw.relayMessages) && raw.relayMessages.length > 0;
    if (!hasRelay) return rest;
    const { envelopeExtensions } = processState(raw);
    return { ...rest, ...envelopeExtensions } as StateResponse;
  }

  /**
   * Apply the top-level-key differ as the final step of a state-returning
   * method. Only active when a scope is set (persistence scope rule:
   * unscoped commands like `coga lobbies` return raw state with no dedup).
   *
   * The baseline round-trips through disk: before the call, `GameClient`
   * hydrates the differ from the persisted `lastSeen`; after the call,
   * it writes the updated `lastSeen` back. That's what lets `coga state`
   * from two separate shell processes dedup against each other.
   */
  private applyAgentDiff(result: StateResponse): StateResponse {
    // Unscoped callers opt out of dedup entirely. Matches Phase 1's
    // persistence-scope rule: `coga lobbies`, `coga wallet`, identity
    // commands — their output is raw, not diffed. Only game/lobby-scoped
    // calls get the stable baseline that makes dedup correct.
    if (!this.agentAddress || !this.scopeId) return result;
    const diffed = this.differ.diff(result);
    // Persist the updated baseline so the next `coga state` process
    // inherits it. Best-effort: a disk error must not fail the agent's
    // state fetch — worst case we lose one round-trip of dedup.
    try {
      const entry = agentPersistence.read(this.agentAddress, this.scopeId);
      const relayCursor = entry && typeof entry.relayCursor === 'number' ? entry.relayCursor : 0;
      agentPersistence.write(this.agentAddress, this.scopeId, {
        relayCursor,
        lastSeen: this.differ.getLastSeen(),
      });
    } catch (err) {
      process.stderr.write(
        `agent-persistence: failed to write lastSeen (${
          err instanceof Error ? err.message : String(err)
        })\n`,
      );
    }
    return diffed as StateResponse;
  }

  /**
   * Hydrate the differ's baseline from disk for the active scope, if any.
   * Called at entry of every state-returning method so a freshly-spawned
   * process inherits the last observation from prior invocations.
   */
  private loadPersistedLastSeen(): void {
    if (!this.agentAddress || !this.scopeId) return;
    const entry = agentPersistence.read(this.agentAddress, this.scopeId);
    if (!entry) return;
    // Rebuild the differ with the persisted baseline. Cheap: the diff is
    // stateful only on the single `lastSeen` field; constructor validates
    // shape (non-object falls back to null).
    this.differ = new AgentStateDiffer(entry.lastSeen as Record<string, unknown> | null);
  }
}
