# Dual-Mode Infrastructure
> One Worker codebase, two runtime modes. The mode is decided at isolate cold-start by a single env var, and every callsite that touches the chain goes through the same `ChainRelay` interface so the rest of the server doesn't know which mode it's in.

## Why

Production runs on OP Sepolia; local dev and CI cannot. We need bots, lobbies, and settlement to exercise the *same code paths* in both worlds — otherwise on-chain bugs hide behind dev-mode shortcuts and dev work blocks on RPC availability. The collapsed alternative — making every plugin / DO branch on `if (chainEnabled)` itself — was rejected once and would be rejected again: it leaks chain awareness into game-author code, and every game would have to remember to gate every credit read.

Instead the branch is pushed down to one factory (`createRelay`) returning one interface (`ChainRelay`). The DO, the settlement plugin, the auth path, the relay endpoints — all hold a `ChainRelay` and call `getBalance` / `register` / `submit` without caring which implementation is on the other end. `MockRelay` and `OnChainRelay` have to match shapes exactly, and they do (`packages/workers-server/src/chain/types.ts`, both implementations next to it).

The scar that pins this in place: `MockRelay.submit` is intentionally a no-op that returns a fake tx hash and `pollReceipt` returns `'confirmed'` immediately (`packages/workers-server/src/chain/mock-relay.ts:97-111`). That means dev-mode settlement runs the *full* state machine — `pending → submitted → confirmed`, alarms and all — and silently drops the deltas. If we'd built dev mode by short-circuiting the state machine, the on-chain settlement path would only ever exercise on prod and we'd find every bug live. With the relay-shaped mock, the state machine is the same code in both modes; only the leaf side-effect differs.

## How

**The env-var gate.** `createRelay(env)` (`packages/workers-server/src/chain/index.ts:10`):

```typescript
export function createRelay(env: Env): ChainRelay {
  return env.RPC_URL ? new OnChainRelay(env) : new MockRelay(env.DB);
}
```

That's the entire branch. `env.RPC_URL` set → on-chain; unset → in-memory. The `Env` interface (`packages/workers-server/src/env.ts:1`) lists every chain-mode secret as optional: `RPC_URLS`, `RPC_URL`, `RELAYER_PRIVATE_KEY`, `REGISTRY_ADDRESS`, `ERC8004_ADDRESS`, `CREDITS_ADDRESS`, `GAME_ANCHOR_ADDRESS`, `USDC_ADDRESS`. `wrangler.toml:31-42` documents them with the expectation that they're set via `wrangler secret put`.

**Where `createRelay` is called.** Four callsites, all on cold-start paths so the same isolate reuses the same relay flavor for the rest of its life:

- `packages/workers-server/src/index.ts:135` — main `fetch` handler, instantiates one relay per request for the public `/api/relay/*` endpoints.
- `packages/workers-server/src/auth.ts:165` — `handleAuthVerify`, after the optional ERC-8004 ownership check, to resolve / create the player record.
- `packages/workers-server/src/do/LobbyDO.ts:138` — `getChainRelay()`, lazy-imported on first join (pre-game balance gate).
- `packages/workers-server/src/do/GameRoomDO.ts:249` — `lazyCreateRelay()`, lazy-imported on first settlement-bound action (`submit` / `pollReceipt`).

The two DO accessors are dynamic-imported (`import('../chain/index.js')`) so a DO that never settles doesn't pay viem's module-load cost.

**What swaps.** The `ChainRelay` interface (`packages/workers-server/src/chain/types.ts`) is the contract; both implementations cover every method:

| Method | `MockRelay` | `OnChainRelay` |
|---|---|---|
| `getAgentByAddress` | D1 `players` lookup, returns `MOCK_CREDIT_BALANCE` | D1 cache → live `CoordinationCredits.balances` read |
| `getBalance` | constant `MOCK_CREDIT_BALANCE` (`mock-relay.ts:35`) | `CoordinationCredits.balances(agentId)` via viem |
| `register` | `resolvePlayer` writes a D1 row, no NFT mint | `CoordinationRegistry.registerNew()` mints ERC-8004 |
| `topup` / `requestBurn` / `executeBurn` / `cancelBurn` | throws `'… not available in mock mode'` | viem `writeContract` against `CoordinationCredits` |
| `submit` | no-op, fake tx hash, monotonic nonce (`mock-relay.ts:98-105`) | `GameAnchor.settleGame()` with merkle root + deltas |
| `pollReceipt` | always `{ status: 'confirmed', blockNumber: 0 }` (`mock-relay.ts:107-111`) | live `getTransactionReceipt` |

`MOCK_CREDIT_BALANCE = '1000000000000000000'` (`mock-relay.ts:35`) — ~10^12 whole credits, picked specifically to clear any plausible `entryCost` so the `LobbyDO.handleJoin` balance gate (`packages/workers-server/src/do/LobbyDO.ts:939`) passes for everyone in dev without bypassing the gate code itself.

**ID strategy.** Mock mode invents player IDs in D1 (`resolvePlayer`); on-chain mode uses the ERC-8004 token id, cached into `players.chain_agent_id`. The `chain_agent_id` column is the bridge — settlement requires it (`kickOffSettlement` skips with a log if any player is missing one, `packages/workers-server/src/do/GameRoomDO.ts:1281`).

**RPC fallback (on-chain mode only).** `RPC_URLS` (comma-separated) takes precedence over single `RPC_URL` *for the auth path only*. `parseRpcUrls(env)` (`packages/workers-server/src/rpc-fallback.ts:45`) reads `env.RPC_URLS ?? env.RPC_URL`; `createFallbackPublicClient` (`:121`) is consumed by `auth.ts:106` for the ERC-8004 ownership check, with exponential backoff and per-request URL caching. `OnChainRelay` itself uses the single `env.RPC_URL` directly (`packages/workers-server/src/chain/onchain-relay.ts:97`); no fallback there. See gotchas.

**Mode change requires a deploy.** The branch lives in the env, the env binds at isolate startup. `wrangler secret put RPC_URL …` doesn't reach in-flight isolates; you bounce them by re-deploying. Dev/CI just doesn't set the secret and gets MockRelay forever.

## Edge cases & gotchas

- **`RPC_URLS` set, `RPC_URL` unset → MockRelay.** `createRelay` checks `env.RPC_URL` literally (`chain/index.ts:11`). If a deployer configures only the comma-list secret, the relay endpoints and DOs run mock-mode while `auth.ts` happily verifies ERC-8004 ownership via the fallback client. Symptom: registered users authenticate fine, then get dev-mode credit balances on every `getBalance`. Either set both secrets, or set `RPC_URL` to the first entry of `RPC_URLS`.
- **`OnChainRelay` doesn't use the fallback client.** `OnChainRelay`'s viem clients are built with single-URL `http(env.RPC_URL)` (`onchain-relay.ts:97, 194, 276, 408, 446, 496, 531`). Only the auth-path ERC-8004 check (`auth.ts:106`) survives a flaky primary RPC. A relay-endpoint failure during `topup` or settlement just propagates the transport error.
- **Dev-mode settlement looks like it works, doesn't.** `MockRelay.submit` returns a fake tx hash, `pollReceipt` returns `'confirmed'` instantly. The settlement state machine drives `pending → submitted → confirmed`, the D1 `games` row gets a `tx_hash` written, and `coga balance` afterwards shows no change because no chain ever moved. By design — but don't infer "credits work in dev" from a successful settlement log line.
- **Mode is per-isolate, not per-request.** A secret push doesn't flip live isolates. If you `wrangler secret put RPC_URL …` and `coga balance` keeps returning the mock value, the isolate is stale; force a redeploy or wait for natural eviction.
- **Lazy DO imports hide mode-mismatch errors.** `LobbyDO` and `GameRoomDO` import `chain/index.js` on first relay use, not at construction. A typo'd `OnChainRelay` (e.g. wrong contract ABI) won't break DO startup — it'll surface at the first join or first settlement, mid-game. Worth running an end-to-end on a deploy preview before pushing.
- **`MockRelay` writes don't throw silently.** All four credit-mutating methods (`topup`, `requestBurn`, `executeBurn`, `cancelBurn`) throw `'… not available in mock mode'` (`mock-relay.ts:76-90`). If a UI surface or test assumes mock-mode credits are mutable, it fails loud — that's intentional, the alternative is dev-mode credit drift that doesn't reproduce on-chain.
- **`chain_agent_id` is required for on-chain settlement.** A player joined a lobby in mock mode (no `chain_agent_id`), the deploy got promoted to on-chain, that lobby finishes — `kickOffSettlement` logs and skips (`GameRoomDO.ts:1281`). No partial settle, no chain corruption; the local D1 `games` row still gets `finished = 1`.

## Pointers

- `packages/workers-server/src/chain/index.ts` — `createRelay` factory, the entire branch.
- `packages/workers-server/src/chain/types.ts` — `ChainRelay` interface that both implementations must match.
- `packages/workers-server/src/chain/mock-relay.ts` — `MockRelay`, `MOCK_CREDIT_BALANCE`, no-op `submit`.
- `packages/workers-server/src/chain/onchain-relay.ts` — `OnChainRelay`, viem clients, contract ABIs.
- `packages/workers-server/src/env.ts` — every chain-mode secret, all optional.
- `packages/workers-server/src/rpc-fallback.ts` — `parseRpcUrls`, `createFallbackPublicClient`; auth-path-only.
- `packages/workers-server/wrangler.toml` — secret list, build command, DO bindings.
- `wiki/architecture/contracts.md` — the 5 contracts, addresses, on-chain settlement flow.
- `wiki/architecture/credit-economics.md` — pre-game gate, settlement invariants, payout models.
- `wiki/operations/deploy.md` — `wrangler deploy` vs `pages deploy`, `CLOUDFLARE_API_TOKEN` requirement.
