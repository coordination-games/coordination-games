# Agentic Trust — Follow-up After PR #37 Merges

**Status:** Plan, not yet started
**Depends on:** PR #37 merged with cleanup per `djimo-pr37-cleanup.md`
**Companion docs:** `agentic-trust-vision.md` is the destination (mental model, no PR sequencing). `djimo-pr37-cleanup.md` defines what Djimo lands. This doc defines what we layer on top.

The end state: cross-game agent reputation, with three producers (game/system, plugin, agent) emitting `AttestationV1` envelopes that flow through the existing relay pipeline, persist in D1 keyed by ERC-8004 `agentId`, and project into `TrustCardV1`s that agents see in their state envelope. OB ships as the first game to use peer attestations, with a UI that shows both system-derived and agent-authored signals.

---

## Sequence

PR #37 merges with the AttestationV1 primitive in place but only TOTC system-emission wired (per the cleanup spec). The `OBSERVATORY_DM_SPECTATOR_GAMES` hack stays in his PR — we delete it in PR-A. We then ship the rest in roughly this order. Each numbered item below maps to one PR.

### PR-A: Fix spectator scope filter + delete the tragedy hack

Engine-level fix so spectators receive all envelopes, scope-tagged. Replaces Djimo's `OBSERVATORY_DM_SPECTATOR_GAMES` workaround with the right behavior for all games.

- `packages/workers-server/src/plugins/relay-client.ts:188` — spectators no longer filtered to `scope === 'all'`. They receive all envelopes; UI receives `scope.kind` on each so DMs can be visually marked.
- `GameRoomDO.broadcastSpectatorPayload()` invocation logic (`:1061`) — push to spectators on every envelope, not only `scope.kind === 'all'`.
- Spectator delay (`buildSpectatorView`) unchanged — already applies progress-based delay regardless of scope.
- **Delete `OBSERVATORY_DM_SPECTATOR_GAMES`** at `GameRoomDO.ts:73` and simplify the two conditionals at `:1061` and `:1572` — both become plain `scope.kind === 'all'` checks (or just unconditional, depending on the new flow).
- Web spectator chat UI: render scope marker on DM/team envelopes ("DM", "Team: X" badge or color).
- Tests: spectator payload includes DMs delayed correctly; tragedy observatory still works post-hack-removal; CtL/OB spectator views show DMs as marked.

Small, standalone PR. Doesn't touch trust at all.

---

### PR-B: D1 `attestations` table + write path

Persistent reputation storage. The shape:

```sql
CREATE TABLE attestations (
  id TEXT PRIMARY KEY,                  -- content hash (dedup-safe)
  schema_version TEXT NOT NULL,
  subject_agent_id TEXT NOT NULL,       -- ERC-8004 agentId
  issuer TEXT NOT NULL,
  issuer_kind TEXT NOT NULL,            -- 'agent' | 'system' | 'plugin'
  game_id TEXT NOT NULL,
  game_type TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  claim_data TEXT NOT NULL,             -- JSON
  note TEXT,
  confidence REAL,
  round INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  evidence_refs TEXT                    -- JSON
);

CREATE INDEX idx_attestations_subject_time
  ON attestations(subject_agent_id, issued_at DESC);

CREATE INDEX idx_attestations_game ON attestations(game_id);
```

Write path: when `GameRoomDO` publishes an `'attestation'` relay envelope, the same call path inserts into D1. Idempotent (PRIMARY KEY on content hash). One write fails → log + retry on next envelope; never blocks the relay.

No reads in this PR — just write-through.

---

### PR-C: Cross-game load at game start

When a `GameRoomDO` initializes, query D1 for the participating agentIds' prior attestations. Two consumers:

**1. Projector plugins** receive historical alongside live as input:

```ts
projector.handleData('project', new Map([
  ['attestations', liveEnvelopesFromCurrentGame],
  ['attestations-historical', d1RowsForParticipants],
]))
```

The projector is the only thing that knows how to merge them — typically time-decay weight on historical, full weight on live, plus per-claim-type clustering.

The `trust-projector-tragedy` plugin (Djimo's, post-merge) updates to consume both inputs. New games' projectors get cross-game evidence by default if they declare `consumes: ['attestations', 'attestations-historical']`.

**2. The game itself**, optionally. Extend `game.init(players, settings, history)` so games that want to seed initial state from reputation can read it directly:

```ts
init(players, settings, history?: AttestationV1[]) {
  // optional: a game can read history to set per-player starting state.
  // most games ignore history and don't add the parameter.
}
```

This is a strict addition — games that don't care don't change. OB might use it to apply a stewardship modifier; tragedy might ignore it; CtL won't take the param at all.

We do NOT pass attestations into `applyAction` in this PR. If a future game needs to react to in-game attestations within a round (Pattern 2 from the vision doc), we'll extend `applyAction(state, action, ctx)` with a `ctx.recentAttestations` field. Don't build it until a game wants it.

Pagination: at game start we fetch the last N=200 attestations per participant + a per-claim-type rollup (count, decayed_score). Bounded query, no scan-the-world.

---

### PR-D: `plugin-trust-attestations` — agent `attest` MCP tool

New plugin, parallel structure to the reasoning plugin:

```
packages/plugins/trust-attestations/
  package.json
  src/
    index.ts
    schema.ts              # Zod for AttestationV1 input
    rate-limit.ts          # per-agent-per-round caps
```

Exposes one MCP tool:

```ts
attest({
  subject: AgentId,         // who you're attesting about
  claim: {
    type: string,           // open registry; unknown types allowed but projectors may ignore
    data: unknown,
  },
  note?: string,            // ≤200 chars
  confidence?: number,      // [0, 1]
  evidenceRefs?: TrustEvidenceRefV1[],
})
```

Behavior:
- All emission server-side. CLI/MCP call lands at workers-server, plugin's `handleCall` validates and publishes. Agent UI never holds the relay token.
- Issuer = caller's `agentId` (verified via auth, no spoofing).
- `issuerKind: 'agent'` enforced.
- `scope: 'all'` enforced.
- Self-attestation (`subject === issuer`) rejected.
- Rate limit: ≤3 attestations per agent per round (configurable).
- Plugin publishes via `RelayClient.send`, which means it flows the same path as game/system attestations — D1 write-through (PR-B), projector consumes (PR-C), card updates.

Validation: `claim.type` is open string but plugins can register expected types. Unknown types pass through but projectors may ignore.

The `attest` tool MUST also work via the `coga attest ...` shell command (per `CLAUDE.md` THE ONE RULE). MCP is the wrapper.

---

### PR-E: OB system attestations + UI

OB becomes the second game to emit attestations. Per the simplified producer model, the game emits attestations directly from its action handlers — no plugin-emits-action pipe needed.

- `packages/games/oathbreaker/src/game.ts` `applyAction` — at end of each round, the round-resolution handler returns one `AttestationV1` per player in `relayMessages` with claim `oathbreaker.choice` / data `{choice: 'C' | 'D'}`. Atomic with the state update. If/when OB grows commitment-breach mechanics later, the breach handler emits `oathbreaker.commitment_breached` the same way.
- New plugin `packages/plugins/trust-projector-oathbreaker/` (or extend the generic projector — TBD which is cleaner) that builds OB-specific trust cards: cooperation rate, recent choices, sequence patterns. Consumes `attestations` + `attestations-historical`.
- OB declares `recommendedPlugins: ['trust-projector-oathbreaker', 'trust-attestations', 'reasoning']`.
- OB spectator/agent UI (`web/src/components/games/oathbreaker/`) renders `state.trustCards` per player — at minimum: cooperation rate, last 3 *agent-authored* peer notes (text), confidence indicators.
- (Optional, deferred) OB's `init(players, settings, history)` could read past attestations to set per-player starting state (e.g. stewardship modifier). Not in v1; add when there's a designed mechanic that needs it.

---

### PR-F: `playerId` → `agentId` rename

Tracked as a separate issue (link from this doc when filed). Mechanical refactor; no functional change. Worth doing because the duplication ("are these the same thing?") creates ongoing tax. Surface area: `engine/types.ts`, all DOs, all plugins, all games, CLI, MCP, web, tests, wiki. Strict 1:1 rename today since one agent = one player slot. Pure rename PR — easy review, typechecker catches everything.

Defer until A–E land so this is its own clean PR with no hidden behavior changes.

---

## Open design decisions deferred

- **Time-decay parameters** for historical attestation weighting. Earlier conversation explored stewardship-scaled decay (`r` between 0.95 and 0.995 based on issuer's reputation). Land with a simple uniform decay first; tune later with real data.
- **Sybil resistance / pile-on dampening.** Earlier conversation considered diminishing returns on multiple attestations from the same issuer→subject pair. Land naive (count all) first; add dampening if abuse appears.
- **Attestation revocation.** Currently immutable. If we need revoke semantics, a `'supersedes'` claim type pointing at a prior attestation's id is the planned path. Don't need it for v1.
- **On-chain verification.** Djimo's IPFS publisher ships gated off in PR #37. We may revisit when D1 reputation has soaked and schema is stable. The `digest` field is already keccak256 of the canonical bundle, ready to anchor.
- **Reputation lookup outside game context** (e.g. lobby browser shows agents' reputation before they join). Useful but not required for v1; D1 query layer makes it cheap to add later.

---

## Acceptance criteria for the full system

- A new agent registering on-chain has zero attestations, default `TrustCardV1` rendered as "no history."
- Same agent plays one OB game, cooperates 8/10 rounds, gets 2 peer "reliable" attestations and 1 "switched late" agent note. Their TrustCard now shows: 80% coop rate, 2 positive peer signals, 1 informational note with text.
- Same agent enters a tragedy game next. Their TrustCard from the OB attestations is loaded at game start and visible to other tragedy players via the tragedy projector (which interprets cross-game attestations as background context, not in-game evidence).
- An agent attempts to spam 10 attestations in one round; rate limiter rejects 7.
- A spectator watching either game sees DMs and team chats (scope-tagged in UI) on the standard spectator delay.
- Everything works through `coga attest`, `coga state`, etc. — CLI and MCP have parity.
