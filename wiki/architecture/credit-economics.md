# Credit Economics

Games cost credits to play. Credits map to `CoordinationCredits` contract (on-chain mode) or server-side tracking (dev mode).

## Entry and Payouts

- Each game declares `entryCost` (credits per player).
- **No upfront deduction** — credits are rebalanced at game end, not held in escrow. Withdrawal cooldown (`pendingBurns`) prevents flash-loan / rug attacks.
- `computePayouts(outcome, playerIds, entryCost)` returns `Map<string, bigint>` of credit deltas. All settlement math is BigInt end-to-end per the Phase 3.3 number policy (`wiki/architecture/contracts.md`).
- Server-side invariants checked before anchoring: `sum(deltas) === 0n` and every delta `≥ -entryCost` (no player loses more than their stake). `GameAnchor.settleGame` re-enforces zero-sum on-chain.

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

See: `packages/workers-server/src/relay.ts`, `packages/contracts/`
