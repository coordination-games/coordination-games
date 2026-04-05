/**
 * Simple HTTP client for the coordination game server API.
 */
export declare class ApiClient {
    private serverUrl;
    private authToken?;
    constructor(serverUrl?: string);
    setAuthToken(token: string): void;
    private headers;
    get(path: string): Promise<any>;
    post(path: string, body?: any): Promise<any>;
}
//# sourceMappingURL=api-client.d.ts.map