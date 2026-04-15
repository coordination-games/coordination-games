# On-Chain Reintegration Plan

**Status:** Draft  
**Goal:** Restore the on-chain layer lost in the Cloudflare Workers migration. Chain is source of truth; D1 is a write-through cache. "Mock mode" implements the same interface for local dev — not a separate codepath.

---

## The Problem

When we migrated from Express (`packages/server`) to Cloudflare Workers (`packages/workers-server`) in commit `90251ab`, the relay server that bridged all contract interactions was deleted. **12 relay endpoints were never ported.** The platform currently runs in a D1-only mode where:

- Registration writes to D1 only (no ERC-8004 minting, no USDC fee)
- Credits don't exist anywhere
- Game settlement writes to D1 only (no on-chain anchoring)
- The CLI's `status`, `balance`, `check-name`, `register`, `withdraw` commands all 404

### Contracts (Deployed on OP Sepolia, Unused)

| Contract | Address | Purpose |
|---|---|---|
| ERC-8004 | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | Agent identity NFTs (canonical) |
| CoordinationRegistry | `0x9026bb1827A630075f82701498b929E2374fa6a6` | Name registration, $5 USDC fee, initial 400 credits |
| CoordinationCredits | `0x3E139a2F49ac082CE8C4b0B7f0FBE5F2518EDC08` | Non-transferable credits, USDC-backed, burn/withdraw |
| GameAnchor | `0xf053f6654266F369cE396131E53058200FfF19D8` | Game result settlement, Merkle proof anchoring |
| MockUSDC | `0x6fD5C48597625912cbcB676084b8D813F47Eda00` | Test USDC |

### CLI Gap Analysis

**Completely broken (endpoint missing):**
- `GET /api/relay/status/:address` — `status`, `balance`, `withdraw`, `serve`
- `GET /api/relay/check-name/:name` — `check-name`, `register`
- `POST /api/relay/register` — `register`
- `GET /api/relay/balance/:agentId` — `balance`
- `POST /api/relay/burn-request` — `withdraw`
- `POST /api/relay/burn-execute` — `withdraw --execute`
- `GET /api/player/guide` — `guide` command + MCP `get_guide` tool
- `GET /api/player/leaderboard` — CLI calls wrong path (exists at `/api/leaderboard`)

**Body shape mismatch (route exists, wrong format):**
- `POST /api/player/tool` — CLI sends `{ pluginId, tool, args }`, server expects `{ relay: { ... } }`
- `POST /api/player/lobby/tool` — same

**Response shape mismatch:**
- `GET /api/lobbies` — CLI expects `agents[]` + `externalSlots[]`, server returns `teamSize` + `createdAt`
- `GET /api/games/:id/result` — CLI expects `configHash, movesRoot, turnCount`, server returns `actionsRoot, actionCount`

**Working:** `init`, `fund`, `export-key`, `import-key`, `create-lobby` (CtL), `join`, `state`, `move`, `wait`, auth

---

## Architecture Decision: viem over ethers

ethers.js v6 uses `new Function()` internally ([ethers-io/ethers.js#3763](https://github.com/ethers-io/ethers.js/issues/3763)), which fails in Workers' V8 sandbox. Simple calls (verifyMessage) work; contract writes will likely break.

**viem** was built for edge runtimes — no `eval()`/`new Function()`, tree-shakable (~27kB), built-in `optimismSepolia` chain, HTTP transport uses `fetch()`.

**Risk:** ethers `verifyMessage` and viem `verifyMessage` both use EIP-191 `\x19Ethereum Signed Message:\n` prefix. Must verify compatibility with CLI signing before swapping. Add a test.

## Architecture Decision: ChainRelay Interface

Instead of `if (env.RPC_URL)` branches throughout the codebase, define a single interface and swap implementations at the factory:

```typescript
interface ChainRelay {
  // Identity
  getAgentByAddress(address: string): Promise<AgentInfo | null>;
  checkName(name: string): Promise<{ available: boolean }>;
  register(params: RegisterParams): Promise<{ agentId: string; credits: string }>;

  // Credits
  getBalance(agentId: string): Promise<{ credits: string; usdc: string }>;
  topup(agentId: string, permitParams: PermitParams): Promise<{ credits: string }>;
  requestBurn(agentId: string, amount: string): Promise<BurnRequest>;
  executeBurn(agentId: string): Promise<{ credits: string }>;
  cancelBurn(agentId: string): Promise<void>;

  // Settlement
  settleGame(result: GameResult, deltas: CreditDelta[]): Promise<{ txHash: string }>;
}
```

**Two implementations:**
1. `OnChainRelay` — viem calls to real contracts via RPC. Production.
2. `MockRelay` — D1-backed fake. Local dev / tests.

**Selection:** `const relay = env.RPC_URL ? new OnChainRelay(env) : new MockRelay(env);`

### Interface Notes

- **`faucet` is NOT on the interface.** It's a testnet admin operation (minting MockUSDC), not a game relay concern. Standalone endpoint only.
- **`topup` and `cancelBurn` are included** even though implementation is Phase 4. The interface should be complete upfront.
- **This is a pragmatic shortcut.** The interface groups identity, credits, and settlement — three distinct trust boundaries. Fine at this scale; may split later.
- **Mock mode is dev/test only.** Players created via MockRelay have no on-chain identity. There is no migration path from mock to on-chain — if you ran games in mock mode, those results can't be settled retroactively. This is acceptable: mock is for iteration, not production data.

### The agentId Mapping Problem

The contracts use `uint256` NFT token IDs. The Workers server uses UUID strings from D1. This must be bridged.

**Solution:** Add `chain_agent_id INTEGER` column to D1 `players` table. This column:
- Is NULL for mock-mode players (no on-chain identity)
- Is populated after on-chain registration (Phase 3)
- Is used by `OnChainRelay` to translate between D1 player IDs and contract agentIds
- Must be indexed for reverse lookups (chain agentId → D1 player)

D1 migration: `ALTER TABLE players ADD COLUMN chain_agent_id INTEGER UNIQUE;`

---

## Implementation Phases

### Phase 0: Fix CLI-Server Mismatches

**Goal:** Fix everything that's broken for reasons unrelated to on-chain. No chain work. Gets the CLI and MCP tools functional for the current D1-only mode.

1. Fix `POST /api/player/tool` — change CLI to send the `{ relay: { ... } }` format the server expects (server defines the API; CLI conforms)
2. Fix `POST /api/player/lobby/tool` — same
3. Fix `GET /api/lobbies` response — query LobbyDO for agent membership, include in response
4. Fix `GET /api/games/:id/result` field names — add `configHash`, alias `actionsRoot`→`movesRoot`, `actionCount`→`turnCount`
5. Add `GET /api/player/leaderboard` — alias to existing `/api/leaderboard` handler
6. Add `GET /api/player/guide` — return game metadata from registry (game types, rules summary, available tools)

**Test:** All working CLI commands still work. MCP tools (chat, leaderboard, guide) work.

### Phase 1: ChainRelay Interface + Mock + viem

**Goal:** Define the interface, implement MockRelay against D1, swap ethers for viem. Get relay endpoints serving data from D1.

1. Create `packages/workers-server/src/chain/types.ts` — ChainRelay interface + data types
2. Create `packages/workers-server/src/chain/mock-relay.ts` — MockRelay backed by D1 `players` table (credits default to 0, register just writes D1, settle is a no-op)
3. Create `packages/workers-server/src/chain/onchain-relay.ts` — stub that throws "not implemented" for all methods (filled in Phase 2-4)
4. Create `packages/workers-server/src/chain/index.ts` — factory function
5. Replace ethers with viem in `auth.ts`:
   - `ethers.verifyMessage()` → `import { verifyMessage } from 'viem'`
   - `new ethers.JsonRpcProvider()` → `createPublicClient({ chain: optimismSepolia, transport: http() })`
   - `new ethers.Contract()` → `publicClient.readContract()`
   - Remove ethers from package.json, add viem
6. Add D1 migration: `chain_agent_id` column on `players`
7. Add relay endpoints to `index.ts`:
   - `GET /api/relay/status/:address` → `relay.getAgentByAddress()`
   - `GET /api/relay/check-name/:name` → `relay.checkName()`
   - `GET /api/relay/balance/:agentId` → `relay.getBalance()`
8. Write compatibility test: sign with ethers (as CLI does), verify with viem (as server will)

**Test:** `coga status` shows registration info from D1. `coga check-name` works. `coga balance` returns 0 credits (mock mode).

### Phase 2: On-Chain Reads

**Goal:** OnChainRelay reads real data from deployed contracts.

1. Implement `OnChainRelay.getAgentByAddress()`:
   - First check D1 `chain_agent_id` for cached mapping
   - If miss, scan ERC-8004 ownership (optimize: start from highest known ID, scan down)
   - Cache result in D1
2. Implement `OnChainRelay.checkName()` — calls `registry.checkName()`
3. Implement `OnChainRelay.getBalance()` — calls `credits.balances()` + `usdc.balanceOf()`
4. D1 write-through: after chain reads, update D1 with `last_synced_block`
5. Set up Wrangler secrets: `RPC_URL`, `RELAYER_PRIVATE_KEY`, all contract addresses
6. Deploy and verify reads against OP Sepolia

**D1 cache strategy:**
- Immutable data (registrations, settled games): cache forever. On mainnet, wait for L1 finality before caching.
- Mutable data (balances): cache with `last_synced_block`. Serve from cache. Refresh on-demand or via cron trigger.

### Phase 3: On-Chain Writes (Registration + Settlement)

**Goal:** Registration mints ERC-8004 NFTs. Game settlement anchors results on-chain.

**Dependency:** CLI must be updated to generate EIP-2612 permit signatures for USDC approval. This is a breaking change to the registration flow — the CLI sends `{ name, address, permitDeadline, v, r, s }` instead of just `{ name, address }`.

1. Implement `OnChainRelay.register()`:
   - Relayer submits `registry.registerNew()` with user's permit signature
   - The relayer pays gas; USDC comes from user's wallet via permit
   - Wait for receipt, write `chain_agent_id` to D1
2. Implement `OnChainRelay.settleGame()`:
   - Build Merkle root of actions (uses engine's `buildGameResult`)
   - Translate D1 player UUIDs → on-chain agentIds via `chain_agent_id`
   - Call `gameAnchor.settleGame()` via relayer
   - Update D1 credit balances from chain
3. Add `POST /api/relay/register` endpoint
4. Wire GameRoomDO game-end to settlement
5. **Settlement retry:** Add a cron trigger that scans for games marked finished in D1 but not settled on-chain. Retry failed settlements. The contract's `AlreadySettled` check prevents double-settlement.
6. Update CLI `register` command to generate permit signature

**Relayer security:**
- The relayer private key is stored as a Wrangler secret
- The relayer address MUST be separate from the deployer/admin address
- The relayer should hold minimal ETH and only the roles it needs (SETTLER_ROLE on GameAnchor)
- For mainnet: consider delegating signing to a KMS-backed service

**Test:** Full loop: register with USDC → play game → game settles on-chain → credits updated

### Phase 4: Credits + Withdrawal

**Goal:** Credit economics fully on-chain.

1. Implement `OnChainRelay.topup()` — accepts permit, calls `credits.mint()`
2. Implement `OnChainRelay.requestBurn()` and `OnChainRelay.executeBurn()`
3. Implement `OnChainRelay.cancelBurn()`
4. Add endpoints: `/api/relay/topup`, `/api/relay/burn-request`, `/api/relay/burn-execute`, `/api/relay/burn-cancel`
5. Add `GET /api/relay/faucet/:address` (testnet only — standalone, not on ChainRelay interface)
6. Update CLI `withdraw` command, add `topup` command — both need permit signature generation
7. Wire CLI end-to-end

### Phase 5: Verification + Bundle

**Goal:** Anyone can independently verify game results against on-chain Merkle root.

1. Add `GET /api/games/:id/bundle` — full action log, config, player list, signatures
2. Ensure `GET /api/games/:id/result` includes `configHash`
3. CLI `verify` command: fetch bundle, recompute Merkle root, compare against on-chain `actionsRoot`
4. Document verification protocol

**Coupling risk:** The Merkle root is computed by TypeScript code in the engine (`buildGameResult`). If the tree construction (leaf encoding, sort order, hash function) ever changes, existing on-chain roots become unverifiable. Pin the algorithm and document it as a protocol spec.

---

## Not in Scope

- **EAS TrustGraph** (attest/revoke/reputation) — trust plugin spec exists, CLI commands are stubs. Defer.
- **Mainnet migration** (OP Sepolia → OP Mainnet) — separate plan. Adds finality concerns, real money, KMS signing.
- **Credit gating for games** — adding entry fees is a game config concern, not a relay concern.

## Key Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Nonce collisions** | Concurrent settlements fail | Low throughput on testnet. If needed: DO-based nonce sequencer |
| **RPC flakiness** | Reads/writes fail intermittently | viem retry config (`retryCount: 3`). Settlement retry cron. |
| **ethers→viem signature compat** | Auth breaks | Write compatibility test before swapping |
| **Existing D1 players** | Players registered without on-chain identity | `chain_agent_id` is nullable. Mock-mode players work but can't settle. Require on-chain registration for ranked play. |
| **Relayer key compromise** | Attacker can settle games, mint credits | Separate relayer from admin. Minimal ETH balance. Role-limited permissions. |
| **Settlement failure** | Game finished in D1 but not on-chain | Cron trigger retries unsettled games. Contract prevents double-settlement. |
| **Merkle algorithm drift** | On-chain roots become unverifiable | Pin algorithm in engine. Document as protocol spec. |

## Files Changed

| File | Change | Phase |
|---|---|---|
| CLI: `commands/game.ts`, `game-client.ts` | Fix tool body shape | 0 |
| Server: `index.ts` | Fix response shapes, add aliases, add relay routes | 0, 1 |
| `packages/workers-server/src/chain/` | New: types, mock-relay, onchain-relay, index | 1 |
| `packages/workers-server/src/auth.ts` | ethers → viem | 1 |
| `packages/workers-server/package.json` | Remove ethers, add viem | 1 |
| `packages/workers-server/wrangler.toml` | Document required secrets | 2 |
| `packages/workers-server/migrations/` | Add `chain_agent_id` column | 1 |
| `packages/cli/src/commands/names.ts` | Add permit signature for registration | 3 |
| `packages/cli/src/commands/wallet.ts` | Add permit for topup/withdraw | 4 |
| `wiki/architecture/dual-mode-infra.md` | Update: interface-based, not branch-based | 1 |
