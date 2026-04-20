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

  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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

  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
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
