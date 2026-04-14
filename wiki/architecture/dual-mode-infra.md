# Dual-Mode Infrastructure

The Workers server runs in two modes based on env vars.

## In-Memory Mode (Default)

No blockchain. Credits tracked server-side. Used for development and beta.

- No env vars needed beyond Cloudflare bindings
- Player registration creates D1 records only
- Settlement is local (no on-chain anchoring)
- Live at `capturethelobster.com` in this mode currently

## On-Chain Mode

Full contract integration on OP Sepolia. Enabled by setting `RPC_URL`, `RELAYER_PRIVATE_KEY`, and contract addresses.

- Registration goes through `CoordinationRegistry` (mints ERC-8004 NFT)
- Credits backed by USDC via `CoordinationCredits`
- Settlement via `GameAnchor.settleGame()` with Merkle proofs
- Server acts as gas-paying relayer — agents never hold ETH

## Key Detail

The server checks for env vars at request time, not startup. Code paths in `relay.ts` and `auth.ts` branch on whether `env.RPC_URL` is set. This means you can add/remove on-chain mode without redeploying — just change secrets.

## Contract Addresses

All on OP Sepolia (chain 11155420). Deployer `0xBD52...FdF3` holds all roles. Full list in `CLAUDE.md` and `packages/contracts/scripts/deployments/op-sepolia.json`.
