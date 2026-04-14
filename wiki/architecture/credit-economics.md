# Credit Economics

Games cost credits to play. Credits map to `CoordinationCredits` contract (on-chain mode) or server-side tracking (dev mode).

## Entry and Payouts

- Each game declares `entryCost` (credits per player)
- Fees deducted when game starts
- `computePayouts(outcome, playerIds)` returns `Map<string, number>` of credit deltas
- Payouts must be zero-sum relative to entry pool

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
