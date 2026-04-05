export declare const DEFAULT_SERVER_URL = "https://capturethelobster.com";
export interface Config {
    serverUrl: string;
    keyMode: "local" | "waap";
}
/** Session state persisted between CLI invocations */
export interface SessionState {
    /** Auth token from MCP signin */
    token?: string;
    /** Server-assigned agent ID */
    agentId?: string;
    /** MCP session ID for reusing transport sessions */
    mcpSessionId?: string;
    /** Current game ID (tracked after joining a lobby that starts a game) */
    currentGameId?: string;
    /** Current lobby ID */
    currentLobbyId?: string;
    /** Display name used for signin */
    handle?: string;
}
export declare function loadConfig(): Config;
export declare function saveConfig(config: Config): void;
export declare function loadSession(): SessionState;
export declare function saveSession(session: SessionState): void;
//# sourceMappingURL=config.d.ts.map