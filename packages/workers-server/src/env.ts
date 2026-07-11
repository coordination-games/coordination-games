export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  TOURNAMENT?: DurableObjectNamespace;
  ENVIRONMENT: string;
  // Optional — set via `wrangler secret put` to enable on-chain ERC-8004 verification.
  // RPC_URLS (comma-separated list of RPC endpoints) takes precedence over RPC_URL
  // and provides automatic fallover on transport errors. RPC_URL is kept for the
  // single-endpoint case and as a fallback when RPC_URLS is unset.
  RPC_URLS?: string;
  RPC_URL?: string;
  REGISTRY_ADDRESS?: string;
  ERC8004_ADDRESS?: string;
  CREDITS_ADDRESS?: string;
  GAME_ANCHOR_ADDRESS?: string;
  USDC_ADDRESS?: string;
  RELAYER_PRIVATE_KEY?: string;
  // Optional — set via `wrangler secret put ADMIN_TOKEN` to enable
  // GET /api/admin/session/:id/tools. Header: X-Admin-Token: <value>.
  ADMIN_TOKEN?: string;
  // Optional — set via `wrangler secret put LIGHTHOUSE_API_KEY` and
  // TRUST_IPFS_PUBLISH_ENABLED=true to publish privacy-safe trust evidence
  // bundles from the server-side worker/DO pipeline. Never expose this to web.
  LIGHTHOUSE_API_KEY?: string;
  TRUST_IPFS_PUBLISH_ENABLED?: string;
  TRUST_IPFS_VERIFY_GATEWAY?: string;
  /**
   * Optional registered, non-playing D1 player handle appended only to the
   * final on-chain settlement with a zero delta. Missing/unregistered rows
   * fail settlement closed rather than silently falling back.
   */
  TREASURY_AGENT_HANDLE?: string;
}
