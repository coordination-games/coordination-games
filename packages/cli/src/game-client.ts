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

  constructor(serverUrl: string, options?: GameClientOptions) {
    this.api = new ApiClient(serverUrl);
    if (options?.token) {
      this.token = options.token;
      this.api.setAuthToken(options.token);
      this.authenticated = true;
    }
    if (options?.privateKey) {
      this.privateKey = options.privateKey;
    }
    if (options?.name) {
      this.name = options.name;
    }
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
    if (options.fresh) this.api.resetSessionCursors();
    const raw = await this.api.getState();
    return this.processResponse(raw);
  }

  /** Long-poll for next event (turn change, chat, phase change). */
  async waitForUpdate(): Promise<StateResponse> {
    await this.ensureAuth();
    const raw = await this.api.waitForUpdate();
    return this.processResponse(raw);
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
    const raw = (await this.api.callTool(toolName, args)) as StateResponse;
    return this.processResponse(raw);
  }

  /**
   * Like `callTool` but returns the raw structured error payload instead of
   * throwing. Use this when the caller needs to inspect `error.code` to
   * self-correct (e.g. MCP tool handlers returning structured errors to the
   * agent).
   */
  async callToolRaw(toolName: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.ensureAuth();
    try {
      const raw = (await this.api.callTool(toolName, args)) as StateResponse;
      return { ok: true, data: this.processResponse(raw) };
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
    try {
      const raw = (await this.api.callTool('plugin_relay', { relay })) as StateResponse;
      return this.processResponse(raw);
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

  /** Join an existing lobby or OATHBREAKER waiting room. */
  async joinLobby(lobbyId: string): Promise<JoinLobbyResponse> {
    await this.ensureAuth();
    return this.api.joinLobby(lobbyId);
  }

  /** Create a new lobby (auto-joins the creator). */
  async createLobby(gameType?: string, size?: number): Promise<CreateLobbyResponse> {
    await this.ensureAuth();
    if (gameType === OATH_GAME_ID) {
      // For OATHBREAKER, teamSize is the total player count to auto-start (4-20)
      const teamSize = Math.min(20, Math.max(4, size || 4));
      return this.api.createLobby(gameType ? { gameType, teamSize } : { teamSize });
    }
    const teamSize = Math.min(6, Math.max(2, size || 2));
    return this.api.createLobby(gameType ? { gameType, teamSize } : { teamSize });
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
}
