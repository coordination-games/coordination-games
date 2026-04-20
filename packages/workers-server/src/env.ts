export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
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
}
