import { loadConfig } from "./config.js";
/**
 * Simple HTTP client for the coordination game server API.
 */
export class ApiClient {
    serverUrl;
    authToken;
    constructor(serverUrl) {
        this.serverUrl = serverUrl || loadConfig().serverUrl;
    }
    setAuthToken(token) {
        this.authToken = token;
    }
    headers() {
        const h = {
            "Content-Type": "application/json",
        };
        if (this.authToken) {
            h["Authorization"] = `Bearer ${this.authToken}`;
        }
        return h;
    }
    async get(path) {
        const res = await fetch(`${this.serverUrl}${path}`, {
            headers: this.headers(),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`API error ${res.status}: ${body}`);
        }
        return res.json();
    }
    async post(path, body) {
        const res = await fetch(`${this.serverUrl}${path}`, {
            method: "POST",
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
//# sourceMappingURL=api-client.js.map