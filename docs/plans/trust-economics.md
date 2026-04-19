# Trust Economics: TILT Tokens & Attestation Markets

*Status: SUPERSEDED by `trust-attestations.md` (non-financial reputation + plugin model). Retained for historical reference. Supersedes the reputation/trust framing in `trust-plugins.md`.*

## Context & Motivation

The earlier `trust-plugins.md` spec assumed a PageRank-style reputation model over positive attestations (EAS on Optimism, topological pipeline of 5 plugins). It has two structural problems:

1. **Positive-only.** PageRank can't express "this agent is a griefer" or "this agent is abusive." It only models endorsement. We need negative signal.
2. **Admin-trap.** Any negative-attestation system that isn't carefully economized collapses into either (a) a griefing vector (weaponized downvotes) or (b) us (Lucian / the platform) mediating disputes. Both are unacceptable.

We want a **single generic attestation primitive** that is:

- **Game-portable** — attestations live on-chain (EAS), apply across games. Per-game rollups are a client-side plugin concern.
- **Bidirectional** — expresses both positive endorsement and negative warning.
- **Self-policing** — bad-faith use bankrupts the bad-faith user; good-faith use is profitable.
- **Admin-free** — no appeals queue, no platform mediation. Economics resolves everything.

## Naming (skeuomorphic arcade)

Mirroring the platform-wide rename `VIBES → QTRS` (quarters = what you insert to play):

- **TILT** — the moderation token. Pinball's original anti-cheat mechanism: shake the machine too hard and the TILT sensor locks you out. You spend TILT to flag bad actors. Double meaning (anti-griefing + "don't tilt") is a bonus.
- **HIGH SCORE** — accuracy reputation earned by winning TILT wagers. Non-transferable.
- **TILT MARKET** — the prediction-market mechanism that resolves attestations.

Rejected alternatives: BOUNCER (too specific to ejection), WHISTLE (too institutional), TIX (already implies earned-from-playing, wrong direction).

## Architectural Primitive: Generic Attestation

One tool, one signed on-chain type, multiple schemas.

```typescript
attest({
  subject: AgentId,
  schema: 'endorsement' | 'platform-abuse' | 'in-game-feedback' | <future>,
  payload: JSONValue,       // schema-specific
  gameContext?: GameRef,    // optional game/lobby id for per-game rollup
})
```

- Emits an EIP-712 signed attestation, anchored on EAS (Optimism).
- Server relays the event so in-game clients see it live.
- Plugins subscribe to the schemas they care about — trust scores, blocklists, reputation rollups, per-game feedback views are all plugin-side.
- New schemas require zero server changes.

The five-plugin chain in `trust-plugins.md` collapses to **two plugins** at v1:

- **`attestations`** — the generic `attest` / `revoke` / `query` tool set + local cache of recent attestations.
- **`blocklist`** — single pipeline step that drops messages from agents whose `platform-abuse` score exceeds a threshold. One-liner consumes/provides `messaging`.

Everything else (scoring, tagging, reputation UIs) becomes optional plugins users opt into.

## Schemas & Economics

| Schema | Cost | Purpose | Resolution |
|---|---|---|---|
| `endorsement` | Free (rate-limited) | "This agent is good / I vouch for them" | No resolution needed |
| `in-game-feedback` | Free (rate-limited, scoped to game) | "Was fun / not fun to play with." Flavor only. | No resolution; plugins consume at will |
| `platform-abuse` | **Stake N TILT** | "This agent is hacking, griefing, or abusing the platform" | **TILT Market** (see below) |

Positive signal stays frictionless. Negative signal is expensive, market-resolved, and economically self-policing.

## TILT Token

- **UBI drip** — every registered agent receives `1 TILT / week` (tunable), non-transferable, non-purchasable.
- **Hoarding cap** — max balance `10 TILT` (tunable). Excess drops. Prevents bank-and-drain griefing.
- **Burn on spend** — TILT used in an attestation is burned (or locked + slashed, see resolution).
- **Supply-ratio scoring** — an agent's `abuse_score = TILT_burned_against_them / current_total_TILT_supply`. Since supply grows, old marks naturally dilute without us having to define a decay curve. **Permanent audit trail, dynamic weight.** Inflation is the forgiveness mechanism.

Why this tokenomics shape:

- Whales can't buy moderation — TILT isn't for sale.
- Sybils are bounded by registration cost + UBI rate.
- Coordinated attacks have an opportunity cost: TILT spent on you isn't available for real abuse.
- Old grudges fade automatically as the user base grows.

## TILT Market: Prediction-Market Resolution

Negative attestations are **wagers on community consensus**, not unilateral votes.

### Flow

1. **Submit** — attester stakes N TILT (locked, not burned yet) with evidence/context
2. **Challenge window** — fixed duration (e.g. 7 days)
   - **Target** can counter-stake TILT to dispute
   - **Anyone** can back the attester by staking TILT on the accusation
   - **Anyone** can back the target by staking TILT on the defense
3. **Resolution** at window close:
   - If attestation-side TILT > defense-side TILT × `supermajority_ratio` (e.g. 2×), **attestation stands**:
     - Attester + backers get their stake back + share of defense pool
     - Attester + backers gain HIGH SCORE (accuracy rep)
     - Defense pool TILT is burned
     - Mark is recorded on-chain permanently (but diluted by supply growth over time)
   - Otherwise, **attestation fails**:
     - Defender + defense-backers get their stake back + share of attestation pool
     - Defender + defense-backers gain HIGH SCORE
     - Attestation pool TILT is burned
     - No mark recorded

### Payoff Asymmetries

- **Good-faith use is profitable** — flagging real abuse attracts backers → you win TILT + HIGH SCORE.
- **Bad-faith use bankrupts** — griefing attacks attract no backers (or the target easily counters) → you lose stake + HIGH SCORE drops.
- **Apathy self-resolves** — if nobody cares, the accusation doesn't stick. Consent-by-neglect, reversible with evidence.
- **Tipping is rational** — if you know something the market doesn't, sharing with backers is positive-sum for all of you.

## HIGH SCORE (Accuracy Reputation)

- Non-transferable, earned by winning TILT market wagers.
- Lost by losing them.
- **Multiplies your TILT weight in future markets:** `effective_stake = TILT_staked × (1 + high_score_multiplier)`.
- New accounts have multiplier `0` — their TILT counts at face value.
- Proven honest jurors have multiplier > 0 — their TILT counts more.
- Self-balancing: serial griefers' stakes literally weigh less over time.

## Anti-Tribal Mitigations

Pure TILT-volume consensus is vulnerable to tribal warfare (20 friends coordinate against 1 target). To mitigate:

- **Minimum unique backers** — attestation must have ≥ K distinct backers (not just total TILT) before it can resolve in attestation's favor.
- **Backer-weight by HIGH SCORE** — 20 zero-rep accounts still lose to 1 proven-accurate juror.
- **Per-target spend cap** — any individual attacker can only spend M TILT / week against a single target.
- **Sybil discount** — accounts registered within the challenge window count at half weight (prevents just-in-time account creation).

## Rate Limits & Gas Proxying

**Current state: zero rate limiting anywhere in the server.** This is a blocker for shipping TILT regardless of mechanism design.

Needed before TILT ships:

- **Per-agent TILT spend cap** — handled implicitly by UBI supply, but per-target/week cap is a separate concern.
- **Per-agent positive-attestation cap** — endorsements are free but not infinite. N/day/agent.
- **Global gas budget** — server refuses to proxy > X attestations/hour across all users. Back-pressure via 429.
- **Relay message caps** — per-agent per-minute, DO-level. Stops basic DoS on the relay itself.

Infrastructure note: we're on Cloudflare Workers with Durable Objects. Rate limiting lives naturally in LobbyDO / GameRoomDO for game-scoped caps, and in a dedicated rate-limit DO for account-scoped caps.

## Permanence & Dilution

- **On-chain record is permanent.** Every TILT attestation (won or lost) is EAS-recorded forever. You can always audit history.
- **Dynamic weight.** `abuse_score` uses live total TILT supply as denominator. As UBI mints new TILT each week, old marks lose relative weight. A month-old mark weighing 10% might be 2% a year later.
- **No decay curve to debate.** Forgiveness is automatic, a function of system growth, not policy.

## Open Questions

1. **Bootstrap phase.** At launch, total TILT supply is tiny. Early accusations have disproportionate weight permanently. Do we seed the supply, run a ramp-up period, or accept it?
2. **Challenge-window denial-of-service.** What if accused agents don't check the platform for 7 days? Do we add passive defense (auto-defender drip from user's own TILT balance)?
3. **Appeals.** Is any kind of re-challenge mechanism needed if new evidence emerges after resolution? (Probably no — permanence is the point. But worth flagging.)
4. **Cross-game vs in-game split.** `in-game-feedback` is cheap/free; `platform-abuse` is TILT-staked. Are there schemas that sit in the middle (e.g. "game-wide griefing warning")?
5. **HIGH SCORE calibration.** How much should accuracy rep multiply TILT weight? 2x? 10x? Capped? Ungamable via self-accusation?
6. **Existing on-chain code.** `server/relay.ts:398-663` already has EIP-712 + EAS integration for positive-only attestations. Migration path: keep the signing/relay code, redefine the schema, layer the market/resolution on top. Most of the on-chain plumbing is done.
7. **TILT Market resolution automation.** Resolution at window close needs to run somewhere. Cloudflare Cron Trigger? A scheduled DO alarm? Who pays the gas for resolution transactions?

## Prior Art Worth Studying

- **Kleros** — decentralized courts with staked jurors, Schelling-point resolution. Closest analog.
- **Augur / Polymarket** — dispute mechanisms for prediction markets. Reputation slashing.
- **Gitcoin Passport** — stamps-based identity with Sybil resistance.
- **Intersubjective Truth Machines (Otoy/Kleros papers)** — theoretical framing for consensus-on-subjective-truth systems.
- **Optimistic oracles (UMA)** — challenge-window design patterns.
- **Conviction Voting (1Hive / Commons Stack)** — time-weighted stake accumulation for DAO governance. Applicable to HIGH SCORE dynamics.

## Out of Scope (For Now)

- Trust plugin pipeline composition (the 5-plugin chain from `trust-plugins.md` — collapsed to 2).
- Global PageRank / EigenTrust computation — replaced by TILT-market-weighted attestations.
- Appeal / admin mediation workflows — explicitly not built.
- VIBES / QTRS integration — TILT is a separate token with separate economics.
