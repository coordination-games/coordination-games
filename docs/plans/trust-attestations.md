# Trust Attestations: Platform Primitives + `@ctl/attestations` Plugin

*Status: brainstorm. Not implementation-ready.*

## Design Philosophy

- **Platform should not decide what is trustworthy.** The platform provides signed statements and game event logs as raw data. All interpretation (scores, gating) lives in plugins.
- **No tokens, no stakes, no money.** Wealth cannot be laundered into moderation power.
- **Reputation IS the stake.** Attesters bind their judgment credibility to every statement they make. Wrong calls cost credibility; right early calls earn it. Precedented by Metaculus and Manifold pre-cash.
- **The steward's edge: be early — in both directions.** Early to invite good contributors into the community (positive attestations before consensus forms) AND early to push bad actors away (negative attestations before consensus forms). Both earn calibration credit. Being late to agree earns almost nothing. This is the core loop stewards optimize for.
- **Recovery is always possible.** Algorithmic scores never permanently ban a player. Bad conduct attestations decay out over time and are counterbalanced by clean-game auto-drip and fresh positive vouches. Reformed players climb out by continuing to play public games — **including free games**, which are the natural rehabilitation tier. Persistent bad actors stay in the hole. (Permanent platform-access bans exist separately, for real-world-harmful behavior.)
- **No authority, no disputes, no appeals.** The market IS the dispute mechanism. Consensus over time defines truth. The only admin escape hatch is platform-access bans for real-world-harmful behavior (separate system).
- **Activity-driven decay, not clock-driven.** Old attestations fade via activity: they're outweighed by newer attestations about the same subject. Dormant subjects' scores stay put.
- **Lobbies are primitives; access logic is in the default plugin.** Host configures parameters; server enforces; platform never decides who is "real" or "worthy."
- **Event-sourced storage.** Raw attestations + close events are the source of truth. All derived state (scores, stewardship) is a materialized cache of that history. Anyone can recompute independently.
- **Canonical computation is server-side.** Clients and agents fetch results via API; they never need to run the algorithm themselves.

## Scope Split: Platform Core vs Plugin

### Core Platform Primitives

1. **Identity** — `players` table (UUID + wallet + handle), migration 0001. Wallet is canonical. *Exists.*
2. **Attestations** — signed statements by one wallet about another. Stored immutably. Platform does not interpret. *New: `attestations` table + endpoints.*
3. **Game event logs** — already public: `/api/games`, `/api/games/:id/replay`, `/api/games/:id/bundle`, `/api/games/:id/spectator`, `WS /ws/game/:id`.
4. **Structured outcomes** — `match_players.team` (W/L/D) populated by `D1EloTracker.recordGameResult()`. Authoritative structured outcome source.
5. **Public lobbies** — discoverable, `min_conduct` enforced by the default plugin at join.
6. **Private lobbies** — URL-as-secret; no platform-level score check.
7. **Daily Merkle rollup** — new `AttestationAnchor` contract on OP Sepolia. Nightly cron posts that day's Merkle root. ~$0.01/day.

### Plugin Layer

The platform ships with one default plugin: `@ctl/attestations`. Server code calls its functions directly; no event bus, no registry. Alternative plugins can be contributed as PRs when a real need emerges.

## Attestation Schema

```typescript
{
  attester: WalletAddress,
  subject: WalletAddress,
  polarity: +1 | -1,             // positive or negative
  size: float in [0, 1],          // strength of conviction, default 1.0
  scope: string,                  // see Scope Tags
  reason?: string,                // inline text, ≤ 1000 chars (URLs can be embedded)
  timestamp: int,
  signature: Signature,           // EIP-712 per EAS off-chain spec
}
```

Notes:

- **Polarity is binary.** Neutral is not a valid attestation — just don't attest.
- **Size allows nuance.** `"Bob is solidly good" = {+1, 1.0}`; `"Bob seems fine, mostly" = {+1, 0.4}`.
- **Size doesn't multiply slot cost.** Each attestation consumes one slot regardless of size (see Slot Capacity below).
- **`reason` is the only text field.** Embedded URLs work; no separate URI field.
- **Attestations don't know about games.** Pure signed data. Cross-referencing with game logs is a consumer concern.

### Scope Tags

1. **Reserved:** `conduct` — canonical integrity dimension. Covers rule-following, no cheating, interpersonal decency, no scamming/harassment, no abandonment. Gated on by default public lobbies. Has full market mechanics (P&L, stewardship).
2. **Convention-based:** `skill:<game-id>` — per-game skill opinions (e.g. `skill:ctl`, `skill:oathbreaker`). Contributes to a score; no P&L for attester (skill has no ground truth to calibrate against).
3. **Free-form:** anything else. Stored, queryable, not aggregated by the default plugin. Custom consumers can interpret.

## Lobby Model

```typescript
{
  entry_fee: number,      // 0 = free
  min_conduct: number,    // 0 = no check; float in [0, 1]
  is_private: boolean
}
```

Three fields. No tiers, no UX presets, no skill gates, no stewardship gates, no whitelists.

- **Public** (`is_private: false`): discoverable. `min_conduct` enforced at join. Paid lobbies (entry_fee > 0) conventionally set `min_conduct > 0`; platform doesn't enforce a floor.
- **Private** (`is_private: true`): URL-as-secret, ephemeral-per-session expected. Communities needing identity-tight gating run their own frontend + auth and rotate URLs per session.

### Reputation Feedback from Lobbies

- **Attestations always count** regardless of lobby type.
- **Derived-from-gameplay signals (see CONDUCT auto-drip below) only count from public lobbies.** Private lobbies are sybil-vulnerable for auto-derived signals.

## Default Plugin: `@ctl/attestations`

Runs server-side. Canonical computation. Clients read via API; they don't execute the algorithm.

### Scores Produced

Per-subject per-scope:
- **CONDUCT** — platform integrity score. Full market mechanics. New players default to **0.5** (mild positive trust). Anyone can accumulate up or down from there based on attestations and clean-play auto-drip.
- **SKILL:\<game\>** — skill score. No P&L for attesters; just aggregated opinions. New players default to 0 (neutral).

Per-attester:
- **STEWARDSHIP** — quality of a player's CONDUCT judgments. Single scalar, defaults to 0 for new players. Not computed for skill (no ground truth).

### Universal Attestation Weighting

Every attestation (any scope) is weighted by the attester's CONDUCT and STEWARDSHIP:

```
attester_multiplier(K) = clamp(CONDUCT(K) + 1, 0, 2) × (1 + α × STEWARDSHIP(K))
  with α = 0.5, bounded multiplier range ≈ [0, 3]
```

Poor CONDUCT dampens voice on everything. High STEWARDSHIP amplifies voice on everything. No circular skill-stewardship feedback.

### Market Mechanics

The system is a **scalar prediction market**: each subject has a market per scope, price = current Score. Attesters open positions expressing a view; they realize P&L over time as the price moves.

**Opening a position** is just submitting an attestation. It starts contributing to the subject's score immediately and to the attester's stewardship (as unrealized P&L) immediately.

**Closing a position** is optional. Closes lock realized P&L at the current price. Closed positions no longer contribute to the subject's score but continue to contribute decayed P&L to the attester's stewardship.

**Positions never auto-close.** They fade via continuous decay (see below). Let them fade; close explicitly only if you want to lock in a value or free slot capacity.

### Attestation-Count-Based Exponential Decay (Stewardship-Scaled)

Each attestation's weight decays as newer attestations about the **same (subject, scope)** arrive. The decay rate depends on the attester's stewardship at open time — trusted voices persist longer, untrusted voices fade faster:

```
r(K) = lerp(r_low, r_high, normalized(STEWARDSHIP(K) + 1) / 2)
  r_low  = 0.95 (low/zero stewardship — fast decay)
  r_high = 0.995 (max stewardship — slow decay)

weight_factor(A, now) = r(A.attester) ^ (later_attestations_about_same_subject_scope_than_A)
```

Reference half-lives:
- Zero stewardship: half-life ≈ 14 later attestations
- Mid stewardship: half-life ≈ 35 later attestations
- Full stewardship: half-life ≈ 140 later attestations

**Why stewardship-scaled decay:** a coordinated sybil pile-on (10 alts all attesting at once) has strong initial burst, but every sybil starts near zero stewardship → fast decay. After ~30 later attestations the sybil burst collapses to ~12% of original; meanwhile a single attestation from a proven steward retains ~86%. The sybils' attack window is ephemeral; trusted voices remain visible. This replaces explicit pile-on dampening rules — the decay itself handles coordinated abuse.

**Activity-adaptive by construction:** dormant subjects preserve scores (few new attestations to displace old ones); active subjects churn fast. The decay parameters work across scales — short 8-player rehearsals, week-long 5k-player tournaments, and continuous open-play all behave sensibly.

**Computational bound:** per subject per scope, attestations past their sig-digit threshold are dropped from query. Worst-case cache depth is around 700 attestations even for an all-high-stewardship subject; in practice much less because low-stewardship contributions fall out of query range sooner.

### Score Computation

```
Score(S, C) = normalized_sum over last ~700 attestations A about (S, C):
    A.polarity × A.size × attester_multiplier(A.attester) × weight_factor(A, now)
```

Normalization maps the raw sum to [-1, 1] via `tanh(sum / k)` where `k` is calibrated per scope.

**Open positions contribute at full score weight (times decay). Closed positions don't contribute to score at all** — closing removes the attestation from active market pricing.

### P&L and Stewardship (CONDUCT only)

For each CONDUCT attestation A opened by K about subject S:

```
unrealized_pnl(A, now) = A.polarity × A.size × (Score(S, conduct, now) - Score_at_open(A))
realized_pnl(A) = (locked at close time, same formula with close-time score)
```

Stewardship is a running weighted sum across all of K's CONDUCT positions:

```
STEWARDSHIP(K) =
  Σ over K's open positions: unrealized_pnl × weight_factor
  + Σ over K's closed positions: realized_pnl × weight_factor
```

**No separate "first-mover bonus" is needed.** The market math already rewards being early in both directions: Alice attesting +1 at score 0.3 earns P&L of (+0.4) when score moves to 0.7; Bob piling on at 0.65 earns only (+0.05). Being early with a correct call is naturally 8× as rewarding as late confirmation — direct consequence of the price-delta P&L mechanic.

Both realized and unrealized contributions decay at the same rate as the underlying attestation's weight. Old track record fades in current stewardship; lifetime cumulative can still be displayed for history.

**No close penalty; no minimum conviction period.** Close is neutral vs hold at any instant — both reflect the current score. Holding rides future movement; closing locks in the current value. Decay eventually flattens both. The market doesn't need artificial friction because fresh attestations already contribute little when they're fresh (the score barely moves from a single new attestation in a thick market).

### Slot Capacity (Activity-Adaptive)

Instead of a fixed slot count, slot cost itself decays:

```
used_slots(K) = Σ over K's open attestations: A.size × weight_factor(A, now)

max_slots(K) = 5 + 20 × normalized(CONDUCT(K) + STEWARDSHIP(K)) ∈ [5, 25]
```

A position opened at size 1 starts costing 1 slot, but after ~100 later attestations (about that subject/scope) its slot cost is ~37%, and after ~700 it's ~0.001 — effectively free.

**No explicit close needed for capacity reasons.** Old positions self-reclaim their slot cost as they decay. Users only need to close if they want to actively lock in a P&L value (rare).

If K is at `max_slots`, opening a new attestation requires closing an existing one — but this rarely happens in practice because older positions already consume almost nothing.

### CONDUCT Auto-Drip (Platform Event, Not Attestation)

Every cleanly-finished public game creates a weak positive CONDUCT signal for each participant. This is **not stored as an attestation**. It's a platform event derived from the existing game event logs:

```
Game completion event → plugin emits an in-memory signal:
  polarity +1, size 0.05, scope "conduct", subject=participant
  (weighted into Score computation but NOT eligible for P&L / stewardship)
```

Semantics: "this player participated and nobody reported them." Weak evidence — a single human attestation at size 1.0 outweighs 20 auto-drips.

This keeps the attestation table pure (only human-signed entries) while still providing a climb-out path for reformed players and a bootstrap signal for new players.

### No Separate Rate Limiting

Rate limiting falls out of the slot-capacity model: you can only have so many open attestations at once. Opening a new one while at capacity forces an explicit close of an old one. No weekly caps, no cron-reset counters.

## Community Guardian NFTs

On-chain recognition for top stewards.

- **Trigger:** end of each season (default quarterly, configurable). Mint to top N stewards by active stewardship.
- **Tiered:** Gold (top 10), Silver (11–50), Bronze (51–100).
- **Non-revocable:** once earned, permanent. Historical fact, not current status.
- **Metadata on-chain:** season, score, rank, timestamp.
- **No functional effect.** Pure recognition. Displayable anywhere NFTs display.

### Minting Flow

- End of season: compute stewardship leaderboard from current snapshot
- Batch mint (ERC-721 or ERC-1155, one token per recipient) on OP Sepolia
- Emit on-chain event
- Record tx hash in `guardian_mints` D1 table for internal queries

## Known Failure Modes

### Short-Term Cabal Capture

**Attack:** Coordinated group pushes a target's CONDUCT score in a wrong direction.

**During capture:** cabal members gain temporary unrealized P&L (score is moving their way); honest attesters lose. Once the cabal's attestation flow stops, subsequent attestations from broader participation revert the score, reversing the P&L. Unrealized flips correctly; realized was locked at whatever the cabal-era price was, but decays out.

**Defenses:** decay rate ensures cabals must *continuously* dominate flow to maintain capture; natural reversion once attention shifts; independence bonus limits late-piler rewards; attester_multiplier dampens low-CONDUCT voice.

**Accepted residual:** sustained, sophisticated, uncoupled coordination can still damage honest stewardships temporarily. Rely on (a) economic irrationality of sustained attack, (b) auditability, (c) broad participation at scale.

### Real-Person Collusion at Scale

**Attack:** N human players coordinate to push reputation of a target.

**Defenses:** same as cabal capture. If enough sincere humans agree, the system treats that as truth by construction — we do not have an oracle.

### Sybil Farms

**Attack:** One person creates N alt accounts.

**Defenses:**
- Identity cost (ERC-8004 registration)
- Each alt starts at CONDUCT=0, STEWARDSHIP=0 — low multiplier, little voice
- Alts have to earn voice independently through real attestations on real disputes

**Accepted residual:** proof-of-personhood stronger than ERC-8004 (Worldcoin, Gitcoin Passport) is a future integration point.

### Stewardship Volatility

**Problem:** active stewardship can dip during cabal capture or unlucky streaks.

**Mitigations:** display multiple timescales (current, recent, lifetime); lobby thresholds can reference peak-in-window rather than current.

## Platform API Additions

### 1. Attestation Storage + Endpoints

- **New `attestations` table:** `(id, attester_wallet, subject_wallet, polarity, size, scope, reason, timestamp, signature, closed_at)`, indexed on `(subject_wallet, scope, timestamp)` and `(attester_wallet, timestamp)`.
- **Signature format:** EIP-712 per EAS off-chain attestation spec. EAS schema registry entry for the payload type so tooling is compatible.
- **`POST /api/attestations`** — validate signature, check slot capacity, append, call `attestations.ingestAttestation(...)` inline.
- **`POST /api/attestations/:id/close`** — explicit close; locks realized P&L, marks `closed_at`.
- **`GET /api/attestations?subject=&attester=&scope=&status=open|closed|all&cursor=&limit=`** — public read, paginated.
- **`GET /api/attestations/:id/proof`** — returns attestation + Merkle proof against that day's on-chain root.
- Reads unauthenticated; writes require valid signature.

### 2. Daily Merkle Anchor

- **New `AttestationAnchor` contract** on OP Sepolia. Stores `date → (merkle_root, attestation_count, anchor_timestamp)`.
- **Nightly cron** computes Merkle tree of that day's attestations, calls `AttestationAnchor.postDailyRoot(date, root, count)`. ~40K gas/day.
- **Third-party verification:** consumer fetches attestation + Merkle proof via `/api/attestations/:id/proof`, verifies signature + Merkle membership on-chain. No server trust required.

### 3. Scoped Score Read Endpoints

- **`GET /api/scores/:wallet/:scope`** — current score
- **`GET /api/scores/:wallet`** — all scopes a player has a score in
- **`GET /api/stewardship/:wallet`** — current stewardship
- **`GET /api/guardians/:season`** — NFT recipients for that season

### 4. Per-Game Structured Outcomes

- **`GET /api/games/:id/outcomes`** — thin join `match_players JOIN players`, returns `[{wallet, handle, team}]`
- **Audit:** verify `recordGameResult()` fires for every finished public game across all game types; flag abandonments distinctly.

### 5. Wallet-Keyed Per-Player History

- **`GET /api/players/:walletOrHandle/games?cursor=&limit=`** — paginated. External-identity-keyed variant of existing `/api/player/stats`.

### 6. Rate-Limit Infrastructure

Platform currently has zero rate limiting. Basic per-wallet per-endpoint throttling (Durable Object or D1-backed counter) is a prerequisite to expose these endpoints publicly. Independent of the reputation design but required for ship.

## Implementation Notes

### Storage

Platform-level:
- `attestations` — all signed attestation events + close events (event-sourced, immutable)
- `attestation_merkle_roots` — daily roots with tx hashes

Plugin-internal to `@ctl/attestations`:
- `att_score_cache` — per-`(subject, scope)` current score (materialized from last ~700 attestations)
- `att_stewardship_snapshots` — per-attester STEWARDSHIP over time for trend display
- `att_open_positions` — index of open attestations per attester (for slot computation)
- `guardian_mints` — NFT mint tx hashes per season per recipient

Existing tables consumed read-only:
- `players`, `matches`, `match_players`

Cloudflare D1 for persistence. Durable Objects already handle real-time lobby state.

### Update Flow

On new attestation (ingest):
1. Validate signature + slot capacity + scope
2. Append to `attestations`
3. Recompute `(subject, scope)` Score (sum over last ~700 attestations, apply decay)
4. Update `att_open_positions` for the attester
5. If `scope == "conduct"`, recompute the attester's live stewardship (fast — sums over their open positions' unrealized P&L + closed positions' decayed realized P&L)

On close:
1. Mark `closed_at` on the attestation
2. Lock realized_pnl at current Score
3. Recompute `(subject, scope)` Score (closed attestation no longer contributes)
4. Update attester's stewardship

On game completion (event):
1. Plugin emits an internal auto-drip signal for each participant
2. Folded into Score computation for the relevant `(subject, conduct)` cache
3. Not stored in `attestations` table; derived from `game_events`

On daily cron:
1. Compute Merkle root of that day's attestations
2. Post to `AttestationAnchor` on OP Sepolia
3. Optionally: compute stewardship snapshot for leaderboards

On season boundary:
1. Compute stewardship leaderboard
2. Batch mint Guardian NFTs
3. Record tx hashes

All per-event updates are O(~700) at most. No iteration, no global convergence.

### Caching

Server sets `Cache-Control` headers; Cloudflare edge handles the rest.

- Finished-game replays/bundles: immutable, `max-age=31536000`
- Current scores: short TTL (30–60s)
- Stewardship: a few hours
- Player history: a few minutes

No bespoke cache layer needed.

### Plugin Surface

```typescript
// packages/attestations/src/index.ts
export async function ingestAttestation(a: Attestation): Promise<void>
export async function closeAttestation(id: string, attester: WalletAddress): Promise<void>
export async function ingestGameFinished(e: GameFinishedEvent): Promise<void>
export async function checkEntry(
  wallet: WalletAddress, lobbyConfig: LobbyConfig
): Promise<{ allowed: boolean; reason?: string }>
export async function getScore(wallet: WalletAddress, scope: string): Promise<number | null>
export async function getStewardship(wallet: WalletAddress): Promise<number | null>
export async function runDailyMerkleRollup(): Promise<void>
export async function runSeasonalGuardianMint(): Promise<void>
```

Direct module imports from the server. No event bus, no dynamic registry.

## Open Questions

1. **Decay parameter `r`.** 0.99 default. Tune empirically.
2. **α value for stewardship weighting.** 0.5 default.
3. **Independence bonus precise formula.** Rewards early contrarian correct calls.
4. **Normalization constant `k` per scope.** Calibrate so typical busy subjects land in a useful range.
5. **Guardian NFT cadence + re-mint policy.** Quarterly default; re-mint each season seems right.
6. **`recordGameResult()` coverage audit.** Must fire for every finished public game, abandonments flagged.
7. **Reason-text moderation.** Cap at 1000 chars; plain text; monitor for harassment disguised as attestation text.
8. **Settlement coupling timeline.** Coordinate with `onchain-reintegration.md` phase 3 so `match_players` becomes a cache of on-chain truth.

## Out of Scope for v1

- Proof-of-personhood beyond ERC-8004
- Webhook infrastructure for external plugins (private lobbies cover the case)
- Multi-plugin composition
- Full per-attestation on-chain storage (Merkle rollup covers auditability)
- Signed-token delegation for private lobbies
- Formal dispute or appeals
- Stake-based (fungible) slot capacity

## Possible Future Extensions

- **Seasonal on-chain reputation anchors.** Alongside Guardian NFTs at season end, optionally publish aggregated per-player CONDUCT and SKILL scores on-chain as a signed attestation or ERC-7572 snapshot. Gives external protocols a cheap, authoritative reputation read without verifying daily Merkle proofs. Natural fit for the quarterly cadence we already have for Guardian NFTs.
- **Webhook-based external plugins** if communities want platform-side enforcement of custom reputation logic beyond private lobbies.
- **Richer stewardship decomposition** (calibration vs independence shown separately, domain-specialized stewardship).
- **Multi-plugin lobby gates** (`{ min_score: { conduct: 0.6, skill:oathbreaker: 0.5 } }`).

## Migration from Existing Code

- `server/relay.ts` (or equivalent location) EIP-712 + EAS plumbing: keep the signing flow; replace schema with polarity + scope. EAS off-chain format + daily Merkle rollup replaces per-attestation on-chain posting.
- Coordinate with `onchain-reintegration.md` phase 3. Until that lands, `match_players` is the authoritative outcome source.

## Philosophical Notes for Future Maintainers

1. **Resist re-enshrining metrics in the core.** New scoring features belong in a plugin, not the platform.
2. **Resist adding authority.** The market is the dispute mechanism. The only explicit escape hatch is platform-access bans for real-world-harmful behavior.
3. **Resist tokens.** Fungible units ("just a fee," "just a stake," "just a UBI") bring plutocracy back. Non-financial reputation is a deliberate choice.
4. **Resist graph algorithms.** PageRank/EigenTrust were considered and rejected; decay + independence catch the same cases at a fraction of the cost.
5. **Resist circular amplification.** Only CONDUCT has stewardship. Skill is not self-weighted by skill judgment.
6. **Keep the storage event-sourced.** Derived state is a cache; raw attestations + close events are truth. Corruption recoverable by replay.
7. **Server-side canonical, client-side consumption.** Agents don't run algorithms; they attest/close and read results.
