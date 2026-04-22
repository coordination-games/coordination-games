import WebSocket from 'ws';
import { loadConfig } from './config.js';
import type {
  AuthChallengeResponse,
  AuthVerifyResponse,
  BalanceResponse,
  BurnExecuteResponse,
  BurnRequestResponse,
  CheckNameResponse,
  CreateLobbyResponse,
  GameBundle,
  JoinLobbyResponse,
  LobbySummary,
  OnChainResult,
  RegisterNameResponse,
  RelayStatusResponse,
  StateResponse,
} from './types.js';

/**
 * Translate the server's unified spectator envelope (`{type:'state_update',
 * meta, state, relay, currentPhase?, gameOver?}`) into the flat `StateResponse`
 * the CLI's downstream pipeline expects. Non-envelope responses (tool-result
 * bodies, error payloads, legacy shapes) pass through unchanged.
 *
 * Merge rules:
 *   - `state.*`             → top-level
 *   - `meta.gameType`       → `gameType`
 *   - `meta.gameId`         → `gameId` (falls back to `state.gameId`)
 *   - `relay`               → `relayMessages`
 *   - `meta.finished`/`gameOver` → `gameOver`
 *   - `state.currentPhase` (lobby: `{id,name,view}`) merged with
 *     `envelope.currentPhase` (auth-only: `{id,name,tools}`) into a single
 *     `currentPhase: {id, name, view?, tools?}`.
 */
export function flattenStateEnvelope(raw: unknown): StateResponse {
  if (!raw || typeof raw !== 'object') return (raw ?? {}) as StateResponse;
  const env = raw as Record<string, unknown>;
  const type = env.type;
  if (type !== 'state_update' && type !== 'spectator_pending') {
    return env as StateResponse;
  }
  const meta = (env.meta as Record<string, unknown> | undefined) ?? {};
  const state = (env.state as Record<string, unknown> | undefined) ?? {};
  const stateCurrentPhase = state.currentPhase as Record<string, unknown> | null | undefined;
  const envelopeCurrentPhase = env.currentPhase as Record<string, unknown> | undefined;
  const mergedCurrentPhase =
    stateCurrentPhase || envelopeCurrentPhase
      ? { ...(stateCurrentPhase ?? {}), ...(envelopeCurrentPhase ?? {}) }
      : undefined;
  const result: Record<string, unknown> = {
    ...state,
    gameType: meta.gameType,
    gameId: (meta.gameId as string | undefined) ?? (state.gameId as string | undefined),
    relayMessages: (env.relay as unknown[] | undefined) ?? [],
    gameOver: (env.gameOver as boolean | undefined) ?? (meta.finished as boolean | undefined),
  };
  if (mergedCurrentPhase !== undefined) result.currentPhase = mergedCurrentPhase;
  // Preserve any ad-hoc wrapper fields (`ok: true` from /action responses)
  // so downstream callers that still inspect them keep working.
  if ('ok' in env) result.ok = env.ok;
  if ('error' in env) result.error = env.error;
  return result as StateResponse;
}

/**
 * Resolve once the server signals a state change, or after `timeoutMs`. All
 * exit paths resolve (never reject): a caller that fetches state afterwards
 * has no reason to care whether the wakeup came from a live push or a
 * timeout.
 *
 * Frame handling:
 *   - The DO sends a snapshot-shaped payload immediately on connect. That
 *     first frame carries `meta.sinceIdx` — the server's relay tip after
 *     filtering by the client-supplied `sinceIdx` query param.
 *   - If `meta.sinceIdx > sinceIdxAtConnect`, the server already had
 *     pending deltas when we connected — finish immediately so the caller
 *     refetches state instead of waiting 25s for a second frame that may
 *     never come.
 *   - Otherwise the first frame is pure catchup-ack; discard it and wait
 *     for the next push (or timeout).
 *
 * Uses the `ws` npm package (not Node's built-in `WebSocket`) so we can
 * `.terminate()` the socket — a force-destroy that releases the event
 * loop hold immediately. The built-in's graceful `.close()` leaves the
 * TCP socket in CLOSE_WAIT for up to 30s on Cloudflare Workers, which
 * blocks CLI process exit. See `wiki/architecture/data-flow.md`
 * "Change Notification" for the CF-specific rationale.
 */
function waitForWsWakeup(url: string, timeoutMs: number, sinceIdxAtConnect: number): Promise<void> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let seenInitial = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.terminate();
      } catch {}
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      ws = new WebSocket(url);
    } catch {
      finish();
      return;
    }
    ws.on('message', (data) => {
      if (!seenInitial) {
        seenInitial = true;
        try {
          const frame = JSON.parse(data.toString()) as { meta?: { sinceIdx?: unknown } };
          const nextCursor = frame?.meta?.sinceIdx;
          if (typeof nextCursor === 'number' && nextCursor > sinceIdxAtConnect) {
            finish();
          }
        } catch {}
        return;
      }
      finish();
    });
    ws.on('error', finish);
    ws.on('close', finish);
  });
}

/**
 * Simple HTTP client for the coordination game server API.
 *
 * `get()` / `post()` return `unknown` — callers either pass through a typed
 * endpoint helper below or narrow the result themselves. The typed helpers
 * cover the ~8 endpoints the CLI calls repeatedly so command code doesn't
 * need to re-cast on every call.
 */
export class ApiClient {
  private serverUrl: string;
  private authToken?: string;
  /**
   * Relay delta cursor. Starts at 0 (full history on first read), advances
   * from each state envelope's `meta.sinceIdx`. The server clamps; we just
   * echo what it returns. Reset to 0 on auth change. Pure plumbing — the
   * MCP tool surface never exposes it to the agent.
   */
  private relayCursor = 0;
  /**
   * ETag cursor. Starts at 0 (force full state on first read), advances
   * from each state envelope's `meta.stateVersion`. Echoed back to the
   * server as `?knownStateVersion=N`; when it matches, the server emits
   * `state: null` and the client splices the cached block back in below.
   * Reset to 0 on auth change.
   */
  private stateVersionCursor = 0;
  /**
   * Last-seen state/currentPhase/gameOver bundle. Spliced back into the
   * raw envelope on an ETag hit (server sent `state: null`) so callers
   * downstream never know the wire payload was short. `null` = no cached
   * state yet; the next response will be a full snapshot.
   */
  private stateCache: {
    state: unknown;
    currentPhase?: unknown;
    gameOver?: boolean;
  } | null = null;

  constructor(serverUrl?: string) {
    this.serverUrl = serverUrl || loadConfig().serverUrl;
  }

  setAuthToken(token: string) {
    this.authToken = token;
    // New auth = new session = no assumed history.
    this.resetSessionCursors();
  }

  /**
   * Reset all per-session cursors + caches. Called on auth change and
   * exposed for the MCP `state` tool's `fresh: true` option.
   */
  resetSessionCursors(): void {
    this.relayCursor = 0;
    this.stateVersionCursor = 0;
    this.stateCache = null;
  }

  /** Bump the cursor from a server-supplied next-sinceIdx. */
  private advanceCursor(next: unknown): void {
    if (typeof next === 'number' && Number.isFinite(next) && next > this.relayCursor) {
      this.relayCursor = Math.floor(next);
    }
  }

  /**
   * Splice cached state back into an ETag-hit envelope (server sent
   * `state: null` meaning "you're up-to-date; reuse your cache"), or
   * refresh the cache from a full envelope. Mutates and returns `env`.
   * Non-envelope bodies pass through untouched.
   */
  private applyStateCache(env: Record<string, unknown>): Record<string, unknown> {
    if (env.type !== 'state_update') return env;
    const meta = env.meta as { stateVersion?: number } | undefined;
    if (meta && typeof meta.stateVersion === 'number') {
      this.stateVersionCursor = meta.stateVersion;
    }
    if (env.state === null && this.stateCache) {
      env.state = this.stateCache.state;
      if (this.stateCache.currentPhase !== undefined && env.currentPhase === undefined) {
        env.currentPhase = this.stateCache.currentPhase;
      }
      if (this.stateCache.gameOver !== undefined && env.gameOver === undefined) {
        env.gameOver = this.stateCache.gameOver;
      }
      return env;
    }
    if (env.state !== null && env.state !== undefined) {
      const entry: { state: unknown; currentPhase?: unknown; gameOver?: boolean } = {
        state: env.state,
      };
      if (env.currentPhase !== undefined) entry.currentPhase = env.currentPhase;
      if (typeof env.gameOver === 'boolean') entry.gameOver = env.gameOver;
      this.stateCache = entry;
    }
    return env;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      h.Authorization = `Bearer ${this.authToken}`;
    }
    return h;
  }

  async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error ${res.status}: ${body}`);
    }
    return res.json();
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = {
      method: 'POST',
      headers: this.headers(),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${this.serverUrl}${path}`, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Typed endpoint helpers — thin wrappers that cast into the shape the CLI
  // actually walks. The casts are safe at runtime because the server contract
  // is stable; using typed helpers keeps the per-call site free of `any`.
  // -------------------------------------------------------------------------

  async getRelayStatus(address: string): Promise<RelayStatusResponse> {
    return (await this.get(`/api/relay/status/${address}`)) as RelayStatusResponse;
  }

  async checkName(name: string): Promise<CheckNameResponse> {
    return (await this.get(
      `/api/relay/check-name/${encodeURIComponent(name)}`,
    )) as CheckNameResponse;
  }

  async registerName(body: {
    name: string;
    address: string;
    agentURI: string;
    permitDeadline: number;
    v: number;
    r: string;
    s: string;
  }): Promise<RegisterNameResponse> {
    return (await this.post('/api/relay/register', body)) as RegisterNameResponse;
  }

  async getBalance(agentId: string): Promise<BalanceResponse> {
    return (await this.get(`/api/relay/balance/${agentId}`)) as BalanceResponse;
  }

  async burnRequest(body: { agentId: string; amount: string }): Promise<BurnRequestResponse> {
    return (await this.post('/api/relay/burn-request', body)) as BurnRequestResponse;
  }

  async burnExecute(body: { agentId: string }): Promise<BurnExecuteResponse> {
    return (await this.post('/api/relay/burn-execute', body)) as BurnExecuteResponse;
  }

  async authChallenge(): Promise<AuthChallengeResponse> {
    return (await this.post('/api/player/auth/challenge')) as AuthChallengeResponse;
  }

  async authVerify(body: {
    nonce: string;
    signature: string;
    address: string;
    name: string;
  }): Promise<AuthVerifyResponse> {
    return (await this.post('/api/player/auth/verify', body)) as AuthVerifyResponse;
  }

  async listLobbies(): Promise<LobbySummary[]> {
    const raw = await this.get('/api/lobbies');
    return Array.isArray(raw) ? (raw as LobbySummary[]) : [];
  }

  async createLobby(body: { gameType?: string; teamSize: number }): Promise<CreateLobbyResponse> {
    return (await this.post('/api/lobbies/create', body)) as CreateLobbyResponse;
  }

  async joinLobby(lobbyId: string): Promise<JoinLobbyResponse> {
    return (await this.post('/api/player/lobby/join', { lobbyId })) as JoinLobbyResponse;
  }

  async getState(): Promise<StateResponse> {
    const raw = await this.get(
      `/api/player/state?sinceIdx=${this.relayCursor}&knownStateVersion=${this.stateVersionCursor}`,
    );
    const hydrated =
      raw && typeof raw === 'object'
        ? this.applyStateCache(raw as Record<string, unknown>)
        : (raw as Record<string, unknown>);
    this.advanceCursor((hydrated as { meta?: { sinceIdx?: unknown } } | undefined)?.meta?.sinceIdx);
    return flattenStateEnvelope(hydrated);
  }

  /**
   * Block until the server reports a state change on the caller's active
   * session, then return the fresh state. The server resolves lobby vs game
   * via `player_sessions` on `/ws/player`, so the client never carries a
   * lobby or game ID here — the same "your current session" scoping as
   * `/api/player/state` and `/api/player/tool`.
   *
   * `sinceIdx` rides along on the WS URL purely to shrink the initial
   * snapshot frame the server pushes on connect. The wakeup frames
   * themselves are discarded — fresh state comes from the follow-up
   * `getState()` which is the authoritative delta source.
   */
  async waitForUpdate(): Promise<StateResponse> {
    const { ticket } = (await this.post('/api/player/ws-ticket')) as { ticket: string };
    const sinceIdx = this.relayCursor;
    const wsUrl = `${this.serverUrl.replace(/^http/, 'ws')}/ws/player?ticket=${encodeURIComponent(ticket)}&sinceIdx=${sinceIdx}&knownStateVersion=${this.stateVersionCursor}`;
    await waitForWsWakeup(wsUrl, 25_000, sinceIdx);
    return this.getState();
  }

  async getGuide(game?: string): Promise<unknown> {
    const query = game ? `?game=${encodeURIComponent(game)}` : '';
    return this.get(`/api/player/guide${query}`);
  }

  async getGameBundle(gameId: string): Promise<GameBundle> {
    return (await this.get(`/api/games/${encodeURIComponent(gameId)}/bundle`)) as GameBundle;
  }

  async getGameResult(gameId: string): Promise<OnChainResult> {
    return (await this.get(`/api/games/${encodeURIComponent(gameId)}/result`)) as OnChainResult;
  }

  /**
   * Call a tool through the unified `/api/player/tool` endpoint.
   * Returns the raw JSON the server emits (success payload or `{error: ...}`
   * envelope); the ApiClient still throws on non-2xx. When the server responds
   * with a unified state envelope (lobby tools include the post-action state),
   * the envelope is flattened to the legacy `StateResponse` shape for CLI
   * consumers; other response shapes (game `/action`'s `{success,progressCounter}`,
   * plugin-relay bodies) pass through unchanged.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    // Every tool call returns a full state envelope now (Option A — unified
    // response shape across game/lobby/plugin-relay declarers). Cursors on
    // the URL drive the ETag short-circuit so chat-only paths stay tiny.
    const path = `/api/player/tool?sinceIdx=${this.relayCursor}&knownStateVersion=${this.stateVersionCursor}`;
    const raw = await this.post(path, { toolName, args });
    const hydrated =
      raw && typeof raw === 'object'
        ? this.applyStateCache(raw as Record<string, unknown>)
        : (raw as Record<string, unknown>);
    this.advanceCursor((hydrated as { meta?: { sinceIdx?: unknown } } | undefined)?.meta?.sinceIdx);
    return flattenStateEnvelope(hydrated);
  }
}
