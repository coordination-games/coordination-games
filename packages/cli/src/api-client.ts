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
 * Resolve once the target WS emits its first message after the initial
 * snapshot, or after `timeoutMs`. All exit paths resolve (never reject): a
 * caller that fetches state afterwards has no reason to care whether the
 * wakeup came from an actual server push or a timeout.
 *
 * The DO sends a snapshot immediately on connect; that first frame is
 * ignored. Any subsequent frame (or a close/error) ends the wait.
 */
function waitForWsWakeup(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let frames = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
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
    ws.addEventListener('message', () => {
      frames += 1;
      if (frames >= 2) finish();
    });
    ws.addEventListener('error', finish);
    ws.addEventListener('close', finish);
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

  constructor(serverUrl?: string) {
    this.serverUrl = serverUrl || loadConfig().serverUrl;
  }

  setAuthToken(token: string) {
    this.authToken = token;
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
    return flattenStateEnvelope(await this.get('/api/player/state'));
  }

  /**
   * Block until the server reports a lobby or game state change, then return
   * the fresh player state. Opens a WebSocket to the player's current DO
   * (lobby spectator or authenticated game player), waits for the first
   * post-snapshot push, closes the socket, and refetches state via HTTP.
   *
   * If the player isn't in a lobby or game, or the WS wakeup times out, this
   * falls back to returning the current HTTP state — callers then decide
   * whether to call again.
   */
  async waitForUpdate(): Promise<StateResponse> {
    const state = await this.getState();
    const lobbyId = state.lobbyId as string | undefined;
    const gameId = state.gameId as string | undefined;
    const loc: 'game' | 'lobby' | null = gameId ? 'game' : lobbyId ? 'lobby' : null;
    if (!loc) return state;

    const wsBase = this.serverUrl.replace(/^http/, 'ws');
    let wsUrl: string;
    if (loc === 'game') {
      const { ticket } = (await this.post('/api/player/ws-ticket')) as { ticket: string };
      wsUrl = `${wsBase}/ws/game/${gameId}/player?ticket=${encodeURIComponent(ticket)}`;
    } else {
      wsUrl = `${wsBase}/ws/lobby/${lobbyId}`;
    }

    await waitForWsWakeup(wsUrl, 25_000);
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
    return flattenStateEnvelope(await this.post('/api/player/tool', { toolName, args }));
  }
}
