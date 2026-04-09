export interface Env {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  ENVIRONMENT: string;
  // Optional — set via `wrangler secret put` to enable on-chain ERC-8004 verification
  RPC_URL?: string;
  REGISTRY_ADDRESS?: string;
  ERC8004_ADDRESS?: string;
  RELAYER_PRIVATE_KEY?: string;
}
