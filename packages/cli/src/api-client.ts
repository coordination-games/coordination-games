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
    return (await this.get('/api/player/state')) as StateResponse;
  }

  async waitForUpdate(): Promise<StateResponse> {
    return (await this.get('/api/player/wait')) as StateResponse;
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
   * envelope); the ApiClient still throws on non-2xx.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.post('/api/player/tool', { toolName, args });
  }
}
