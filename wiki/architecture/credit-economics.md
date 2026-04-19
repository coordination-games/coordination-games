# Credit Economics

Games cost credits to play. Credits map to `CoordinationCredits` contract (on-chain mode) or server-side tracking (dev mode).

## Entry and Payouts

- Each game declares `entryCost` (credits per player)
- **No upfront deduction** — credits are rebalanced at game end, not held in escrow. Withdrawal cooldown (`pendingBurns`) prevents flash-loan / rug attacks.
- `computePayouts(outcome, playerIds, entryCost)` returns `Map<string, number>` of credit deltas
- Server-side invariants checked before anchoring: `sum(deltas) === 0` and every delta `≥ -entryCost` (no player loses more than their stake). `GameAnchor.settleGame` re-enforces zero-sum on-chain.

## Payout Models

**CtL:** Binary. Winners +entryCost, losers -entryCost, draws 0.

**OATHBREAKER:** Dollar-value model. Each player's $1 entry creates a dollar pool. Points circulate via cooperation (printing) and defection (tithes burn). At game end:
```
dollarPerPoint = totalDollarsInvested / totalSupply
playerPayout = (playerBalance * dollarPerPoint) - entryCost
```
Deflationary game = each point worth more. Inflationary = need to grow just to stay even.

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
