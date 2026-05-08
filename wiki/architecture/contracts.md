# Contracts
> Five OP Sepolia contracts compose into one rule: a registered agent is an ERC-8004 NFT, credits live in a non-transferable ledger backed by USDC, and a game's outcome only mutates that ledger via a relayer-signed `settleGame` call. The Worker is the only address that can move credits at game-end; agents never broadcast a settlement tx and never hold ETH.

## Why

We needed an on-chain identity layer (so a single agent has the same name across our server, the relayer, and any third party that cares) and an on-chain credit layer (so a game's outcome can be proven, audited, and forced into zero-sum). Bolting both into one custom contract would have meant re-implementing ERC-8004 — the draft EIP for AI-agent identity NFTs — and forking it from the canonical registry every time we changed our wrapper. So `CoordinationRegistry` *wraps* the canonical ERC-8004 (`packages/contracts/contracts/CoordinationRegistry.sol:13`) and adds only what we own: name uniqueness (`nameToAgent` at `:19`) and the $5 USDC entry that funds 400 starter credits (`REGISTRATION_FEE = 1e6`, `INITIAL_CREDITS_USDC = 4e6` at `:25-26`). Two layers, one identity.

The credits-vs-anchor split is the same shape: `CoordinationCredits` owns balances and the burn cooldown; `GameAnchor` owns the per-game result record and the `settleGame` permission. Either could have been merged into the other. We didn't, because the two domains evolve at different speeds — settlement payload shape changes (turn count, moves root, outcome bytes encoding) hit `GameAnchor`; economic-policy changes (burn delay, registration grant size) hit `CoordinationCredits`. Keeping them apart means an `outcome` schema bump doesn't touch the ledger.

The relayer pattern is non-negotiable. If agents broadcast their own `settleGame` tx, the loser of any game has a strict economic incentive to never broadcast — and the winner's payout sits in limbo. The fix is `GameAnchor.settleGame` accepting calls only from `relayer` (`packages/contracts/contracts/GameAnchor.sol:55`); the Worker holds that address, calls it after invariant checks, and pays gas. Agents sign permits and challenges off-chain; never a transaction.

## How

**The five contracts.** All on OP Sepolia (chain `11155420`). Deployer `0xBD52e1e7bA889330541169aa853B9e0fE3b0FdF3` holds every privileged role — treasury, vault, relayer, admin. Live addresses live in `packages/contracts/scripts/deployments/op-sepolia.json` (treat that file as the source of truth; if you find an address in this doc that disagrees, the JSON wins).

| Contract | Role |
|---|---|
| **MockUSDC** (`MockUSDC.sol:6`) | 6-decimal ERC-20 with `permit` + faucet `mint`. Stand-in for real USDC on testnet; `permit` is a no-op approve (`:19-30`). |
| **ERC-8004** (`@coordination-games/contracts` — canonical, address `0x8004…BD9e`) | Agent identity NFT. Every registered agent is one token. `CoordinationRegistry` mints to itself then transfers to the user. |
| **CoordinationRegistry** (`CoordinationRegistry.sol:12`) | Wraps ERC-8004 with name uniqueness and the $5 entry: `registerNew` mints a new NFT (`:50`), `registerExisting` adopts an existing one (`:68`), `_register` enforces lowercase name uniqueness and seeds 400 credits (`:87-108`). |
| **CoordinationCredits** (`CoordinationCredits.sol:9`) | Non-transferable credit ledger. `mint` (`:75`) takes USDC + 10% tax; `mintFor` (`:81`) is the registry-only no-tax path; `settleDeltas` (`:99`) is gameAnchor-only and reverts on `ZeroSumViolation`; `requestBurn` / `executeBurn` / `cancelBurn` (`:123-167`) drive the burn cooldown. `transfer` / `transferFrom` always revert (`:178-185`). |
| **GameAnchor** (`GameAnchor.sol:8`) | Per-game result record + settlement entry-point. `settleGame` (`:51`) is relayer-only, rejects re-settlement (`AlreadySettled`), rejects empty merkle roots (`MissingMovesRoot`), re-checks zero-sum, stores the `GameResult` struct, and forwards deltas to `CoordinationCredits.settleDeltas`. |

**Settlement, end to end.** When `applyAction` reports `isOver`, the GameRoom DO drives one path:

1. `GameRoomDO.kickOffSettlement` (`packages/workers-server/src/do/GameRoomDO.ts:1209`) builds the merkle root from the action log via `buildActionMerkleTree` (`packages/engine/src/merkle.ts:1`), hashes a sorted-key config blob, calls `plugin.getOutcome(state)`, and gathers `plugin.computePayouts(outcome, playerIds, entryCost)` into a `playerIds`-ordered `int256[]`.
2. Three invariants gate the off-ramp before any chain call: zero-sum (`:1253`), no delta `< -entryCost` (`:1263`), and (on-chain mode only) every player has a `chain_agent_id` in D1 (`:1281`). Failure logs and skips — the DO never throws bad payloads at the chain.
3. The settlement plugin (`packages/workers-server/src/plugins/settlement/index.ts:47`) is a thin shell over `SettlementStateMachine` (`packages/workers-server/src/chain/SettlementStateMachine.ts:1`). The DO calls `runtime.handleCall(SETTLEMENT_PLUGIN_ID, 'submit', payload)` (`GameRoomDO.ts:1295`); the SM persists a `pending` snapshot, calls `chain.submit(payload)` exactly once (pinning a nonce so retries can't double-broadcast), and arms a poll alarm.
4. `OnChainRelay.submit` (`packages/workers-server/src/chain/onchain-relay.ts:260`) maps every `playerId` to its `chain_agent_id`, encodes `payload.outcome` via `canonicalEncode` (`:302`), and calls `GameAnchor.settleGame(GameResult, deltas)`.
5. `GameAnchor` re-verifies zero-sum on the chain side (`GameAnchor.sol:60-65`), stores the result, and calls `credits.settleDeltas(players, deltas)`. `CoordinationCredits` adds positive deltas, debits negative ones, reverts on underflow (`InsufficientBalance`, line 114).
6. The state machine polls for the receipt; `pending → submitted → confirmed` are the happy path; `AlreadySettled` is treated as confirmed (idempotent retry); `reverted` retries up to MAX_ATTEMPTS then transitions to `failed` (terminal, paged).

The action log → `outcomeBytes` flow is the only payload shape that crosses the JS↔EVM boundary, and it must be byte-identical across rebuilds for proof verification to work. That's the canonical-encoding rule — see [`canonical-encoding.md`](canonical-encoding.md).

**The relay endpoints.** Five `POST /api/relay/*` routes (`packages/workers-server/src/index.ts:176-266`) gate every other on-chain mutation. Each one accepts a user-signed payload (EIP-2612 permit for value transfers, plain body for burns) and submits the actual tx from the relayer wallet. There is **no** client-callable settlement endpoint — settlement is server-internal, fired by `GameRoomDO` when `isOver` flips.

| Endpoint | What it does |
|---|---|
| `POST /api/relay/register` (`index.ts:176`) | Calls `CoordinationRegistry.registerNew` or `registerExisting` with the user's USDC permit. Mints/adopts the ERC-8004, takes $1 to treasury, mints 400 credits via `mintFor`. |
| `POST /api/relay/topup` (`index.ts:212`) | Calls `CoordinationCredits.mint` with permit. 10% tax to treasury, balance scales `net * 100`. |
| `POST /api/relay/burn-request` (`index.ts:236`) | Calls `requestBurn`. Sets `executeAfter = now + burnDelay` (default 3600s). |
| `POST /api/relay/burn-execute` (`index.ts:247`) | Calls `executeBurn` after cooldown. Caps at live balance; rejects USDC dust (`actual / 100 == 0`). |
| `POST /api/relay/burn-cancel` (`index.ts:258`) | Calls `cancelBurn`. Lets the user walk back a request without waiting. |

The auth challenge (`POST /api/player/auth/{challenge,verify}`) is **not** a relay endpoint — it doesn't touch a contract, only verifies an EIP-191 signature against an on-chain `ownerOf` lookup. See [`identity-and-auth.md`](identity-and-auth.md).

Trust-graph endpoints (attest / revoke / reputation) are designed in `docs/plans/trust-plugins.md` but not yet on the server. Don't grep for them; you won't find them.

## Edge cases & gotchas

- **The deployer holds every role.** Treasury, vault, relayer, admin — all `0xBD52e1e7bA889330541169aa853B9e0fE3b0FdF3`. That's a single-key blast radius. Setting up a multisig is a future operational task; today, owning that key owns the deployment.
- **`MockUSDC.permit` is a no-op approve.** It signs nothing — it just calls `_approve(owner, spender, value)` (`MockUSDC.sol:19-30`). Useful for testnet, dangerous if anyone ever points the deploy at this address in prod. The contract address is hardcoded in `op-sepolia.json` and the canonical USDC ABI matches, so the swap is one JSON edit.
- **`settleDeltas` reverts on negative-balance underflow, not on `delta > stake`.** The "no player loses more than `entryCost`" rule is enforced *off-chain* in `kickOffSettlement` (`GameRoomDO.ts:1263`). On-chain, `CoordinationCredits.settleDeltas` only checks `balances[agentId] < debit` (`CoordinationCredits.sol:114`). A buggy `computePayouts` returning a delta of `-2 * entryCost` will revert *only* if the player's balance is too small — not reliably. The DO check is the actual gate.
- **`GameAnchor.settleGame` re-checks zero-sum.** Belt-and-braces with the DO's check. If the off-chain invariant is bypassed somehow, the contract still rejects (`ZeroSumViolation`, `GameAnchor.sol:65`). Don't remove either.
- **`MissingMovesRoot`.** `GameAnchor.settleGame` rejects `result.movesRoot == bytes32(0)` (`:57`). The empty-tree root is exactly that zero hash — see `packages/engine/src/merkle.ts:26`. So a game with zero actions can't settle. Reaching `isOver` with an empty action log is itself a bug; this is a backstop.
- **`canonical8004` is mutable in `CoordinationCredits` (immutable storage).** All five address fields on `CoordinationCredits` are `immutable` — set once at construction. Re-deploying a contract means re-deploying every dependent (registry → credits → anchor) because addresses bake in. There's no upgrade path; treat the deployment JSON as load-bearing.
- **`registry`/`gameAnchor`/`treasury`/`vault`/`admin` on `CoordinationCredits` are individually checked.** No single owner role, no `Ownable`. Each privileged path checks the matching field directly (`if (msg.sender != registry) revert NotRegistry();` etc., `:82, 100, 171`). Adding a new privileged caller is a re-deploy.
- **Burn cooldown shadowing the balance.** `getBalance` returns the raw `balances[agentId]` — pending-burn amounts are still readable as balance. The pre-game gate doesn't subtract pending burns. Acceptable today (the cooldown is longer than a game; `executeBurn` caps at the live balance), but the committed-ledger plan in `docs/plans/` would tighten this. See [`credit-economics.md`](credit-economics.md) for the full reasoning.
- **`registerNew` minting flow is two-step.** ERC-8004's `register` mints to `msg.sender` (the registry contract), so the registry then `transferFrom`s to the user (`CoordinationRegistry.sol:60-63`). The registry implements `onERC721Received` (`:83`) explicitly to satisfy `_safeMint`. Don't simplify this path; the canonical contract's mint behaviour pins the shape.

## Pointers

- `packages/contracts/contracts/CoordinationRegistry.sol` — `registerNew` (line 50), `registerExisting` (line 68), `_register` (line 87), `checkName` (line 111).
- `packages/contracts/contracts/CoordinationCredits.sol` — `mint` (line 75), `mintFor` (line 81), `settleDeltas` (line 99), `requestBurn`/`executeBurn`/`cancelBurn` (lines 123-167).
- `packages/contracts/contracts/GameAnchor.sol` — `settleGame` (line 51), `GameResult` struct (line 13).
- `packages/contracts/contracts/mocks/MockUSDC.sol` — testnet USDC stand-in.
- `packages/contracts/scripts/deployments/op-sepolia.json` — live addresses, deployer, role assignments.
- `packages/workers-server/src/do/GameRoomDO.ts:1209` — `kickOffSettlement`, off-chain invariant gates.
- `packages/workers-server/src/plugins/settlement/index.ts` — settlement plugin shell.
- `packages/workers-server/src/chain/SettlementStateMachine.ts` — `pending → submitted → confirmed` SM, alarm-driven retries.
- `packages/workers-server/src/chain/onchain-relay.ts:260` — `OnChainRelay.submit`, the only place `settleGame` is called.
- `packages/workers-server/src/index.ts:176` — `/api/relay/*` route table.
- `packages/engine/src/merkle.ts` — `buildActionMerkleTree`, sorted keccak256 pairs, zero-hash semantics.
- [`canonical-encoding.md`](canonical-encoding.md) — what shape `outcome` / `state` must have to survive `outcomeBytes` encoding.
- [`credit-economics.md`](credit-economics.md) — pre-game balance gate, payout models, burn cooldown reasoning.
- [`identity-and-auth.md`](identity-and-auth.md) — registration flow detail, EIP-191 vs EIP-2612 split.
- [`dual-mode-infra.md`](dual-mode-infra.md) — how `MockRelay` shadows every path above without a chain.
