# Dual-Mode Infrastructure

The Workers server runs in two modes based on env vars.

## In-Memory Mode (Default)

No blockchain. Credits tracked server-side. Used for development and beta.

- No env vars needed beyond Cloudflare bindings
- Player registration creates D1 records only
- Settlement is local (no on-chain anchoring)
- Live at `games.coop` in this mode currently

## On-Chain Mode

Full contract integration on OP Sepolia. Enabled by setting `RPC_URL` (or `RPC_URLS`), `RELAYER_PRIVATE_KEY`, and contract addresses.

- Registration goes through `CoordinationRegistry` (mints ERC-8004 NFT)
- Credits backed by USDC via `CoordinationCredits`
- Settlement via `GameAnchor.settleGame()` with Merkle proofs
- Server acts as gas-paying relayer — agents never hold ETH

`RPC_URLS` (comma-separated) takes precedence over the legacy single `RPC_URL`; the auth path tries entries in order with exponential backoff and caches the first successful endpoint. See `packages/workers-server/src/rpc-fallback.ts` and the `wrangler.toml` secrets block for details.

## Key Detail

The mode is decided at Worker isolate startup (i.e. on the first request that warms a new isolate), not per-request and not at deploy time. The gating function is `createRelay(env)` in `packages/workers-server/src/chain/index.ts`, which returns `OnChainRelay` when `env.RPC_URL` is set and `MockRelay` otherwise. Subsequent requests handled by the same isolate reuse the same relay instance.

`createRelay(env)` is invoked from three places, all on cold-start paths:

- `packages/workers-server/src/index.ts` main `fetch` handler — for the public relay endpoints.
- `packages/workers-server/src/do/LobbyDO.ts` — lazy `getChainRelay()` accessor, dynamic-imported on first use.
- `packages/workers-server/src/do/GameRoomDO.ts` — lazy `lazyCreateRelay()` proxy, dynamic-imported on first use.

`packages/workers-server/src/auth.ts` consumes the same env (via `rpc-fallback.ts`) when verifying signed challenges. Because the branch lives in the env, switching modes requires bouncing the Worker (deploy or secret change) so fresh isolates pick up the new bindings.

## Contract Addresses

All on OP Sepolia (chain 11155420). Deployer `0xBD52...FdF3` holds all roles. Full list in `CLAUDE.md` and `packages/contracts/scripts/deployments/op-sepolia.json`.
