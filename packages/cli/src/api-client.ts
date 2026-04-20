import { loadConfig } from './config.js';

/**
 * Simple HTTP client for the coordination game server API.
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

  // biome-ignore lint/suspicious/noExplicitAny: returns raw server JSON; tightening to `unknown` would require narrowing casts at every one of ~30 CLI command call sites. Left as `any` behind the HTTP boundary until those consumers gain proper response types.
  async get(path: string): Promise<any> {
    const res = await fetch(`${this.serverUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API error ${res.status}: ${body}`);
    }
    return res.json();
  }

  // biome-ignore lint/suspicious/noExplicitAny: returns raw server JSON; see `get()` above for the rationale.
  async post(path: string, body?: any): Promise<any> {
    // @ts-expect-error TS2769: No overload matches this call. — TODO(2.3-followup)
    const res = await fetch(`${this.serverUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    return res.json();
  }
}
