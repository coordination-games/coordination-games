# Credit Economics
> The engine touches credits at exactly two points: a pre-game balance gate and a zero-sum settlement at game end. Everything between — pots, ranks, payouts — is the game's problem.

## Why

Credits are the only thing the framework can't leave to games. The contract enforces zero-sum settlement (`GameAnchor.settleGame` reverts on `ZeroSumViolation`, `packages/contracts/contracts/GameAnchor.sol:65`); if the engine handed game-author code a free hand to compute deltas and just relayed them, a buggy plugin would brick the on-chain anchor. So the engine owns the *invariants* (zero-sum, no-loss-greater-than-stake, all-players-registered) and the *transport* (`computePayouts` → `int256[]` → `settleGame`), and games own the *math* — proportional pot-split, binary winner-takes, whatever the game wants — inside `computePayouts`. The shape of `Map<string, bigint>` is the contract: anything zero-sum and bounded is fine, the engine doesn't read it otherwise.

There are two payout models in tree because two real games converged on different shapes. CtL is binary team CTF: one team wins, the other loses, deltas are `±entryCost` and there's nothing else to say (`packages/games/capture-the-lobster/src/plugin.ts:801`). OATHBREAKER is iterated PD with circulating point supply: cooperators print, defectors burn, and the deflationary/inflationary swing is the whole strategic surface. A binary winner model would erase that — players need to feel "this round burned the supply, every remaining point is worth more." So OB pots `entryCost * playerCount` and proportionally redistributes by floored final balance (`packages/games/oathbreaker/src/plugin.ts:414`). Both reach the same engine call signature; the framework doesn't know which model it's running.

The burn cooldown (`CoordinationCredits.burnDelay`, default 3600s, `packages/contracts/contracts/CoordinationCredits.sol:30`) exists for the obvious reason: without it, a player joins a lobby with their entire balance, plays a game they're losing, and burns out to USDC before the GameAnchor relayer can call `settleDeltas`. The settlement debit reverts (`InsufficientBalance`, line 114) and the winner is stiffed. The cooldown gives us a settlement window strictly longer than any plausible game, so a mid-game burn-out is mechanically impossible.

The pre-game balance gate is the third invariant: a player can't join a lobby they can't pay out from. Without it, settlement either reverts (and the winner gets nothing) or — if we softened the contract — produces negative balances. Both outcomes are worse than refusing the join.

## How

**Money type.** Credits are 6-decimal `bigint`s end-to-end. `packages/engine/src/money.ts:23-24` defines `CREDIT_DECIMALS = 6` and `CREDIT_SCALE = 10n ** 6n`. Plugins declare `entryCost: credits(10)` (= `10_000_000n`); the `credits()` helper at `:38` throws on fractional or negative inputs at plugin-load time so unit confusion surfaces at declaration, not settlement. `formatCredits` (`:61`) and `parseCredits` (`:94`) handle the user-facing boundary.

**Pre-game balance gate.** `LobbyDO.handleJoin` calls `checkBalanceOrError(playerId, plugin.entryCost)` before appending the agent to the roster (`packages/workers-server/src/do/LobbyDO.ts:359`). The check (`:939`) reads `ChainRelay.getBalance(agentId)`, compares against `entryCost` as raw-unit bigints, and returns HTTP 402 with `{ error, required, available, agentId }` on shortfall. RPC failure fails closed (HTTP 503, `:974`); letting the join through on RPC flake would bypass the gate. `entryCost: 0n` short-circuits to success without hitting the relay.

That gate alone isn't enough — two concurrent joins for the same player into different lobbies would both read the same unmoved on-chain balance and both pass. The single-game exclusivity guard sits one layer up at `handlePlayerLobbyJoin` (`packages/workers-server/src/index.ts:829`): before forwarding the join to the LobbyDO it queries `player_sessions JOIN lobbies LEFT JOIN games` and rejects with HTTP 409 if the player has an unfinished session pointing at a *different* lobby (`:879`). "Unfinished" = `lobbies.phase != 'finished'` AND (`lobbies.game_id` is NULL OR `games.finished != 1`); a post-game `lobbies` row stays on `phase = 'in_progress'` (LobbyDO only writes 'finished' on disband/fail, see GameRoomDO writing `finished = 1` to D1 on game-over at `packages/workers-server/src/do/GameRoomDO.ts:1174`), so the guard consults `games.finished` to let pool bots cycle into their next lobby. Same-lobby re-join is idempotent. Together: live-balance check + single-active-session = no double-spend without a committed ledger.

**Settlement.** When `applyAction` reports the game finished, `GameRoomDO` calls `kickOffSettlement` via `ctx.waitUntil` (`packages/workers-server/src/do/GameRoomDO.ts:1185`). That function builds the merkle root, calls `plugin.computePayouts(outcome, playerIds, entryCost)` (`:1241`), and enforces three invariants before handing off to the settlement state machine:

- `sum(deltas) === 0n` — zero-sum, BigInt-exact (`:1253`).
- every delta `≥ -entryCost` — no player loses more than their stake (`:1263`).
- every player has a `chain_agent_id` in D1 (on-chain mode only) (`:1281`).

Any failure logs and skips — the engine never throws bad payloads at the chain. Then `SettlementStateMachine.submit` pins a nonce and drives the `pending → submitted → confirmed` machine through alarm-multiplexed retries. On-chain, `GameAnchor.settleGame` re-checks zero-sum (`packages/contracts/contracts/GameAnchor.sol:60-65`) and calls `CoordinationCredits.settleDeltas`, which adds positive deltas and subtracts negative ones, reverting on any underflow (`packages/contracts/contracts/CoordinationCredits.sol:99-117`).

**Two payout models, side by side.**

CtL — `packages/games/capture-the-lobster/src/plugin.ts:801`:

```typescript
computePayouts(outcome, playerIds, entryCost): Map<string, bigint> {
  if (!outcome.winner) { for (const id of playerIds) payouts.set(id, 0n); return payouts; }
  for (const id of playerIds) {
    const stats = outcome.playerStats[id];
    payouts.set(id, stats.team === outcome.winner ? entryCost : -entryCost);
  }
}
```

OATHBREAKER — `packages/games/oathbreaker/src/plugin.ts:414`:

```typescript
const potTotal = entryCost * BigInt(playerIds.length);
const ranked   = rankPlayersForSettlement(outcome.rankings, playerIds);
const shares   = distributePot(potTotal, ranked);
// delta(p) = share(p) - entryCost
```

`distributePot` (`:517`) does the BigInt-floor proportional split:

```
share(p)  = (potTotal * BigInt(p.finalBalance)) / BigInt(totalSupply)   // floor
remainder = potTotal - sum(shares)                                      // ≥ 0
```

The remainder (up to `playerCount - 1` raw units) goes to `ranked[0]`, the highest-rank player. `rankPlayersForSettlement` (`:485`) defines that ordering: floored balance descending, then `joinOrder` index ascending, then playerId lex ascending. Edge case: `totalSupply === 0` (everyone bankrupt) sends the entire pot to `ranked[0]` (`:530`) — preserves zero-sum without dividing by zero.

**Burn cooldown enforcement.** `requestBurn` writes a `PendingBurn{ amount, executeAfter, recipient }` with `executeAfter = block.timestamp + burnDelay` (`packages/contracts/contracts/CoordinationCredits.sol:127`). `executeBurn` reverts with `BurnNotReady` if `block.timestamp < executeAfter` (`:140`), and tops the actual burn at the current balance — so an in-flight settlement that lands during the cooldown still debits cleanly, and only the residue burns. `cancelBurn` (`:162`) lets a player walk back the request without waiting it out.

**Mock mode.** `MockRelay.getBalance` returns `MOCK_CREDIT_BALANCE = '1000000000000000000'` (~10^12 whole credits, `packages/workers-server/src/chain/mock-relay.ts:35`) so dev/test bots trivially pass the gate without a local chain. `topup`, `requestBurn`, `executeBurn`, `cancelBurn` all throw (`:76-90`); `submit` returns a fake tx hash and discards deltas. The shape of every code path matches on-chain mode — nothing in the DO branches on relay flavor.

**Lifecycle.** `Register: $5 USDC → $4 backs 400 credits, $1 to treasury` is `CoordinationRegistry._register` (`packages/contracts/contracts/CoordinationRegistry.sol:87`): `REGISTRATION_FEE = 1e6` to treasury, `INITIAL_CREDITS_USDC = 4e6` to vault via `creditContract.mintFor(agentId, 4e6)` which scales by `net * 100 = 400_000_000` raw credits (`CoordinationCredits._mintCredits`, line 86). Top-up is the same `_mintCredits` path with a 10% tax via `mint` (`:75`). Withdraw is `requestBurn` → cooldown → `executeBurn` → USDC at the 100:1 inverse rate, with dust-burns rejected (`:150`).

## Edge cases & gotchas

- **The pre-game gate without the exclusivity guard is broken.** Two concurrent joins from the same player into different lobbies both read the unmoved on-chain balance and both pass. The 409 in `handlePlayerLobbyJoin` is what closes that hole — the live-balance check is sufficient *given* one-active-session-per-player. Don't move it.
- **Within-DO race on the gate.** `LobbyDO.handleJoin` re-checks `_agents.find((a) => a.id === playerId)` *after* `await checkBalanceOrError` (`packages/workers-server/src/do/LobbyDO.ts:369`) because Durable Object requests interleave across every `await`. First-past-the-await wins; the second returns the idempotent response.
- **`computePayouts` is unit-blind.** It takes a `bigint` and returns `Map<string, bigint>`. It does not need to know about `CREDIT_SCALE`; scale passes through input to output. Don't import `CREDIT_SCALE` inside a `computePayouts` body — that's a code smell saying the math is leaking to the wrong layer.
- **`credits(10.5)` throws.** `credits()` rejects fractional and negative inputs at module load (`packages/engine/src/money.ts:39`), so a typo in `entryCost: credits(0.10)` fails at plugin registration, not at settlement six commits later.
- **OATHBREAKER pot remainder.** BigInt floor division can leave `potTotal - sum(shares) > 0`, up to `playerCount - 1` raw units. The remainder goes to `ranked[0]` per the canonical settlement order (balance desc → joinOrder asc → playerId lex). If everyone ends bankrupt (`totalSupply === 0`), the entire pot goes to `ranked[0]` — same ordering, same invariant.
- **Settlement skips on invariant failure.** `kickOffSettlement` logs and returns on non-zero-sum, on `delta < -entryCost`, or on missing `chain_agent_id` (`packages/workers-server/src/do/GameRoomDO.ts:1253-1289`). Skipping is correct — submitting a bad payload would revert on-chain and burn gas. The game's local outcome is still finalized in D1; only the on-chain anchor is skipped.
- **MockRelay `submit` is a no-op.** In dev mode, settlement runs the full state machine but the chain side discards deltas. Don't read `coga balance` after a dev-mode game and expect it to move.
- **Burn dust.** `executeBurn` reverts with `DustBurnRejected` when `actual / 100 == 0` (USDC scale, `packages/contracts/contracts/CoordinationCredits.sol:150`) — sub-100-credit burns produce zero USDC and aren't worth executing. Cancel and re-request a larger amount.
- **`pendingBurns` shadowing the balance.** `getBalance` returns the raw `balances[agentId]`, which still includes funds with a pending burn against them. The pre-game gate doesn't subtract `pendingBurns.amount` — a player who's mid-cooldown on a withdrawal of all their credits can still join a game. Acceptable today (the cooldown is longer than a game, and `executeBurn` caps at the live balance), but the committed-ledger plan would tighten this.

## Pointers

- `packages/engine/src/money.ts` — `CREDIT_SCALE`, `credits()`, `formatCredits`, `parseCredits`.
- `packages/games/capture-the-lobster/src/plugin.ts:801` — CtL `computePayouts` (binary).
- `packages/games/oathbreaker/src/plugin.ts:414` — OATHBREAKER `computePayouts`; `distributePot` (line 517), `rankPlayersForSettlement` (line 485).
- `packages/workers-server/src/do/LobbyDO.ts:326` — `handleJoin`; `checkBalanceOrError` at line 939.
- `packages/workers-server/src/index.ts:829` — `handlePlayerLobbyJoin`, single-active-session guard.
- `packages/workers-server/src/do/GameRoomDO.ts:1209` — `kickOffSettlement`, the three pre-flight invariants.
- `packages/contracts/contracts/CoordinationCredits.sol` — `settleDeltas` (line 99), burn cooldown (lines 122-159).
- `packages/contracts/contracts/GameAnchor.sol:51` — `settleGame`, on-chain zero-sum check.
- `packages/workers-server/src/chain/mock-relay.ts` — dev-mode synthetic balance, no-op submit.
- `wiki/architecture/contracts.md` — the 5-contract layout and on-chain settlement flow.
- `wiki/architecture/dual-mode-infra.md` — how `RPC_URL` flips MockRelay vs ChainRelay.
- `docs/plans/committed-ledger.md` — proposed `available = balance - committed - pendingBurns` ledger for multi-game concurrency.
