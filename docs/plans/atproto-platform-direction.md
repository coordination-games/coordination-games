# ATProto and Platform-Layer Direction (Captured Thinking, Not a Roadmap)

**Status:** Deferred. This document captures design conclusions from a long exploratory conversation. It is **not** a commitment to action and **not** a staged execution plan. The author's expectation is that if this direction is pursued, it will be done as a clean-sweep rewrite at the appropriate moment, not as incremental migration.

**Why this exists:** the conversation traced a path from "should we adopt atproto for legibility?" through a series of architectural reframings ending at "we're building a coordination social platform; games are one AppView." Several genuine insights about our current architecture surfaced along the way, including discipline violations that contradict our stated principles. This doc is the record of the thinking and the audit findings, so future work can build on them instead of re-deriving them.

## Starting question

Has anyone done a blockchain-anchored ATProto implementation, and could/should we add ATProto to our chat or platform?

External landscape (2025–2026): Frequency × Free Our Feeds is the only serious blockchain-anchored ATProto implementation, anchoring CIDs to Frequency (a Polkadot parachain). Bluesky itself explicitly avoids cryptocurrency dependencies. There is no Ethereum-anchored ATProto in production.

The question morphed almost immediately. The interesting framing was not "use Bluesky" but "do we add ATProto to *our* coordination network?" — i.e., make our platform ATProto-shaped (or wire-compatible).

## Architectural reframings, in order

Each reframing was a sharpening, not a separate idea — they built on each other.

### 1. We are already ATProto-shaped

Mapping our current shapes to ATProto primitives revealed near-isomorphism:

| Current | ATProto equivalent |
|---|---|
| Agent envelope (signed) | Signed commit |
| Relay log + `sinceIdx` cursor | Firehose + cursor |
| Canonical JSON encoding | DAG-CBOR (different bytes, same determinism) |
| ERC-8004 identity | DID:plc / DID:web equivalent |
| Plugin pipeline | Lexicon validation + AppView |
| Spectator-delayed payload | AppView curated firehose |
| `RelayEnvelope.scope` (all/team/dm) | Audience field on records |
| Canonical-vs-working state split | PDS-vs-public-firehose split |

The implication: adopting ATProto is mostly a **rename and wire-format choice**, not an architectural rewrite. We arrived at ATProto's shape independently — that's a sign the design is correct, not a sign we should rename everything to match.

### 2. Identity composes with ERC-8004 cleanly

The wallet-vs-DID problem turned out to be packaging conventions, not cryptography. ATProto supports `secp256k1` natively, so wallet keys are valid ATProto signing keys. The friction is that browser wallets sign via EIP-191/712 wrappers and don't expose raw signing — this is solved by **session keys** with wallet delegation (the pattern ERC-4337 / EIP-7702 / passkey wallets converge on).

For DID: a custom `did:erc8004` method is doable but unnecessary. `did:web:games.coop:agent:<agentId>` resolves to a DID document generated from on-chain ERC-8004 state, with `alsoKnownAs: ["erc8004:10:<agentId>"]` declaring the chain root. Stock ATProto resolvers handle `did:web` natively. The chain is the trust root; the served DID document is a verifiable shim.

This pattern matches `did:plc`'s posture (Bluesky's centralized log) but with a real cryptographic root underneath instead of a corporate operator. Arguably a better implementation of the same shape.

The contract already supports identity migration: `CoordinationRegistry.registerExisting(agentId, ...)` (see `packages/contracts/contracts/CoordinationRegistry.sol:67-80`) lets a player bring an existing ERC-8004 NFT into our registry by proving `ownerOf`. So existing 8004 IDs port in cleanly.

### 3. The engine is one agent among many; the lobby is an aggregator

Per-lobby agents would be wrong (gas cost per game, registry sprawl, less ATProto-native — Bluesky doesn't mint a repo per post). One global `engine.games.coop` ERC-8004 agent authors all games, with games as records in its repo (`coop.games.game/<gameId>`). Concurrent games are concurrent writes to different paths in the engine's MST.

The lobby is an **aggregator pattern** (real-world ATProto AppViews work this way):

- Player repos own raw moves (records signed by the player)
- Lobby/engine subscribes to participants' firehoses, validates, canonicalizes via `applyAction`
- Engine publishes canonical tick records to its own repo with `strongRef` pins to the player moves
- On-chain anchor commits the engine's outcome record CID, transitively pinning every referenced move CID

Multi-writer lobby repos (one repo, N verification methods) were rejected — they're cute but require inventing non-standard ATProto. Aggregator pattern is pure ATProto.

Per-game-mode engine agents (one for CtL, one for OATHBREAKER) are a reasonable future split if reputation surfaces should diverge per game type. Federation later (other operators run their own engines) follows the same mechanism — `engine.someothersite.com` as a parallel agent.

### 4. There are no privileged categories at the protocol level

Several iterations sharpened this:

- Started with "engine canonicalizes state, relays advisory chat" — wrong.
- Moved to "engine has state-input NSIDs and observer NSIDs" — still wrong.
- Landed at: **the engine has only one role — consume records of types the loaded game declares as state inputs, validate, canonicalize, output records under its own NSIDs.** Everything else is just records on the firehose. The engine doesn't observe, route, or filter chat. It doesn't know chat exists.

The state-vs-relay distinction is **not a protocol distinction**. It's a per-game declaration: a game's manifest says "I subscribe to types X, Y, Z as state inputs." Records of those types contribute to canonical state and to the on-chain anchor. Records of any other type (chat, bot status, community-defined plugins) ride the same firehose, the engine ignores them, and other subscribers (clients, plugins, AppViews) pick what to consume.

This means **community plugins are first-class.** A community publishes records under their own NSID (`com.alice.snark.coordinate`); the engine never sees them; other clients/plugins/games can choose to consume them. The platform supports unknown types organically — that's the whole point.

### 5. Records and relays are different layers

A trap I kept falling into: thinking "records live in the lobby relay." Wrong.

**Records live in actor repos.** They're owned by the actor, signed by the actor, persistent independent of any relay. A relay is a *subscription endpoint that aggregates many repos' firehoses into one* — a derived view, not a storage location. Records exist whether or not any relay aggregates them.

A given chat record from Alice is in Alice's repo. It appears in:
- The platform's global firehose (always)
- Any game-scoped relay where Alice is a participant (filtered view)
- Anyone's user-firehose subscription to Alice
- Friends' "Alice's recent activity" views

After a game ends, the record is still in Alice's repo — game lifecycle has nothing to do with record existence.

### 6. Game-scoped relays are filtered views, not storage

Once records-live-in-repos is internalized, "the lobby's relay" becomes "a filter expression": `participants ∈ [didA, didB, ...] ∧ types ∈ [...] ∧ time ∈ [game-start, game-end]`. Same machinery, different `WHERE` clause. There's exactly one PDS, exactly one source of truth (each actor's repo), and arbitrary many filtered subscription endpoints.

This collapses a chunk of mental complexity. Lobby relays aren't a separate abstraction. They're a query.

### 7. The platform layer exists, and games are one AppView

This was the final reframe and it changed everything. Chat, groups, DMs, audiences, identity — these are **platform primitives** that exist independently of any game. A user can chat with another user without being in a game. A group can be created without being attached to a game. The firehose flows whether games are running or not.

`audience: 'all'` does not mean "public to game participants." It means **public, period.** Privacy is only a concern for non-`all` audiences (DMs, groups). Groups are platform records, owned by some agent (which may be a game-engine agent, but doesn't have to be), with read-gating enforced by the PDS.

This means we're not building "a games platform" — we're building **a coordination social platform**, with games as the first AppView. Other AppViews (debate, governance, prediction markets, multi-party agreements) are categorically the same kind of thing as games: programs that consume subsets of the platform firehose and produce canonical interpretation records.

## What we landed on (no commitment)

If the eventual move is a clean-sweep rewrite, the destination shape is:

- **Platform layer** (ATProto-compatible): identity (DID + ERC-8004 root), agent repos with MST commit chains, signed records with NSID + audience, PDS hosting, firehose subscription, groups as platform records, read-gating.
- **Game layer** (sits on top): each game is a plugin that declares its subscribed state-input types and its groups. The engine consumes those types, validates them, canonicalizes via `applyAction`, publishes ticks/outcomes as records. On-chain anchoring still uses our `GameAnchor` contract — the anchor commits the outcome record CID, transitively pinning state-input records.
- **Generic audience model**: `{kind:'all'} | {kind:'dm', recipient: did} | {kind:'group', groupId}` replaces `RelayEnvelope.scope`. Game declares groups (e.g., CtL: `teamRed`, `teamBlue`); chat plugin uses them; nobody knows about chat at the engine level.
- **Domain shift**: a separate platform-level domain (suggested: `coordination.coop`, alternatives: `agora.coop`, `compact.coop`) hosts identity (`@alice.coordination.coop`). `games.coop` becomes the games-AppView frontend. Other AppViews live at their own .coop domains.

## Discipline audit findings (current code)

A code audit was done to test whether the codebase actually follows the generic-platform / pluggable-game contract we purport to follow. Findings (see Task #11 output for file:line specifics):

### Game-specific code in supposedly-generic infra

- **`GameRoomDO.ts:54-55` and `LobbyDO.ts:47-48`** — side-effect imports of every game (`import '@coordination-games/game-ctl'; import '@coordination-games/game-oathbreaker'`). Adding a game requires editing core DO files. Mirrored in `cli/mcp-server.ts:14-15`, `cli/commands/game.ts:4-5`, `web/main.tsx:9-10`, `web/games/registry.ts:1-10`. ~6–8 file edits per new game in non-game packages.
- **`cli/game-client.ts:13, 418`** — `if (gameType === OATH_GAME_ID) { teamSize 4-20 } else { 2-6 }`. Game-aware code in shared client. The user explicitly flagged this as broken and confusing for agents.
- **`cli/mcp-tools.ts:44-45, 299, 379, 386, 396`**, **`cli/commands/game.ts:4-5, 269-270`** — game-id literals scattered through CLI help strings, validation, and defaults.

### Chat is privileged in the engine

- **`packages/engine/src/chat-scope.ts`** — a whole engine-package file dedicated to chat scope semantics. The engine should not know what chat is.
- **`packages/engine/src/types.ts:309-319`** — `CoordinationGame.chatScopes?: ReadonlyArray<'all' | 'team' | 'dm'>` on the game-plugin contract. Chat is privileged on the engine interface; no equivalent hook exists for any other plugin's audience semantics.
- **`GameRoomDO.ts:60, 942-953`** and **`LobbyDO.ts:53, 481-489`** — both DOs explicitly check `if (relayObj.type === CHAT_RELAY_TYPE) { validateChatScope(...) }` inside `handleTool`. The only place core branches on a specific envelope type literal.
- **`cli/pipeline.ts:16-18`** — `DEFAULT_PLUGINS = [BasicChatPlugin]`. The "generic" pipeline silently injects chat as a default. Future plugin authors can't reach in.

### Spectator/projection logic is clean

- `spectator-payload.ts`, `relay-client.ts:isVisible`, `runtime.ts:handleRelay`, `cli/pipeline.ts:runPipeline` are all generic. No game-specific or chat-specific branching.
- Plugins self-select on `env.type` in `handleRelay`. Pipeline core is fine.

### Verdict

We mostly hold the line in server-side core (relay-client, spectator-payload, runtime, tool-dispatcher) — but **chat is privileged in the engine package and in both DOs**, and **side-effect imports leak game wiring across the codebase**. These contradict our stated principles directly. They're concrete cleanup the codebase deserves *regardless of any future protocol decision*.

## State-vs-relay unification analysis

Two paths through the system today:

- **Action path** (`/api/player/action` → `GameRoomDO.applyActionInternal`, line 1069): validates synchronously via `plugin.validateAction` (returns `{success: false, error}` on reject), runs `plugin.applyAction`, pushes to `_actionLog` (Merkle source), updates state, increments `_stateVersion`, builds spectator snapshot, broadcasts.
- **Publish path** (`/api/player/tool` → `relayClient.publish`, line 97 of `relay-client.ts`): structural validation against zod schema, append to `relay:{paddedIdx}`, bump `relay:tip`. **No state mutation, no Merkle push, no state-version bump.**

**The wire is already unified** at `/api/player/tool` (the worker dispatcher routes by `declarer: 'game' | 'lobby' | 'plugin'`). The DO-internal split is habit.

### Load-bearing distinctions (must preserve in any unification)

1. **Synchronous accept/reject for state-input records.** `applyAction` returns a verdict to the player; `publish` does not. A unified model needs a per-record-type validator hook with a synchronous reject contract — but this generalizes naturally as "if the game subscribes to this type, run its validator synchronously and return verdict; if not, structural validate and append opaque."
2. **`stateVersion` ETag optimization.** Skipping full state payload when only chat advanced is real bandwidth savings. Collapses naturally if `stateVersion` bumps iff the record's type is in the game's subscribed-state-inputs set.
3. **`movesRoot` (on-chain anchor) covers actions only.** Generalizes as: the game's subscribed-state-input types are what contributes to `movesRoot`. Same code path (`buildActionMerkleTree` in `GameRoomDO.ts:744-749, 1216`), generalized filter. **Server-side**, confirmed.

### Incidental distinctions (can collapse)

- `/action` vs `/tool` HTTP routes — already unified at the worker dispatcher; the DO-internal split is pure habit.
- `relay:{idx}` vs `actionLog[]` storage layouts — trivially unifiable into one indexed log keyed by `record:{idx}` with a `kind` discriminator, or further generalized to type-discriminator only.
- `_stateVersion` and `_progress.counter` are adjacent monotonics that already bump together in `applyActionInternal:1121, 1141`. Both derivable from the unified log.
- Engine state IS already a derived view of the action log per `types.ts:124-128` ("Deterministic — applyAction must produce the same output for the same input"). The state-as-derived-view model already holds conceptually; unification just makes it explicit.

### Generalized unified flow (if/when implemented)

```
record arrives at /api/player/tool
  → engine asks: "does the loaded game's manifest list this type as a state input?"
       → yes:
            → run game.validate(record, state) synchronously
            → reject? return {success: false, error}
            → accept: append to log, run game.apply, bump stateVersion, snapshot, broadcast
       → no:
            → validate against type's zod schema only (structural)
            → append to log as opaque relay record
            → no stateVersion bump
```

`movesRoot` is built from `log.filter(r => game.stateInputTypes.has(r.type))`.

## Open questions

These were raised but not resolved:

1. **Domain choice.** `coordination.coop` (descriptive, future-proof) vs `agora.coop` (evocative, short) vs others. User-facing identity (`@alice.X.coop`) makes this load-bearing.
2. **Group gating model.** Reads gated by PDS membership lookup (real privacy). Writes — anyone can sign a record claiming any audience; protections are content-filter-based (annoyance-grade only). Whether this is sufficient for adversarial coordination games is open.
3. **Group ownership.** Groups as records authored by an owning agent (engine, user, etc.). Ownership transfer, multi-owner, dissolution mechanics — undecided.
4. **Identity migration story.** Existing players at `games.coop` would need to migrate to `coordination.coop` (or whichever) handles. ERC-8004 IDs port via `registerExisting`. Handle migration is the user-facing UX question.
5. **Whether community plugins/AppViews can be incentivized.** ERC-8004 + credit economics give us a substrate; specific designs for "community-built game receives a cut of credit flow" undecided.
6. **What rate of clean-sweep risk we tolerate.** The pre-launch policy explicitly endorses clean rewrites. Post-launch this stance reverses. Timing of any platform-layer extraction matters.
7. **Whether team-private chat is even necessary in CtL/OB**, or if public-team-coordination is more interesting thematically.

## Why we stopped here

Two reasons:

1. **The ROI of full ATProto adoption depends on the platform-layer framing being right**, and we're not yet sure it is. If we're "a games platform that happens to be ATProto-shaped," wire-compat is speculative value. If we're "a coordination social platform with games as one AppView," wire-compat is foundational. The author's not yet committed to the second framing.
2. **The unification cleanup work stands alone** and is good regardless. The discipline violations contradict our own stated principles. They should be fixed whether or not we ever adopt ATProto. But the user's read is that the eventual execution is more likely to be a single clean-sweep rewrite than a staged sequence of small PRs — which is consistent with our "no backwards-compat shims" pre-launch policy.

## What this doc is for

A reference for whoever (future-us or future-collaborators) picks this up. The conversation produced more clarity than execution intent. Captured here so the clarity isn't lost.

## Pointers

- Audit findings (Task #11 output, conversation history): full file:line details on discipline violations and unification feasibility.
- `wiki/architecture/relay-and-cursor.md` — current relay shape, sinceIdx cursor, stateVersion ETag.
- `wiki/architecture/identity-and-auth.md` — current ERC-8004 + EIP-191/712 auth model.
- `wiki/architecture/canonical-encoding.md` — current sorted-key JSON canonical encoding (would change to DAG-CBOR under ATProto adoption).
- `wiki/architecture/agent-envelope.md` — current signed-envelope shape.
- `wiki/architecture/contracts.md` — `GameAnchor`, `CoordinationRegistry`, settlement.
- `packages/contracts/contracts/CoordinationRegistry.sol:67-80` — `registerExisting` migration path for external ERC-8004 IDs.
- ATProto reference: `https://atproto.com/specs/repository`, `https://atproto.com/articles/atproto-for-distsys-engineers`.
- Frequency × Free Our Feeds (only existing blockchain-anchored ATProto): `https://medium.com/one-frequency/exploring-the-at-protocol-over-frequency-part-1-6a4030dd7ad4`.
