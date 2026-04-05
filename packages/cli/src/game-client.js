/**
 * GameClient — shared REST API wrapper with client-side pipeline.
 *
 * Used by both the CLI MCP server and (eventually) the bot harness.
 * Wraps ApiClient for REST calls to /api/player/* endpoints and runs
 * the client-side plugin pipeline over relay messages in responses.
 */
import { ethers } from "ethers";
import { ApiClient } from "./api-client.js";
import { processState } from "./pipeline.js";
export class GameClient {
    api;
    token = null;
    privateKey = null;
    name = null;
    authPromise = null;
    authenticated = false;
    constructor(serverUrl, options) {
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
    getToken() {
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
    async authenticate(privateKey) {
        const wallet = new ethers.Wallet(privateKey);
        const name = this.name || wallet.address.slice(0, 10);
        // 1. Request challenge
        const challenge = await this.api.post('/api/player/auth/challenge');
        // 2. Sign the challenge message
        const signature = await wallet.signMessage(challenge.message);
        // 3. Verify with server
        const result = await this.api.post('/api/player/auth/verify', {
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
    async ensureAuth() {
        if (this.authenticated)
            return;
        if (!this.privateKey)
            return; // No key — caller must handle auth themselves
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
    async getGuide() {
        await this.ensureAuth();
        return this.api.get('/api/player/guide');
    }
    /** Get current game/lobby state (fog-filtered, with pipeline processing). */
    async getState() {
        await this.ensureAuth();
        const raw = await this.api.get('/api/player/state');
        return this.processResponse(raw);
    }
    /** Long-poll for next event (turn change, chat, phase change). */
    async waitForUpdate() {
        await this.ensureAuth();
        const raw = await this.api.get('/api/player/wait');
        return this.processResponse(raw);
    }
    /** Submit a gameplay move (direction path). */
    async submitMove(path) {
        await this.ensureAuth();
        return this.api.post('/api/player/move', { path });
    }
    /** Submit a lobby-phase action (propose-team, accept-team, leave-team, choose-class). */
    async submitAction(action, target, cls) {
        await this.ensureAuth();
        const body = { action };
        if (target)
            body.target = target;
        if (cls)
            body.class = cls;
        return this.api.post('/api/player/move', body);
    }
    /** Send a chat message (routed by server based on current phase). */
    async chat(message) {
        await this.ensureAuth();
        return this.api.post('/api/player/chat', { message });
    }
    // ---------------------------------------------------------------------------
    // Lobby operations
    // ---------------------------------------------------------------------------
    /** List available lobbies. */
    async listLobbies() {
        await this.ensureAuth();
        return this.api.get('/api/lobbies');
    }
    /** Join an existing lobby. */
    async joinLobby(lobbyId) {
        await this.ensureAuth();
        return this.api.post('/api/player/lobby/join', { lobbyId });
    }
    /** Create a new lobby (auto-joins the creator). */
    async createLobby(teamSize) {
        await this.ensureAuth();
        return this.api.post('/api/player/lobby/create', { teamSize });
    }
    // ---------------------------------------------------------------------------
    // Team operations
    // ---------------------------------------------------------------------------
    /** Invite an agent to your team. */
    async proposeTeam(agentId) {
        await this.ensureAuth();
        return this.api.post('/api/player/team/propose', { agentId });
    }
    /** Accept a team invite. */
    async acceptTeam(teamId) {
        await this.ensureAuth();
        return this.api.post('/api/player/team/accept', { teamId });
    }
    /** Leave your current team. */
    async leaveTeam() {
        await this.ensureAuth();
        return this.api.post('/api/player/team/leave');
    }
    /** Choose your unit class (rogue, knight, mage). */
    async chooseClass(cls) {
        await this.ensureAuth();
        return this.api.post('/api/player/class', { class: cls });
    }
    // ---------------------------------------------------------------------------
    // Stats
    // ---------------------------------------------------------------------------
    /** Get ELO leaderboard. */
    async getLeaderboard(limit, offset) {
        await this.ensureAuth();
        const params = new URLSearchParams();
        if (limit != null)
            params.set('limit', String(limit));
        if (offset != null)
            params.set('offset', String(offset));
        const qs = params.toString();
        return this.api.get(`/api/player/leaderboard${qs ? '?' + qs : ''}`);
    }
    /** Get your own stats. */
    async getMyStats() {
        await this.ensureAuth();
        return this.api.get('/api/player/stats');
    }
    // ---------------------------------------------------------------------------
    // Pipeline processing
    // ---------------------------------------------------------------------------
    /**
     * Run the client-side plugin pipeline over relay messages in a response.
     * If the response contains relayMessages, processes them and merges
     * pipeline output back into the response.
     */
    processResponse(raw) {
        if (raw && raw.relayMessages && Array.isArray(raw.relayMessages) && raw.relayMessages.length > 0) {
            const output = processState(raw);
            return {
                ...raw,
                messages: output.messages,
                pipelineOutput: Object.fromEntries(output.pipelineOutput),
            };
        }
        return raw;
    }
}
//# sourceMappingURL=game-client.js.map