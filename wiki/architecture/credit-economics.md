# Credit Economics

Games cost credits to play. Credits map to `CoordinationCredits` contract (on-chain mode) or server-side tracking (dev mode).

## Entry and Payouts

- Each game declares `entryCost` as a `bigint` in **raw credit units** (6-decimal, matching on-chain storage). Use the `credits(n)` helper so the call site reads as whole credits: `entryCost: credits(10)` = `10_000_000n`.
- **No upfront deduction** — credits are rebalanced at game end, not held in escrow. Withdrawal cooldown (`pendingBurns`) prevents flash-loan / rug attacks.
- `computePayouts(outcome, playerIds, entryCost)` returns `Map<string, bigint>` of credit deltas. All settlement math is BigInt end-to-end per the Phase 3.3 number policy (`wiki/architecture/contracts.md`).
- Server-side invariants checked before anchoring: `sum(deltas) === 0n` and every delta `≥ -entryCost` (no player loses more than their stake). `GameAnchor.settleGame` re-enforces zero-sum on-chain.

## Decimal scaling

Credits have **6 decimals** on-chain, matching USDC. Exported helpers (all from `packages/engine/src/money.ts`):

```typescript
export const CREDIT_DECIMALS = 6;
export const CREDIT_SCALE = 10n ** 6n; // 1_000_000n

export function credits(whole: number): bigint;  // declaration helper
export function formatCredits(raw: unknown): string;  // display
export function parseCredits(input: string): bigint;  // user input
```

- Plugin `entryCost` is already raw — no boundary scaling happens in the DO. `GameRoomDO.kickOffSettlement` and `LobbyDO.checkBalanceOrError` consume the bigint directly.
- `credits(10.5)` / `credits(-1)` throw at plugin-load time, so unit confusion surfaces at declaration rather than at settlement.
- Plugin `computePayouts` functions do **not** need to be scale-aware — they do proportional math and conservation; scale passes through from input to output.
- Consumer-facing surfaces (`coga balance`, `coga status`, web register flow) format raw units via `formatCredits`. User-typed amounts (`coga withdraw 100`, `coga withdraw 12.5`) go through `parseCredits` to become raw units.
- `MockRelay` (in-memory mode) does not track balances — `getBalance` returns a high synthetic value (`MOCK_CREDIT_BALANCE`, 10^18 raw units ≈ 10^12 whole credits) so the join-time balance check passes for everyone in dev/test; mint/burn throw; settlement `submit` is a no-op.

Worked example (CtL, `entryCost: credits(10)`, Alice beats Bob):

| Layer | Value |
| --- | --- |
| `plugin.entryCost` | `10_000_000n` (bigint, raw units) |
| `computePayouts` output | Alice `+10_000_000n`, Bob `-10_000_000n` |
| `int256[]` to `settleGame` | `[10_000_000, -10_000_000]` |
| Contract `balances` delta | +10_000_000 / -10_000_000 raw = +10 / -10 whole credits |
| `coga balance` / web display | `Credits: 410` (via `formatCredits`, for a 400-credit starting balance + 10) |

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

**Pre-game check:** `LobbyDO.handleJoin` verifies `balance >= entryCost` (both raw-unit `bigint`s) against the on-chain `CoordinationCredits.balances(agentId)` (via `ChainRelay.getBalance`) before appending the player to the lobby roster. Insufficient balance → HTTP 402 Payment Required with `{ error, required, available, agentId }`. Pre-launch assumption: a player can only be in one lobby at a time (enforced by `player_sessions` single-row-per-player), so we don't yet need a committed-stake ledger — the live balance is a sufficient gate.

**Single-game exclusivity guard:** the join path (`handlePlayerLobbyJoin` in `packages/workers-server/src/index.ts`) also rejects a join when the player's `player_sessions` row points at a DIFFERENT unfinished session. Without this, the `INSERT OR REPLACE` on `player_sessions` would silently move the player from an in-flight game A into lobby B — both sessions would read the same unmoved on-chain balance and the pre-game check would pass for both, letting one real stake back two concurrent games. Rejection: HTTP 409 Conflict with `{ error: "Already in an active game or lobby", playerId, existing: { lobbyId, gameId?, status } }`. "Unfinished" = `lobbies.phase != 'finished'` AND (`lobbies.game_id` is NULL OR `games.finished != 1`); a post-game `lobbies` row stays on `phase = 'in_progress'` (LobbyDO only writes 'finished' on disband/fail), so the guard consults `games.finished` to let pool bots cycle into their next lobby. Same-lobby re-join is idempotent and allowed.

**Future work:** a full committed/available ledger (`available = balance - committed - pendingBurns`, where `committed` accumulates across concurrent active games and releases on settlement) is a planned improvement for multi-game concurrency. Tracked separately; not needed for launch. `pendingBurns` already lives on-chain in `CoordinationCredits` — the withdrawal cooldown prevents flash-loan / rug attacks regardless of off-chain bookkeeping.

## Credit Lifecycle

```
Register: $5 USDC → $4 backs 400 credits, $1 to treasury
Top up:   USDC → CoordinationCredits.mint() → credits
Play:     credits committed → game → payouts applied
Withdraw: burn request → cooldown → burn execute → USDC returned
```

See: `packages/workers-server/src/plugins/settlement/`, `packages/contracts/`
