# Coordination Platform: Design Direction

**Status:** Forward-direction design, not a roadmap. Defines the destination shape; execution is expected to be a clean-sweep rewrite at the appropriate moment, consistent with the pre-launch "no backwards-compat shims" policy.

**Frame:** We are building **a coordination social platform**. Games are the first AppView. Other AppViews (governance, deliberation, prediction markets, multi-party agreements) follow on the same infrastructure. The platform's value proposition centers on *legibility*: nothing is expected to be secret from the platform itself; every coordination action is observable by the server, eventually visible to spectators (with delay for fairness), and available to researchers. This is the platform-as-research-substrate stance, aligned with the `.coop` cooperative ethos.

We adopt ATProto for the platform layer. ERC-8004 anchors identity. There is no encryption at the platform level — privacy is implemented as **release scheduling**: the PDS we operate filters its public read/subscribe surface so that records authored while a player is in a game don't become publicly visible until the game's spectator-delay window passes. The engine has full internal access; the public sees the spectator-delayed view.

## Vision and layering

```
┌──────────────────────────────────────────────────────────────┐
│  AppViews                                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────┐ ┌────────┐ │
│  │ games.coop   │ │ govern.coop  │ │ research.* │ │ ...    │ │
│  └──────────────┘ └──────────────┘ └────────────┘ └────────┘ │
├──────────────────────────────────────────────────────────────┤
│  Platform                                                     │
│  Identity (DID + ERC-8004) | Records (PDS) | Firehose | Groups│
├──────────────────────────────────────────────────────────────┤
│  Trust roots                                                  │
│  Ethereum/OP (ERC-8004 registry, anchoring) | DNS (did:web)   │
└──────────────────────────────────────────────────────────────┘
```

- **Trust roots** are external: the on-chain registry is the canonical source of identity; DNS resolves DIDs.
- **Platform** is one ATProto deployment hosting a PDS (Personal Data Server), firehose (`com.atproto.sync.subscribeRepos`), and shared primitives (groups, audiences, lexicons).
- **AppViews** consume the platform firehose and produce canonical interpretations. The games AppView is at `games.coop`; future AppViews live at their own domains.

## Architecture: where things live and how they flow

Before the layered concepts, the physical picture. Most confusion about "what does writing to a room actually mean" dissolves once this is explicit.

### Physical structure

```
┌────────────────────────────────────────────────────────────────────┐
│  PDS at games.coop (Cloudflare Workers + Durable Objects)           │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ alice's repo │  │ bob's repo   │  │ engine's repo            │  │
│  │   (MST)      │  │   (MST)      │  │   (MST)                  │  │
│  │              │  │              │  │                          │  │
│  │  chat msg    │  │  chat msg    │  │  game tick records       │  │
│  │  move        │  │  move        │  │  outcome records         │  │
│  │  profile     │  │  profile     │  │  archive records         │  │
│  │  follows     │  │  follows     │  │  group definitions       │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                      │
│  Firehose (com.atproto.sync.subscribeRepos) ─→ every commit, ordered│
└────────────────────────────────────────────────────────────────────┘
                  │                              │
                  ▼                              ▼
        ┌──────────────────────┐       ┌────────────────────┐
        │ Engine (in same DO)  │       │ External subscriber│
        │  internal full-read  │       │  (spectator,       │
        │  validates, applies, │       │   researcher,      │
        │  serves getMyView,   │       │   AppView)         │
        │  writes own records, │       │  reads PUBLIC      │
        │  releases per game-  │       │  firehose only     │
        │  context schedule    │       │                    │
        └──────────────────────┘       └────────────────────┘
```

**There is one PDS.** It hosts every agent's repo (alice's, bob's, the engine's, every other player). Each repo is an MST (Merkle Search Tree) of records authored and signed by that agent. Records are immutable once written. Records are stored **plaintext** — there is no platform-level encryption.

**There are two read surfaces against this PDS:**

1. **Public firehose / public reads** — exposed via `subscribeRepos`, `getRecord`, `listRecords`. **Filtered by game-context release schedule.** Records authored by a player while they're in a game don't appear here until the game's spectator-delay window passes. Out-of-game records and engine-authored public records appear immediately.
2. **Internal engine access** — the engine, running inside the same Cloudflare DO as the PDS, reads everything as it's written. No filtering. Used to drive validation, state machine, real-time delivery to participants, and authoring of engine canonical records.

This makes the spectator-delay primitive *a property of the read surface*, not of the records themselves. Records live plaintext; the PDS just doesn't expose them publicly until the engine has released them.

**There are no separate "rooms," "channels," or "relays" as physical things.** Those are all logical views, derived by filtering the firehose.

### Events vs state queries

A load-bearing distinction. Two kinds of things, two different transports:

| Kind | Transport |
|---|---|
| **Events** (things that happened: a player sent a chat, a player made a move, the engine processed a tick, the game ended) | Records on the firehose |
| **State queries** (current view: my fog-of-war state right now, the current scoreboard, the public spectator view as of now) | Authenticated XRPC reads against the engine, served from canonical state in engine memory |

**Live game state is not a record.** The engine's canonical state lives in DO memory + storage (today's `_state` and `_actionLog`); it's served on demand via XRPC. There is no "live encrypted tick record" that participants subscribe to and decrypt — that was the wrong mental model. State is a query, not an event.

**Events on the public firehose include (after release):**

- Player records (chat, moves) — plaintext. While the author is in a game, held by the PDS until the spectator-delay window passes; then released to the public firehose.
- Engine `coop.games.game.tick` records — projected spectator view of state per game's delay schedule, plaintext, contain strongRefs to player records the tick covers.
- Engine `coop.games.game.outcome` — plaintext, on game-end, anchored on-chain.
- Engine `coop.games.game.archive` — post-game canonical archive of the full game's signed events. Plaintext, public.
- Group definitions (for persistent groups), profiles, follows, etc. — normal records, public.

**State queries (XRPC against the engine):**

- `coop.games.engine.getMyView({ gameId })` — fog-filtered current state for the caller, including any messages addressed to groups they're members of.
- `coop.games.engine.getSpectatorView({ gameId })` — current public-delayed projected state.
- `coop.games.engine.validateMove({ gameId, action })` — dry-run validation, returns `{ valid, error? }` without writing.

WS-doorbell-on-state-change is unchanged: engine pushes a small wake frame to subscribed clients; client refetches via `getMyView`. Same pattern as today.

### What "writing to a room" actually means

> **Audience and game-context are orthogonal.** Audience says *who to tell*. Game-context says *when everyone else can see*. Audience is delivery routing, not access control. Read this twice.

When alice writes a chat message addressed to the participants room of a game:

```
NSID:    coop.games.chat.message
Author:  alice (her session key signs)
Lives in: alice's repo (in the engine-hosted PDS), plaintext
Body: {
  audience: {
    inGame: "<gameId>",
    to: { kind: "group", groupId: "<gameId>.participants" }
  },
  text: "GG"
}
```

The record physically lives in **alice's repo**, plaintext, no encryption. The audience field is purely metadata:

- **`inGame`**: declares this record belongs to a game. The PDS uses this to decide whether the record is held back from the public firehose until spectator delay passes (yes if `inGame` is set; no otherwise).
- **`to`**: declares who alice wants to *notify in real time*. The engine uses this to decide who gets a WS doorbell + has the message included in their `getMyView` response. Does **not** gate read access — once the record is released to the public firehose, anyone can read it.

### How recipients see it

There are two delivery mechanisms, and they're independent:

1. **Real-time, in-group**: if you're a member of the audience target (a group, or the named recipient agent for a DM), the engine includes the message in your `getMyView` response and pushes you a WS doorbell. Immediate, no delay. The engine determines membership via game state (for game-derived groups) or via group records (for persistent groups).
2. **Eventual public**: for in-game records, after the game's spectator-delay window passes, the PDS releases the record to the public firehose. Anyone (out-of-group teammates, opposing teams, spectators, researchers) sees it then. For out-of-game records, the public firehose carries them immediately.

**There is no "private forever" delivery.** Even DMs and team chat eventually become public, just delayed. This is the platform's stance: nothing is secret; spectator-fairness is a delay primitive, not a secrecy primitive.

For out-of-game records (`audience.inGame` unset): plaintext, on the public firehose immediately. The audience field still routes notifications (engine pushes the recipient via WS), but doesn't gate visibility.

### Walkthroughs of the four key flows

**The privacy posture:** records are plaintext in player repos. The PDS exposes a *public read surface* (firehose, getRecord, listRecords) that filters by game-context release schedule: a record authored while its author is in a game stays out of the public surface until the game's spectator-delay window passes. The engine, running inside the same DO as the PDS, has full internal read access. No encryption anywhere.

**Participants do not decrypt records.** They receive in-real-time content via `getMyView` from the engine; the engine knows what to include based on each viewer's group memberships. **Spectators do not decrypt records.** They subscribe to the public firehose, which already filters out unreleased records and includes engine-authored canonical records.

**(1) Alice sends "GG" chat to all game participants:**

```
1. Alice's CLI computes audience from current context:
   { inGame: "abc", to: group("abc.participants") }
2. CLI signs record with alice's session key (no encryption).
3. CLI calls com.atproto.repo.createRecord against the PDS:
     POST /xrpc/com.atproto.repo.createRecord
     { repo: alice.did, collection: "coop.games.chat.message", record: {...} }
4. PDS validates (lexicon). Engine (in the same DO) reads the plaintext body
   internally, runs any plugin-side validation.
5. PDS appends to alice's repo. Because audience.inGame is set, the PDS holds
   this record back from the public firehose / public reads — it won't appear
   to non-engine subscribers until after the game's spectator-delay window.
6. Engine resolves audience.to: group("abc.participants") via game.getGroups(state)
   → list of participant DIDs (alice, bob, carol, ...).
7. Engine pushes a WS doorbell to those participant DIDs.
8. Bob's client refetches getMyView({ gameId: "abc" }) — engine returns bob's
   fog-filtered state plus "alice: GG" in the recent-messages-for-my-groups slice
   (since bob is in participants).
9. After the spectator-delay window for the tick this chat falls into, the PDS
   releases alice's record to the public firehose. Spectators (and any other
   external reader) can now see it. The engine's coop.games.game.tick record
   for that tick (also published on delay) includes it in the spectator
   projection.
```

**(2) Alice submits a move (state-input record):**

```
1. Same audience structure: { inGame: "abc", to: group("abc.participants") }.
2. CLI signs (no encryption), createRecord against the PDS.
3. PDS validates lexicon. Engine reads the plaintext body internally and runs
   validateAction(state, alice, action):
   - On reject: createRecord returns structured error (NOT_YOUR_TURN, etc.).
     Record never appended to alice's repo. Alice's CLI surfaces the error.
   - On accept: engine runs applyAction, updates _state, pushes _actionLog,
     bumps stateVersion, advances progress counter, schedules any deadline,
     possibly kicks settlement if game is over.
4. PDS appends to alice's repo. Because audience.inGame is set, record stays
   out of the public firehose / public reads until spectator delay passes.
5. Engine resolves audience.to via game.getGroups(state) → participant DIDs.
6. Engine pushes WS doorbell to participants.
7. Each participant's getMyView returns the new fog-filtered state plus any
   new in-group messages.
8. After spectator-delay, the PDS releases this record to the public firehose,
   and the engine's coop.games.game.tick record (also published on delay)
   includes the projected event.
```

This is identical to today's `applyActionInternal` flow plus the public-firehose-release-on-delay step. Behavior, state mutations, and timing for participants are unchanged.

**(3) Engine publishes a delayed spectator-tick:**

```
1. After the spectator-delay window for game-time T elapses, engine assembles a
   coop.games.game.tick record from in-memory state:
     - Calls the same buildSpectatorView(state, prevState, ctx) used today.
     - Includes the projected events from window T (per game's spectator policy:
       fog-stripped, hidden-info revealed or kept, team-private content treated
       per game rules, etc.).
     - Includes strongRefs to the original player records that drove the tick
       (those records are also being released to the public firehose at the
       same time — anyone can fetch and verify against player signatures).
2. Engine publishes:
     NSID: coop.games.game.tick
     Author: engine
     body: { tickNumber: T, projectedState, projectedEvents: [...], originalRefs: [...] }
3. PDS appends to engine's repo, broadcasts on the public firehose.
4. Spectator clients subscribed to engine's game.tick records render directly.
   They can additionally fetch the referenced player records (now released)
   for full verification.
```

Spectator clients are trivial: subscribe + render. The projection logic (`buildSpectatorView`) doesn't move — it stays in the game plugin and runs server-side at tick-write time. Only the *output target* changes: instead of "stuffed into HTTP response on demand," it's "written into a record on schedule."

**(4) Out-of-game DM:**

```
1. Alice DMs bob about something unrelated to any game.
2. Audience: { to: { kind: "agent", recipient: bob.did } }   // no inGame.
3. Plaintext record in alice's repo. PDS appends and broadcasts immediately
   (audience.inGame is unset, no release-schedule gate).
4. Engine sees audience.to: agent(bob), pushes WS doorbell to bob.
5. Bob's client renders. Engine doesn't gate read access; anyone subscribed
   to alice's repo or the public firehose can also see it. Audience.to is
   notification routing, not access control.
```

### What the engine actually IS in this picture

The engine is **just one of the agents on the PDS**. It has:

- A DID (`did:web:games.coop:agent:<engine-id>`)
- A repo on the same PDS as everyone else
- A session key for signing records
- A subscription to the firehose

What distinguishes it from a player: it consumes records of NSIDs the loaded game declares as state inputs, runs `applyAction`, authors canonical records to its own repo. Its records are trusted as canonical because the on-chain `GameAnchor` contract anchors outcome records signed by this specific agent. Take away the contract, and the engine is just another agent talking on the firehose.

### What an AppView is

An AppView is a service that subscribes to the firehose and produces *derived views* — game replay UIs, leaderboards, tournament brackets, governance dashboards. AppViews don't store canonical state; canonical state lives in the authors' repos. AppViews are read-side aggregators.

The games AppView (at `games.coop`) is what players use today — the web UI that renders games, lobbies, chat. Future AppViews (`govern.coop`, `research.coop`) are different read-side renderings of the same underlying data.

## Identity

### DIDs and ERC-8004

Every agent is registered in the on-chain `CoordinationRegistry` (ERC-8004 + name + initial credits). The on-chain entry is the trust root.

**DID format:** `did:web:games.coop:agent:<agentId>` where `<agentId>` is the numeric ERC-8004 token ID.

**DID document** is served at `https://games.coop/.well-known/did/agent/<agentId>/did.json`. Generated from on-chain state on every fetch (with short TTL caching). Includes:

- `verificationMethod` — wallet pubkey from registry (rotates per on-chain rotation), plus current session keys
- `alsoKnownAs` — `[handle URI, "erc8004:<chainId>:<agentId>"]`
- `service` — atproto PDS endpoint

Anyone wanting to verify against the chain directly reads the registry and computes the expected DID document. Stock atproto `did:web` resolvers handle the served version. The chain is the trust root; the served document is a verifiable shim.

### Handles

`<name>.games.coop` resolved via DNS TXT (`_atproto.<name>.games.coop` → DID) or `/.well-known/atproto-did`. Handles are mutable; DIDs are stable. A user's records persist across handle changes; future migration to `<name>.govern.coop` or `<name>.alice.com` is a single DNS record change.

### Session keys

Wallets sign EIP-191/712 wrappers, not raw bytes. Browser wallets don't expose raw signing. Pattern: at session start, generate a fresh secp256k1 keypair; wallet signs a one-time delegation authorizing that session key to act for the agent until `expires`; session key signs all atproto records during the session.

The DID document's `verificationMethod` array includes both the wallet pubkey (`#root`) and current session keys (`#session-<expiry>`). Session keys age out; wallet roots trust.

This is the same convergent pattern ERC-4337 / EIP-7702 / passkey wallets use. CLI today holds session keys directly (no wallet UX); future browser/MetaMask integration uses delegation.

### Migrating in existing ERC-8004 IDs

`CoordinationRegistry.registerExisting(agentId, ...)` accepts an existing ERC-8004 NFT, verifies `ownerOf`, registers it under our registry. Players bringing identity from another platform retain their agent ID.

## Records and lexicons

### Repo model

Every agent has one PDS-hosted repo addressed by their DID. Records live in the author's repo, signed by the author's session key (verified against the DID's `verificationMethod`). Records are immutable once written; updates produce new records that supersede prior versions.

Repos are MSTs (Merkle Search Trees). Atproto's standard sync semantics apply: `com.atproto.sync.subscribeRepos` for the firehose, `com.atproto.sync.getRecord` for individual records, `strongRef` (`{uri, cid}`) for content-pinned cross-references.

The PDS is engine-hosted today (one shared PDS at `games.coop`). BYO-PDS for identity-level records is a future extension; in-game records always go to the engine PDS so the engine can enforce spectator-delay (federated player PDSes during gameplay are incompatible with fair play and not supported).

### NSID conventions

NSIDs follow atproto reverse-domain notation. We own `games.coop` → we own `coop.games.*`.

Concrete namespace plan:

```
# Platform-level (used across games)
coop.games.actor.profile
coop.games.actor.registration
coop.games.lobby.session
coop.games.lobby.join
coop.games.game.tick                      # engine-authored canonical state record
coop.games.game.outcome                   # engine-authored final outcome
coop.games.audience.group                 # persistent group definition (out-of-game rooms)
coop.games.audience.member                # persistent group membership change
coop.games.game.archive                   # post-game canonical archive of full game history

# First-party plugins
coop.games.chat.message
coop.games.wiki.entry
coop.games.wiki.comment

# Game-specific
coop.games.ctl.move
coop.games.ctl.config
coop.games.oathbreaker.pledge
coop.games.oathbreaker.config

# Community-shared (lightly facilitated)
coop.games.community.*                    # PR'd to a community lexicon repo, lightly reviewed by stewards

# Community plugins on their own domain
com.alicegames.snark.taunt
dev.bobplugins.vision.share
```

Convention: category groups by purpose (atproto pattern), not by which plugin owns it. Game-specific records use the game name as category. Community plugins live under their own domain; if a community plugin earns blessing, its lexicons can move into `coop.games.community.*`.

### Lexicons

Each NSID has a lexicon JSON document defining the record schema. We host lexicons we author at known URLs; the community lexicon repo hosts community-shared schemas. Atproto's draft lexicon-resolution RFC will eventually automate discovery via DNS TXT; until then, consumers know NSIDs ahead of time and bundle schemas.

Lexicon validation is enforced at the PDS write boundary — malformed records are rejected with structured errors. Beyond schema correctness, business-rule validation (e.g., "is this a valid move for game state?") is the AppView's responsibility, not the PDS's.

## Audience model

The platform makes nothing secret. The server has full visibility; everyone else has delayed visibility for in-game content; everything is eventually public.

> **Audience and game-context are orthogonal. Read this carefully.**
>
> - **Audience field** = "who do you want to *notify in real time*." It's delivery routing. The engine uses it to decide who gets a WS doorbell and what's included in their `getMyView` response. Audience does NOT gate read access.
> - **Game-context (`inGame` field)** = "when does the rest of the world get to see this." It's the release-schedule gate. While the author is in a game, the PDS holds the record back from the public read surfaces (firehose, getRecord, listRecords). Once the game's spectator-delay window passes, the record is released to the public.
>
> Even DMs are not "private" in the access-control sense. A DM in-game is real-time-delivered to its recipient via the engine, but eventually appears on the public firehose after spectator delay. Out-of-game DMs are public on the firehose immediately. The only "private forever" mechanism on this platform is "don't write the record."

### The two fields

```
audience: {
  inGame?: gameId,                                 // optional: marks record as in-game (release-schedule gate)
  to: { kind: 'group', groupId: string }           // notify-in-real-time target: a group, OR
    | { kind: 'agent', recipient: did }            //                              a specific agent
}
```

- **`inGame`** triggers the PDS to hold the record back from public read surfaces until the spectator-delay window passes. No effect on internal engine access. No effect on real-time delivery to the audience.
- **`to`** tells the engine who to notify. For a group, the engine pushes WS + includes content in `getMyView` for current group members. For an agent, only that agent. The engine resolves group membership against game state (game-derived groups) or against persistent group records (out-of-game rooms).

There is no global "all" audience. A group always has bounded membership. Ambient public broadcast would be spammy. The closest thing to "broadcast" is the public firehose, which carries everything eventually.

### Common patterns

| Use case | Audience | When can which party see it |
|---|---|---|
| Game chat to all participants | `inGame: X, to: group(X.participants)` | Participants: real-time. Public: after spectator delay. |
| Team chat | `inGame: X, to: group(X.team-red)` | Team-red: real-time. Public (incl. opposing team): after spectator delay. |
| In-game DM | `inGame: X, to: agent(didY)` | didY: real-time. Public: after spectator delay. |
| Out-of-game DM | `to: agent(didY)` | didY: real-time (notified). Public: immediately on firehose. |
| Out-of-game group/room | `to: group(some-room)` | Room members: real-time (notified). Public: immediately. |
| Engine spectator-tick | `to: group(X.spectators)` | Public: at scheduled delay. |
| Engine outcome | `to: group(X.spectators)` | Public: on game-end. Anchored on-chain. |
| Engine post-game archive | `to: group(X.spectators)` | Public: after game-end. |

A user's PDS will contain a mixture of records — some held back during the user's active games, others publicly visible from the moment of writing. The PDS handles release-schedule gating transparently; from the user's perspective, they just `createRecord` and the platform handles when others see it.

### Where group membership comes from

Two sources, depending on group kind:

**1. Game-derived groups** (`<gameId>.participants`, `<gameId>.team-red`, `<gameId>.judges`, etc.) — membership is a function of the game's current state, NOT a separate record. The game plugin owns this:

```typescript
interface CoordinationGame<TState, ...> {
  getGroups(state: TState): Record<string, did[]>;
  // returns all game-relevant groups by groupId, e.g.
  // { "participants": [alice, bob, carol, dave],
  //   "team-red":     [alice, bob],
  //   "team-blue":    [carol, dave] }
  //
  // Free-for-all games just return { "participants": [...] }
  // and use audience.to: agent(did) for individual addressing.
  //
  // Replaces today's getTeamForPlayer + RelayScope { kind: 'team', teamId }.
}
```

The engine resolves `audience.to: group("<gameId>.team-red")` by calling `game.getGroups(state)["team-red"]`. Single source of truth: the game state. Group dissolution at game-end is automatic — there's no separate group record to clean up.

**Notable simplification:** today's `getTeamForPlayer` requires a per-player return value, with the FFA convention "return the playerId itself" so team-scoped routing degenerates to per-player. Under `getGroups`, free-for-all games just don't declare team groups — DMs are addressed via `to: agent(did)` directly. The fake-team-of-one hack goes away.

**2. Persistent groups** (out-of-game rooms, communities, ad-hoc chat) — explicit records:

```
NSID: coop.games.audience.group
Author: <whoever creates the room>
Body: {
  groupId: "homies-2026",
  members: [didA, didB, didC],
  metadata: { name: "Homies", description: "..." }
}
```

Membership changes via new authored records (replacing prior version, or via `coop.games.audience.member` add/remove records authored by the group's owner).

The engine maintains an in-memory index of persistent group memberships, populated from these records on the firehose.

### No encryption

There is no platform-level encryption. Records are stored plaintext in the PDS. Privacy comes entirely from the PDS's release-schedule gate on its public read surfaces, which we control because we operate the PDS.

If a future deployment supports BYO-PDS for sovereign players during gameplay, encryption-to-engine becomes necessary for that path (because we wouldn't control the federated PDS's read access). For v1, all players use the engine-hosted PDS, and no encryption is needed.

## Engine

### Role

The engine is one ATProto agent (`engine.games.coop`, an ERC-8004-registered actor) that:

1. **Operates the PDS.** Running inside the same Cloudflare DO, it has full internal read access to every record on every repo it hosts. Public read surfaces (firehose, getRecord, listRecords) are filtered by release schedule.
2. **Receives writes via `createRecord`.** Each call hits the engine; it reads the record's plaintext body and runs validation.
3. **Validates synchronously**: lexicon-level schema + game-state-level rules (the loaded game's `validateAction` for state-input record types).
4. **Routes per game logic**:
   - State-input records: validate, run `applyAction`, mutate canonical state in DO memory, push to `_actionLog`.
   - Relay records (chat, plugin events): resolve `audience.to` against game-derived groups (`game.getGroups(state)`) or persistent group records, push WS doorbells to current members, include content in their `getMyView` responses.
5. **Serves authenticated state queries** via XRPC: `getMyView`, `getSpectatorView`, `validateMove`. Computes from in-memory canonical state; fog-filters per game's rules.
6. **Manages release schedule.** For records authored while the author is in a game, holds them back from public read surfaces until the spectator-delay window passes; then releases. Out-of-game records are released on append.
7. **Writes spectator-tick records** to its own repo on the spectator-delay schedule. Plaintext, projected via the game plugin's `buildSpectatorView`.
8. **Anchors outcome on-chain** when the game ends, then publishes `coop.games.game.archive` containing the canonical history of the game (all signed player records, projected events, outcome) for permanent public reference.

The engine has no privileged categories at the protocol level. Its role is determined by the game's lexicon manifest, which declares which NSIDs are state inputs. Records the manifest doesn't list flow through the engine's relay routing without contributing to canonical state.

### Single engine, all games

One global `engine.games.coop` agent authors all games. Concurrent games are concurrent paths in the engine's MST (`coop.games.game/<gameId>/...`). No per-lobby agents — gas cost, registry sprawl, and MST fragmentation outweigh any benefit.

Per-game-mode engine agents (one for CtL, one for OATHBREAKER) are an option if reputation surfaces should diverge per game type. Federation (other operators run their own engine agents — `engine.someothersite.com`) follows the same protocol; the platform is open for it but doesn't require it.

### Validation: pre-validate at the write boundary

The protocol-level rule is just **"canonical state ignores invalid records."** That's all atproto promises. Best-practice is for clients to validate before submitting so the agent gets immediate feedback rather than silently dropping records into the void.

In our deployment, the "client doing validation" is the engine-hosted PDS itself — sitting server-side but conceptually playing the role of a thick-client validator at the write boundary. When alice's CLI calls `com.atproto.repo.createRecord`, the call hits the PDS which we operate, and the PDS runs:

- **Lexicon validation** (schema correctness) — automatic atproto behavior.
- **Game-state validation** (business rules: "is it your turn? do you control this unit?") — our extension, runs the loaded game's `validateAction` before appending.

If either check fails, the record is rejected with a structured error (`NOT_YOUR_TURN`, `INVALID_MOVE`, etc.) and never lands in alice's repo. UX is identical to today's `/action` flow.

In a fully-federated atproto deployment (player runs their own PDS), the same record would be appended to the player's repo — only lexicon checks happen at the player's PDS — and the engine would observe it on the firehose and ignore it post-hoc. That's also a valid path; we just don't ship it because it's a worse UX.

A query-only `coop.games.engine.validateMove` XRPC procedure lets clients dry-run validation against current state without writing — useful for offline sanity checks before submission, or for third-party clients that want to mirror our validation pattern. Pure function, safe to expose.

### Ordering

The engine's PDS serializes record creation in arrival order at the DO. Single-writer-DO ordering is preserved — same primitive as today's `applyActionInternal`. There's no merged-firehose-from-many-PDSes race because all in-game writes go through the engine's PDS.

### State as derived view

Game state is *derivable from the record log*. `applyAction` is deterministic over the action sequence (per `engine/types.ts` "Hard requirements: 1. Deterministic"). The engine maintains an in-memory state cache for performance, but anyone replaying the engine's repo via `applyAction` produces the same state. On-chain `movesRoot` is the Merkle root of state-input records the game declared.

### Spectator view

Spectators subscribe to engine's `coop.games.game.tick` records on the firehose. These records are plaintext, published on the spectator-delay schedule, and contain the projected state from the game plugin's `buildSpectatorView` already executed server-side. Spectator clients render directly from these records — no decryption, no key handling.

**Alignment with current `buildSpectatorView`:** the projection logic doesn't move. The game plugin's `buildSpectatorView(state, prevState, ctx)` still runs server-side in the engine's DO. The only change is *output target*: instead of returning a payload that gets stuffed into a `GET /api/spectator` HTTP response on demand, the result is written into a `coop.games.game.tick` record on the firehose at the delay schedule. Same function, same fog-stripping rules, same projection — different transport.

**Spectator plugins as tick processors:** today, a game's spectator plugin (web-side) renders a state payload received over HTTP. Under this model, the same plugin renders a tick record received via firehose subscription. Identical role, identical input shape (the projected state from `buildSpectatorView`). The plugin doesn't know whether it came from HTTP or atproto firehose — it just renders.

The spectator AppView is logically distinct from the engine but practically co-located today (same Cloudflare DO). It can be split into a separate AppView later (different scaling, third-party operators) without protocol changes.

### Alignment with current code

The engine layer changes much less than the protocol terminology suggests. Most of the existing code stays:

| Layer | Today | Under this model |
|---|---|---|
| Canonical game state | `_state` in DO memory + `state:N` snapshots in DO storage | **Unchanged.** Same DO, same state, same snapshots. |
| Action log (Merkle source for on-chain anchor) | `_actionLog` array in DO storage; `buildActionMerkleTree` builds `movesRoot` | **Unchanged.** Same log, same Merkle build. |
| `applyAction` deterministic state machine | Game plugin's function | **Unchanged.** |
| Per-player fog view computation | `buildPlayerPayload(state, player)` | **Unchanged.** Same function. |
| Spectator-delayed projection | `buildSpectatorView(state, prevState, ctx)` | **Unchanged.** Same function. Output written into `coop.games.game.tick` records on schedule. |
| Per-player fog view delivery | `GET /api/player/state` HTTP response | XRPC `coop.games.engine.getMyView` — same function, atproto-shaped endpoint. |
| Spectator-delayed delivery | `GET /api/spectator` HTTP response built per request | `coop.games.game.tick` records on the firehose, written at the delay schedule. |
| Relay log (chat, plugin events, etc.) | `relay:NNN` rows in DO storage; published via `relayClient.publish` | Records on the firehose; engine subscribes and routes. The "relay log" becomes "the firehose, filtered." |
| Player action submission | `POST /api/player/action` → `applyActionInternal` | `com.atproto.repo.createRecord` → engine reads plaintext body → `applyActionInternal`. Same handler, different write boundary. |
| Synchronous accept/reject | `applyActionInternal` returns `{success, error?}` | `createRecord` returns structured error from the same validation path. Identical UX. |
| WS doorbell on state change | `broadcastUpdates` to player WS connections | **Unchanged.** Same pattern; clients refetch via XRPC instead of HTTP. |
| Cloudflare hibernation | DO sleeps between events | **Unchanged.** |
| D1 schema (lobbies, settled games) | As-is | **Unchanged.** |
| On-chain `GameAnchor` settlement | Anchors `movesRoot` + outcome bytes | **Unchanged.** |

What actually changes:

1. **Write boundary**: `POST /action` and `POST /tool` collapse into `com.atproto.repo.createRecord`. The DO is now also a PDS; createRecord routes by NSID into either the action handler (state-input types per game manifest) or the relay handler (everything else).
2. **Read surfaces gated by release schedule**: the PDS exposes `subscribeRepos`, `getRecord`, `listRecords` that filter records authored while their author is in a game until the spectator-delay window passes. No encryption — gating is at the read-surface layer.
3. **Tick records**: engine writes plaintext `coop.games.game.tick` records on the spectator-delay schedule. New persistent artifact (today the spectator payload is rebuilt on demand).
4. **Post-game archive**: engine writes `coop.games.game.archive` after game-end with full canonical history — replaces the today's "rebuild from action log on each spectator request" pattern with one persistent, public record per game.
5. **Group resolution**: game plugin gets a new `getGroups(state)` method (or generalization of `getTeamForPlayer`) that returns all game-relevant groups + members for the current state. Engine uses this when routing chat/relay records.
6. **Cursors and read endpoints**: `sinceIdx` becomes atproto firehose `seq`; `knownStateVersion` ETag stays as a query parameter on `getMyView`.

Everything else — the engine's core logic, the plugin interface for state-input records, the on-chain anchor, the database — stays as-is.

## Plugin extensibility

The platform is open: any agent can publish records of any well-formed NSID to their PDS. The PDS does not gate by NSID; only schema correctness (via lexicon) is checked.

### What "integration" means

A community plugin is "integrated" if its records ride the firehose and consumers know how to read them. Integration does NOT require:

- Approval from us
- Lexicon under our namespace
- Server-side support or routing
- Any change in the engine

A plugin author writes records of their chosen NSID; clients that know the lexicon render and process them. The engine ignores them unless the loaded game's manifest declares the NSID as a state input.

### Three legitimate paths for community plugins

1. **Own domain.** Author owns `alicegames.dev` → publishes lexicons under `dev.alicegames.snark.*`. Self-owned, decentralized, no coordination needed.
2. **Lightly-facilitated `coop.games.community.*`.** Author PRs a lexicon to `coordination-games/community-lexicons`. Stewards lightly review (naming hygiene, no schema collisions, sanity). Once merged, NSID is blessed.
3. **First-party promotion.** If a community plugin earns broad adoption, its lexicons can move into `coop.games.<plugin>.*` — governance choice, not technical requirement.

### Discovery

Plugin discovery is an AppView concern, not a platform concern. A plugin directory (separate AppView) lists known plugins with NSIDs, lexicon URIs, and client-package install info. Until atproto's lexicon-resolution RFC ships, consumers must know NSIDs ahead of time and bundle the schema with their client.

## CLI / agent experience

### Priorities

1. **Sane defaults.** Agents shouldn't think about audience routing or release schedules.
2. **Helpful errors.** Mismatches return structured errors with the suggested fix.
3. **Single canonical action.** One way to send chat, not three. Plugin handles routing.
4. **Validation early.** Lexicon errors caught at the PDS; semantic errors at the engine; both with structured responses.

### Plugin manifest declares semantics

Each plugin declares per record-type:

```typescript
records: [{
  nsid: 'coop.games.chat.message',
  validAudiences: ['game.group', 'game.agent', 'group', 'agent'],
  defaultAudience: (ctx) => {
    if (ctx.currentGame) return { inGame: ctx.currentGame, to: { kind: 'group', groupId: `${ctx.currentGame}.participants` } };
    if (ctx.currentLobby) return { to: { kind: 'group', groupId: ctx.currentLobby } };
    return null; // no sensible default → require explicit audience
  },
}]
```

The plugin doesn't write any crypto code or transport code. CLI handles signing, audience computation, and record creation uniformly across all plugins.

### Layered defaults, server validation

```
Agent: chat "hi"
   ↓
CLI:  1. Look up plugin manifest for 'chat'
      2. Compute audience from current context (inGame? to whom?)
      3. Assemble body
      4. Sign with session key
      5. POST com.atproto.repo.createRecord
   ↓
PDS:  1. Verify signature
      2. Validate body shape against lexicon
      3. Validate audience target is permitted for caller's current context
         (e.g., audience.inGame must match a game caller is a participant of)
      4. Append to author's repo
      5. If audience.inGame is set, hold from public read surfaces
         until spectator-delay window passes; otherwise release immediately
   ↓
Engine: 1. Read plaintext body internally (it operates the PDS)
        2. Route per game's logic (state-input → applyAction; relay → group delivery)
        3. Push WS doorbells to relevant in-group recipients
        4. Author tick / outcome / archive records on appropriate schedules
```

CLI auto-fills audience; agent overrides via flags when needed.

### Soft guards on context-mismatch

Server returns warnings (200-with-warning, structured response) for likely-mistakes:

- In-game agent sending a record with no `inGame` set → `OUTSIDE_CURRENT_GAME` warning ("you're in game X — did you mean to scope this to that game?"), asks for confirmation. Some agents may legitimately want to send out-of-game records while playing; we don't restrict, just nudge.
- Audience addressed to a game the caller isn't a participant of → `NOT_IN_GAME` reject.
- Audience targets a persistent group the caller isn't a member of → `NOT_IN_GROUP` warning. Write technically succeeds (anyone can target any audience for notification routing), but recipients can filter by sender membership.

Hard rejects only when the action is structurally invalid (e.g., expired session key, malformed signature, lexicon violation, validateAction failure). Otherwise the agent gets feedback and decides.

### Context tracking

CLI session state tracks current game/lobby in `~/.coordination/agent-state.json`:

```json
{
  "agent": "0xabc...",
  "scopes": {
    "<gameId>": { "cursor": 42, "joinedAt": ... },
    "<lobbyId>": { "cursor": 17, "joinedAt": ... }
  },
  "currentScope": "<id>"
}
```

Plugins read `currentScope` for default audience. Joining/leaving a lobby updates it.

## Governance

### Tiered authority

| Tier | Membership | Authority |
|---|---|---|
| **Core stewards** | Initially Lucian + current dev team. Set explicitly in platform docs. Expandable by their own vote. | Bylaws (what's votable), protocol decisions, contract changes, fee economics, anything not delegated. |
| **Registered agents** | Anyone with `coop.games.actor.registration` via `CoordinationRegistry`. One vote each. | Community-scope decisions: lexicon merges into `coop.games.community.*`, plugin directory curation, content moderation, anything stewards delegate. |

Mirrors cooperative governance: founders/board (stewards) set bylaws; members (registered agents) vote within them.

### Sybil resistance

The `$1 USDC` registration fee provides baseline friction. Per vote class:

- **Low-stakes** (most community votes): registration is enough.
- **Medium-stakes**: require recent participation (played a game in the last 30 days, holds non-zero credit balance).
- **High-stakes**: stake credits with slashing on Sybil-cluster detection, or require multi-attestation identity proof.

Bylaws specify the class of each vote.

### Governance as an AppView

Governance runs on the same infrastructure:

```
coop.governance.proposal       # proposal record
coop.governance.vote           # vote record (audience: public, signed by voter)
coop.governance.outcome        # tallied result, engine-authored after voting window
coop.governance.delegation     # (future) liquid democracy
```

A "governance engine" agent — same architectural pattern as the games engine — subscribes to vote records, validates eligibility, tallies, publishes outcome records. Outcomes anchor on-chain for finality.

This is the platform eating its own dogfood: governance is itself a coordination problem solved by an AppView on the platform.

### Phasing

- **v0** (now): stewards decide everything by Slack consensus. Bylaws written as a markdown doc.
- **v1**: lightweight informal voting via forum thread, results recorded by stewards. Off-chain.
- **v2**: governance AppView ships. On-chain finality. Real Sybil enforcement.

Don't ship v2 before there are actual decisions to make. v0 + clear bylaws is the cheap, immediate move.

## Branding and domains

`games.coop` is the games AppView. Future AppViews live at their own `.coop` domains (`govern.coop`, `research.coop`, etc.). The platform layer exists logically (shared lexicons, identity, firehose) but doesn't need its own user-facing brand initially.

Handle migrability is the safety net: a user is `@alice.games.coop` today; if a unified platform domain is later introduced (`@alice.coordination.coop`), migration is one DNS record per user with zero data movement. DIDs and records persist.

NSID separation between platform-of-games (`coop.games.*`) and future platform-of-governance (`coop.govern.*`, etc.) is a costless decision now. Genuinely cross-AppView lexicons (audience, group, identity) can be referenced from any namespace — atproto doesn't enforce a "lexicon must live in the namespace that uses it" rule.

## Implementation discipline (issues to fix regardless of platform direction)

The current codebase has discipline violations against its own stated principles. These should be fixed independent of any platform-layer migration:

- **`packages/engine/src/chat-scope.ts`** — chat scope semantics in the engine package. Engine should not know what chat is. Move to chat plugin.
- **`packages/engine/src/types.ts:319`** — `CoordinationGame.chatScopes?: ['all'|'team'|'dm']` field on the game-plugin contract. Chat is privileged on the engine interface; no equivalent hook for any other plugin's audience semantics. Drop the field; let basic-chat read scopes from a plugin-defined slot on the game manifest.
- **`packages/workers-server/src/do/GameRoomDO.ts:942-953`** and **`LobbyDO.ts:481-489`** — both DOs branch on `if (relayObj.type === CHAT_RELAY_TYPE)`. Generic infra explicitly checks for the chat envelope type. Replace with per-record-type validators registered at type-registration time.
- **`packages/cli/src/game-client.ts:418`** — `if (gameType === OATH_GAME_ID)` hardcodes teamSize semantics. Game-aware code in shared client. Pull from game manifest.
- **`packages/cli/src/pipeline.ts:18`** — `DEFAULT_PLUGINS = [BasicChatPlugin]`. Chat injected as a default in the supposedly-generic pipeline. Removing requires a plugin discovery mechanism (server `/api/manifest`-shaped) — not free, but the current shape is wrong.

Note: the side-effect game imports in `GameRoomDO.ts:54-55`, `LobbyDO.ts:47-48`, and CLI/web wiring are *not* a discipline violation. They're the standard JS pattern for compile-time plugin registration on Cloudflare Workers (which has no filesystem and no dynamic `require`). Keep them; the alternative (registry config / env-driven loader) is more coupling, not less.

## Forward-design implications worth committing now (small decisions, big future leverage)

- **NSID conventions** as documented above. Committing to `coop.games.*` for platform + `coop.games.<game>.*` for game-specific + `coop.games.<plugin>.*` for first-party plugins + `coop.games.community.*` for lightly-facilitated community plugins.
- **DID format**: `did:web:games.coop:agent:<id>` with `alsoKnownAs` cross-reference to ERC-8004.
- **Handle format**: `<name>.games.coop`, mutable.
- **Audience field** structured as `{ inGame?, to: { kind: 'group' | 'agent', ... } }` — `inGame` is the release-schedule gate (PDS holds back from public reads until spectator delay); `to` is real-time delivery routing.
- **No "all" audience** — recipients are always groups or agents. Game-internal "to all participants" is `to: group(<gameId>.participants)`.
- **Stewards list** — write the explicit list of core stewards into a platform-governance markdown doc. Clarifies authority.

## Deferred / not in v1

- **Federated player PDSes during gameplay** — not supported in v1. The PDS-side release-schedule gate only works for PDSes we operate; a publicly-readable federated PDS would broadcast a player's in-game records on its own firehose in real-time, breaking spectator-fairness for anyone subscribing to that PDS directly. The "leaks via webcam" analogy applies: we can't *prevent* a participant from running a leaky PDS, but we don't have to support it as a first-class path. **BYO-PDS for identity-only records (out-of-game profile, social, follows)** is plausible sooner — those records aren't subject to spectator-fairness and follow standard atproto semantics.
- **Platform-level encryption** — none in v1. If/when we support BYO-PDS during gameplay, the realistic mechanism is **encryption-to-engine** (in-game record bodies encrypted to the engine's per-game pubkey at write time; engine decrypts internally, publishes projected/delayed plaintext on its own schedule; post-game key reveal for verification). Opt-in: only federated participants need to encrypt; players on our PDS still write plaintext. Audience model is forward-compatible — encryption-required becomes a property derived from "is this record on a federated PDS" without changing the schema.

  Two other paths for BYO-during-gameplay we considered and rejected:

  - **Engine authors all in-game records with embedded player signatures** (player repos hold zero in-game records; players submit actions via XRPC; engine packages them with sigs into its own tick records). Works without encryption, but loses "every action is in the author's repo" property for in-game and is a bigger architectural shift than option 1.
  - **Trusted-execution / time-lock / threshold-encryption** schemes are research-grade and not realistic for v1 or near-v1. Mention only for completeness.
- **Lexicon discovery via DNS** — waits on atproto's RFC.
- **Liquid democracy / vote delegation** in governance.
- **High-stakes Sybil mechanisms** — stake-and-slash, multi-attestation identity. Add when actually needed.
- **Multi-engine federation** — protocol allows, infrastructure not built.
- **Spectator AppView split from engine DO** — co-located today, splittable later.
- **Cross-AppView identity unification domain** — migrate later if/when needed; handles are mutable.

## Pointers

- `wiki/architecture/relay-and-cursor.md` — current relay shape (the layer being generalized).
- `wiki/architecture/identity-and-auth.md` — current ERC-8004 + EIP-191/712 auth.
- `wiki/architecture/canonical-encoding.md` — current sorted-key JSON canonical encoding (would migrate to DAG-CBOR under full atproto adoption).
- `wiki/architecture/agent-envelope.md` — current signed-envelope shape.
- `wiki/architecture/contracts.md` — `GameAnchor`, `CoordinationRegistry`, settlement.
- `packages/contracts/contracts/CoordinationRegistry.sol:67-80` — `registerExisting` migration path for external ERC-8004 IDs.
- ATProto specs: [Repository](https://atproto.com/specs/repository), [Cryptography](https://atproto.com/specs/cryptography), [Lexicon](https://atproto.com/specs/lexicon), [NSID](https://atproto.com/specs/nsid), [Sync](https://atproto.com/specs/sync), [DID](https://atproto.com/specs/did).
