# Identity and Auth
> Identity is an ERC-8004 NFT keyed by an Ethereum address; auth is a wallet-signed challenge that mints a 24h bearer token. Bots use the exact same path as players — there is no shortcut, by design.

## Why

The platform commits to ERC-8004 as the identity layer because we want one canonical answer to "who is this agent" that survives across our server, the relayer, and any third-party tool that cares: a token id on a public registry, owned by an address, with a unique on-chain display name. The wrapper (`CoordinationRegistry`, `packages/contracts/contracts/CoordinationRegistry.sol:12`) adds two things ERC-8004 doesn't: name uniqueness (the `nameToAgent` mapping at `:19`) and a $5 USDC entry fee that doubles as an initial credit grant ($1 to treasury, $4 minted as 400 credits via `INITIAL_CREDITS_USDC` at `:26`). Without the wrapper we'd be racing on names and gating registration through some off-chain database; both are worse.

Wallet-signed auth falls out of that commitment: if the canonical identity is "address that owns ERC-8004 token N," then the only honest challenge-response is "prove you control that address by signing this nonce." A username/password store would have to either trust us as a custodian of the identity (we don't want to be) or live alongside the on-chain record (drift guaranteed). Signed-nonce auth is just a thin proof that the bearer token we hand back is bound to the same key that owns the on-chain agent.

**Bots use the same auth path as players.** This is non-negotiable. Phase 0.2 of System cleanup v2 (`5087624`) deleted the previous `createBotToken()` shortcut after we discovered it had silently bypassed every signature-replay protection added in subsequent hardening — bots got tokens "for free" while real players ran the full nonce/verify dance, and any auth-side fix shipped to the player path was invisible to bots. The repair was to delete the bypass entirely. Now every bot has its own wallet (ephemeral or pool-persisted) and `GameClient` runs the same challenge/verify before its first request (`packages/cli/src/game-client.ts:173-195`). The load-bearing consequence: any future hardening — rate limits, replay windows, registration gating — covers bots automatically. See `wiki/development/bot-system.md` for bot wallet sourcing.

## How

**The two signature standards in this repo.** The reader needs to keep these straight; the codebase uses both, for different things.

- **EIP-191 personal_sign** (the `\x19Ethereum Signed Message:\n…` format) is what the **auth challenge** uses. The CLI calls `wallet.signMessage(challenge.message)` (`packages/cli/src/game-client.ts:181`); the server verifies via viem's `verifyMessage` (`packages/workers-server/src/auth.ts:83`). The signed payload is the literal string `Sign this message to authenticate with Coordination Games.\nNonce: <hex>` (`packages/workers-server/src/auth.ts:22`). No typed-data domain, no struct hashing — just a prefixed message.
- **EIP-2612 USDC permit** (typed-data ERC-20 approval) is what **registration** uses. The CLI calls `signPermit` (`packages/cli/src/signing.ts:26`), which signs the canonical `Permit(owner,spender,value,nonce,deadline)` struct under USDC's `EIP712Domain { name: 'USD Coin', version: '2', chainId, verifyingContract }` (`:35-50`). The split `{v, r, s}` rides in the `POST /api/relay/register` body (`packages/workers-server/src/index.ts:176-208`), and `OnChainRelay.register` passes it straight into `CoordinationRegistry.registerNew(user, name, agentURI, deadline, v, r, s)` which calls `usdc.permit(...)` on-chain (`packages/contracts/contracts/CoordinationRegistry.sol:50-65`). The user never broadcasts an approve transaction; the relayer does it for them inside `registerNew`.

A general EIP-712 helper (`signing.ts:67`) and an `AuthChallenge` typed-data variant (`signing.ts:80`) exist in tree but are not called by any live path. If the reader sees `signTypedData` in commits, that's where it lives — but today the only EIP-712 signature on the wire is the USDC permit.

**Registration flow** (mainnet path):

1. `coga init` generates a local secp256k1 wallet at `~/.coordination/keys/default.json` (mode `0600`, dir `0700`; `packages/cli/src/keys.ts:40-58`). `checkPermissions()` (`:63`) warns SSH-style if the file is group-readable.
2. `coga check-name <name>` hits `GET /api/relay/check-name` → `CoordinationRegistry.checkName` (`packages/contracts/contracts/CoordinationRegistry.sol:111`).
3. User funds the wallet with 5 USDC on OP Sepolia.
4. `coga register <name>`:
   - Signs an EIP-2612 permit for `5_000_000n` (raw USDC units) with `deadline = now + 1h` (`packages/cli/src/commands/names.ts:93-101`).
   - POSTs `{name, address, agentURI, permitDeadline, v, r, s}` to `/api/relay/register`.
   - Server's `OnChainRelay.register` (`packages/workers-server/src/chain/onchain-relay.ts:187`) calls `registerNew`. The contract pulls 5 USDC via `usdc.permit + transferFrom`, mints the ERC-8004 NFT to `user`, writes `nameToAgent` / `displayName` / `registered`, sends $1 to treasury, and calls `creditContract.mintFor(agentId, 4_000_000)` for the 400-credit grant (`CoordinationRegistry._register`, lines 87-108).
   - Receipt parses the `Registered(address,uint256,string)` event for the new `agentId` (`onchain-relay.ts:236-240`); `resolvePlayer` caches `chain_agent_id` in D1.
5. CLI persists the registered handle to its session file (`commands/names.ts:113-116`).

Existing ERC-8004 holders take the same shape via `registerExisting` (`CoordinationRegistry.sol:68`); the wrapper checks `canonical8004.ownerOf(agentId) == user` instead of minting.

**Auth flow** (every fresh `coga` process):

1. CLI `POST /api/player/auth/challenge` (`packages/workers-server/src/auth.ts:20`). Server generates a 32-byte hex nonce, persists it in `auth_nonces` with a 5-minute TTL (`CHALLENGE_TTL_MS`, `:7`), returns `{nonce, message, expiresAt}`.
2. CLI signs `message` with EIP-191 personal_sign (`game-client.ts:181`).
3. CLI `POST /api/player/auth/verify` with `{nonce, signature, address, name}` (`auth.ts:39`). Server:
   - Looks up + **deletes** the nonce row (`:73`) — single-use even on later failure paths.
   - `verifyMessage` checks the recovered address matches the claimed one (`:83-87`).
   - Optional ERC-8004 ownership check when `RPC_URLS` and `REGISTRY_ADDRESS`/`ERC8004_ADDRESS` are set (`:101-161`): `nameToAgent(keccak256(name.toLowerCase()))` → `ownerOf(agentId)`, must equal claimed address. Uses `createFallbackPublicClient` so a flaky RPC URL doesn't fail the auth (`packages/workers-server/src/rpc-fallback.ts:121`).
   - `resolvePlayer` reads-through D1 → relay; idempotent on reconnect (`auth.ts:170`).
   - Issues a 20-byte hex bearer token, persists in `auth_sessions` with a 24h TTL (`SESSION_TTL_MS`, `:8`), returns `{token, agentId, name, expiresAt, reconnected}`.
4. CLI caches the token on `GameClient` and injects it as `Authorization: Bearer <token>` on every subsequent REST call (`game-client.ts:191-194`).

**Per-request verification.** Every authenticated endpoint runs `requireAuth` (`packages/workers-server/src/index.ts:60`) → `validateBearerToken` (`auth.ts:201`), which selects from `auth_sessions` by token, expires lazily on lookup (deletes the row, returns null), and returns `playerId` or 401. The Worker then forwards identity to the Durable Object as `X-Player-Id` (`index.ts:405, 451, 477`); the DO trusts only that header and the `playerId` query param is explicitly stripped from the forwarded URL (`:402, 449`). This split is from `fbbf282 fix(server): identity comes from X-Player-Id header, never request bodies` — the DO never re-reads identity from the request body.

**WebSocket auth.** Native WS clients can't set `Authorization` headers on the upgrade. `POST /api/player/ws-ticket` (Bearer-authed) calls `createWsTicket` (`auth.ts:234`) to mint a single-use UUID with a 30-second TTL; the client appends `?ticket=<uuid>` to the WS URL; `consumeWsTicket` (`:248`) deletes the row unconditionally on lookup so a leaked URL can't be replayed. The long-lived bearer token never appears in access logs.

## Edge cases & gotchas

- **The auth challenge is EIP-191, not EIP-712.** The legacy comment `// Verify EIP-712 signature` at `packages/workers-server/src/auth.ts:79` is wrong; the code on the next line is `verifyMessage`, which is personal_sign. If you go to add structured-data fields (server URL, chain id, expiry) to the challenge, you'll be migrating from EIP-191 to EIP-712 — `signing.ts:80` has a stub `signAuthChallenge` that defines the typed-data shape, currently uncalled.
- **`signMove` is dead code today.** `signing.ts:107` and the `MoveData.signature: string` comment in `merkle.ts:18` describe a per-move EIP-712 signing scheme. Nothing in the live action path calls `signMove`; moves are recorded in turn data but not signed by the player wallet. Don't read the merkle leaf comment as proof we sign moves — we don't.
- **`name` and `address` in `/auth/verify` are claims, not identity.** The signature only proves control of `address`. The optional ERC-8004 check binds `name → agentId → ownerOf` to the claimed address; without `RPC_URLS` set (mock mode), the server trusts the claimed name as long as `resolvePlayer` accepts it. In mock mode there is no on-chain identity to compare against — by design, see `wiki/architecture/dual-mode-infra.md`.
- **Nonces are single-use even on failed verifies.** `auth.ts:73` deletes the row before the signature check, so a bad signature on a stolen nonce can't be retried with the right one. A retry has to re-fetch a fresh nonce.
- **Bearer tokens expire lazily.** `validateBearerToken` deletes expired rows on read (`:215`); there's no background sweep. Tokens past their TTL return 401 on first use after the deadline.
- **Registration permit deadline is 1 hour, not session-length.** `commands/names.ts:93` sets `deadline = now + 3600`. If the user signs the permit and walks away, they need to re-sign — by design, since the permit authorises a real on-chain transfer.
- **No `coga`-side signin/register MCP tool, by design.** Auth is done by `GameClient` below the surface that both shell and MCP share (`mcp-not-on-server.md`). Exposing auth as an MCP tool would let an agent harness skip the wallet abstraction.
- **Bot wallets are real wallets.** Pool bots (`~/.coordination/bot-pool.json`) hold private keys, were registered via the same `coga register` flow, and authenticate per-process. Don't grep for "bot mode" in the auth path — there isn't one.

## Pointers

- `packages/workers-server/src/auth.ts` — `handleAuthChallenge` (line 20), `handleAuthVerify` (line 39), `validateBearerToken` (line 201), WS tickets (`createWsTicket` line 234, `consumeWsTicket` line 248).
- `packages/cli/src/game-client.ts:173` — `authenticate`, the EIP-191 sign-and-verify dance.
- `packages/cli/src/signing.ts` — `signPermit` (line 26, EIP-2612), `signTypedData` (line 67, generic helper), `signAuthChallenge` (line 80, unused EIP-712 stub), `signMove` (line 107, unused).
- `packages/cli/src/keys.ts` — local wallet generation, `0600/0700` permissions.
- `packages/cli/src/commands/names.ts` — `coga check-name` and `coga register`; permit signing at line 93.
- `packages/contracts/contracts/CoordinationRegistry.sol` — `registerNew` (line 50), `registerExisting` (line 68), `_register` (line 87).
- `packages/workers-server/src/chain/onchain-relay.ts:187` — server-side `register`, Registered-event parsing.
- `packages/workers-server/src/index.ts` — `requireAuth` (line 60), `X-Player-Id` forwarding (lines 405/451/477), `/api/relay/register` (line 176).
- `wiki/development/bot-system.md` — bot wallet sources, "no auth bypass" rule.
- `wiki/architecture/dual-mode-infra.md` — when the optional ERC-8004 ownership check is enabled.
- `wiki/architecture/credit-economics.md` — what the 400-credit registration grant funds.
