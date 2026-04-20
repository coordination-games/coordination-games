# Credit Economics

Games cost credits to play. Credits map to `CoordinationCredits` contract (on-chain mode) or server-side tracking (dev mode).

## Entry and Payouts

- Each game declares `entryCost` (credits per player, in **whole credits** — see "Decimal scaling" below).
- **No upfront deduction** — credits are rebalanced at game end, not held in escrow. Withdrawal cooldown (`pendingBurns`) prevents flash-loan / rug attacks.
- `computePayouts(outcome, playerIds, entryCost)` returns `Map<string, bigint>` of credit deltas. All settlement math is BigInt end-to-end per the Phase 3.3 number policy (`wiki/architecture/contracts.md`).
- Server-side invariants checked before anchoring: `sum(deltas) === 0n` and every delta `≥ -entryCost` (no player loses more than their stake). `GameAnchor.settleGame` re-enforces zero-sum on-chain.

## Decimal scaling

Credits have **6 decimals** on-chain, matching USDC. Exported constants:

```typescript
// packages/engine/src/money.ts
export const CREDIT_DECIMALS = 6;
export const CREDIT_SCALE = 10n ** 6n; // 1_000_000n
```

- Plugin `entryCost` is declared in **whole credits** (e.g. CtL = 10, OATH = 1).
- `GameRoomDO.kickOffSettlement` scales at the settlement boundary: `BigInt(plugin.entryCost) * CREDIT_SCALE`. The scaled value is what `computePayouts` consumes, what invariant checks (`sum === 0n`, `delta ≥ -entryCost`) run against, and what gets relayed to `settleGame` as int256 deltas.
- Plugin `computePayouts` functions do **not** need to be scale-aware — they do proportional math and conservation; scale passes through from input to output.
- Consumer-facing surfaces (`coga balance`, `coga status`, web register flow) divide by `CREDIT_SCALE` before display. User-typed burn amounts (`coga withdraw 100`) are multiplied by `CREDIT_SCALE` before hitting the contract.
- `MockRelay` (in-memory mode) does not track balances at all — `getBalance` returns `'0'`, mint/burn throw, settlement `submit` is a no-op. Scaling is a silent no-op in that mode, which is why the bug was invisible until on-chain settlement landed.

Worked example (CtL, `entryCost: 10`, Alice beats Bob):

| Layer | Value |
| --- | --- |
| `plugin.entryCost` | `10` (number, whole credits) |
| `GameRoomDO` after scaling | `10_000_000n` (bigint, raw units) |
| `computePayouts` output | Alice `+10_000_000n`, Bob `-10_000_000n` |
| `int256[]` to `settleGame` | `[10_000_000, -10_000_000]` |
| Contract `balances` delta | +10_000_000 / -10_000_000 raw = +10 / -10 whole credits |
| `coga balance` display | `Credits: 410` (for a 400-credit starting balance + 10) |

## Payout Models

**CtL:** Binary. Winners +entryCost, losers -entryCost, draws 0.

**OATHBREAKER:** Proportional BigInt pot-split. Each player's entry seeds a pot of `entryCost * playerCount` credits. Points circulate via cooperation (printing) and defection (tithes burn). At game end:

```
potTotal    = entryCost * playerCount                            (BigInt)
totalPoints = sum(floor(player.balance))                         (BigInt)
share(p)    = (potTotal * BigInt(floor(p.balance))) / totalPoints  // BigInt floor
delta(p)    = share(p) - entryCost
```

Deflationary round (tithe burns supply) → each remaining point gets a larger pot share. Inflationary round (C/C prints supply) → each point dilutes.

### Rounding rule (locked, Phase 3.1)

Because BigInt floor divisions can leave a remainder, summing per-player shares may fall short of `potTotal` by up to `(playerCount - 1)` credits. That remainder is **given to the highest-rank player** so settlement stays exactly zero-sum without reopening the floor bound.

Highest-rank = canonical settlement order:

1. Floored point balance, descending.
2. Earliest `joinedAt` (index in lobby `playerIds`, ascending) — breaks ties on balance.
3. `playerId` lexicographic ascending — final tiebreaker.

Edge case: if every player ends on zero balance (`totalSupply === 0`), the entire pot goes to `ranked[0]` per this same ordering. Preserves zero-sum.

Implementation: `distributePot` in `packages/games/oathbreaker/src/plugin.ts`; property tests in `payouts.test.ts`.

## Balance Tracking

```typescript
available = onChainBalance - committed - pendingBurns
```
- `committed` = locked in active games
- `pendingBurns` = awaiting burn execution (cooldown prevents flash-loan attacks)

## Credit Lifecycle

```
Register: $5 USDC → $4 backs 400 credits, $1 to treasury
Top up:   USDC → CoordinationCredits.mint() → credits
Play:     credits committed → game → payouts applied
Withdraw: burn request → cooldown → burn execute → USDC returned
```

See: `packages/workers-server/src/plugins/settlement/`, `packages/contracts/`
