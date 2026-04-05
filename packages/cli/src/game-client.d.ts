/**
 * GameClient — shared REST API wrapper with client-side pipeline.
 *
 * Used by both the CLI MCP server and (eventually) the bot harness.
 * Wraps ApiClient for REST calls to /api/player/* endpoints and runs
 * the client-side plugin pipeline over relay messages in responses.
 */
export interface GameClientOptions {
    /** Pre-existing auth token (skips challenge-response). */
    token?: string;
    /** Private key for wallet-based challenge-response auth. */
    privateKey?: string;
    /** Display name to register with the server. */
    name?: string;
}
export declare class GameClient {
    private api;
    private token;
    private privateKey;
    private name;
    private authPromise;
    private authenticated;
    constructor(serverUrl: string, options?: GameClientOptions);
    /** Get the current auth token (if any). */
    getToken(): string | null;
    /**
     * Authenticate with the server using wallet-based challenge-response.
     *
     * 1. Request a challenge nonce from the server
     * 2. Sign the challenge message with the private key
     * 3. Send signature + address + name to the server for verification
     * 4. Cache the returned token for all subsequent API calls
     */
    authenticate(privateKey: string): Promise<void>;
    /**
     * Ensure we are authenticated before making API calls.
     * If a private key was provided but we haven't authenticated yet, do so now.
     * Uses a single promise to avoid concurrent auth attempts.
     */
    ensureAuth(): Promise<void>;
    /** Get the dynamic game guide/playbook. */
    getGuide(): Promise<any>;
    /** Get current game/lobby state (fog-filtered, with pipeline processing). */
    getState(): Promise<any>;
    /** Long-poll for next event (turn change, chat, phase change). */
    waitForUpdate(): Promise<any>;
    /** Submit a gameplay move (direction path). */
    submitMove(path: string[]): Promise<any>;
    /** Submit a lobby-phase action (propose-team, accept-team, leave-team, choose-class). */
    submitAction(action: string, target?: string, cls?: string): Promise<any>;
    /** Send a chat message (routed by server based on current phase). */
    chat(message: string): Promise<any>;
    /** List available lobbies. */
    listLobbies(): Promise<any>;
    /** Join an existing lobby. */
    joinLobby(lobbyId: string): Promise<any>;
    /** Create a new lobby (auto-joins the creator). */
    createLobby(teamSize?: number): Promise<any>;
    /** Invite an agent to your team. */
    proposeTeam(agentId: string): Promise<any>;
    /** Accept a team invite. */
    acceptTeam(teamId: string): Promise<any>;
    /** Leave your current team. */
    leaveTeam(): Promise<any>;
    /** Choose your unit class (rogue, knight, mage). */
    chooseClass(cls: string): Promise<any>;
    /** Get ELO leaderboard. */
    getLeaderboard(limit?: number, offset?: number): Promise<any>;
    /** Get your own stats. */
    getMyStats(): Promise<any>;
    /**
     * Run the client-side plugin pipeline over relay messages in a response.
     * If the response contains relayMessages, processes them and merges
     * pipeline output back into the response.
     */
    private processResponse;
}
//# sourceMappingURL=game-client.d.ts.map