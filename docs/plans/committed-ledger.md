# Committed-Stake Ledger

> Extracted from `wiki/architecture/credit-economics.md` on 2026-04-29. The wiki
> describes current repo state; this is a not-yet-built improvement.

## Background

Today the join-time credit gate is a live-balance check: `LobbyDO.handleJoin`
asks `ChainRelay.getBalance(agentId)` and compares to `plugin.entryCost`. We
get away with this because the `player_sessions` table has a PRIMARY KEY on
`player_id` (single-lobby invariant) and `handlePlayerLobbyJoin` rejects the
join when the player already has an unfinished session pointing at a different
lobby (HTTP 409). One real stake, one game at a time, no double-spend.

That invariant is what lets us avoid bookkeeping. It will not survive the
first multi-game-concurrency feature.

## What we'd build

A committed/available split:

```
available = balance - committed - pendingBurns
committed = sum(entryCost over active games the player is in)
```

- `committed` accumulates when a player enters a lobby that has reached
  `entryCost`-locking (today: lobby creation; future: per-phase) and releases
  on settlement (`SettlementStateMachine` terminal `confirmed` state).
- `pendingBurns` already exists on-chain (see `CoordinationCredits.pendingBurns`
  and the burn-cooldown enforcement in `executeBurn`). The off-chain ledger
  just needs to read it; no contract change.
- The join-time gate becomes `available >= entryCost` instead of
  `balance >= entryCost`.

## Why we haven't built it

- No real users; the single-lobby guard is sufficient pre-launch.
- The on-chain `pendingBurns` cooldown already prevents the worst attack
  (mint → join → burn-out before settlement debits) regardless of off-chain
  bookkeeping. The cooldown gives us a settlement window strictly longer than
  any plausible game.
- Multi-game concurrency isn't on the launch path — the matchmaker shape
  assumes one game per player.

## Triggers to revisit

- A game type that legitimately wants concurrent participation (e.g.
  long-running async games), OR
- Tournaments / seasons where a player has multiple committed stakes
  simultaneously, OR
- Any feature that breaks the "one row per player" `player_sessions` shape.

When any of those land, the live-balance check is no longer a sufficient gate
and the committed ledger has to come with the feature in the same PR.
