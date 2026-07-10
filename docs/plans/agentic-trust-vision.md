# Agentic Trust — Vision

**Status:** Design, partly implemented (per `agentic-trust-followup.md` + `djimo-pr37-cleanup.md`)
**Supersedes:** `trust-plugins.md` (the older EAS-on-chain-first design)

The destination, in ~150 lines. No PR sequencing here — this is the mental model. For the implementation roadmap see `agentic-trust-followup.md`. For Djimo's PR #37 handoff see `djimo-pr37-cleanup.md`.

---

## What we're building

Persistent, cross-game agent reputation. Three kinds of producers (the game itself, plugins, and agents) emit attestations about each other; projector plugins turn those attestations into compact `TrustCardV1` views that show up in agent state and in spectator UI. Reputation persists across games, keyed to the agent's ERC-8004 identity, so a player walks into a new game already carrying their record.

The bet: **let agents attest about each other, and let them sort out the truth via market mechanisms over time.** System-emitted attestations (game-derived facts: "agent X cooperated in round 3") are reliable but narrow. Agent-emitted attestations are messy but expressive. Both flow through the same primitive; the projector decides how to weight them.

---

## The three primitives

All in `packages/engine/src/types.ts`.

**`AttestationV1`** — the raw atom. Anyone can emit one. Carries `subject` (the agentId being attested about), `issuer`, `issuerKind` (`'agent' | 'system' | 'plugin'`), a `claim` with discriminated `type` + `data`, optional `note` (≤200 chars), `confidence`, `round`, `issuedAt`, optional `evidenceRefs`.

**`TrustCardV1`** — the projection. Compact, evidence-first card meant for agent prompts and UI. Already exists in the codebase (Djimo's PR #37). Holds an array of `TrustSignalV1`s — labelled stance summaries with optional confidence and pointers back to evidence.

**`TrustEvidenceRefV1`** — the pointer. Bounded reference to evidence the viewer is already allowed to know about (a relay envelope index, a round number, a public artifact). Lets cards cite their sources without embedding raw chats or hidden state.

**Layer relationship:** attestations are inputs, cards are outputs. Cards are derived from attestations + game state by projector plugins.

---

## Identity: ERC-8004 agentId is canonical

Every attestation is keyed on `subject: AgentId` (the on-chain ERC-8004 ID). Wallets are an attribute of the agent, not the identity. An agent can rotate wallets; their reputation follows the agentId.

Internal `playerId` is currently 1:1 with `agentId` (one agent = one player slot). They'll be unified under `agentId` in a follow-up rename PR. At persistence boundaries we always use `agentId`.

Bots are real registered agents — they sign with the wallet that owns their 8004 ID, same as humans. No synthetic-ID pollution path.

---

## Three producers, one transport — all server-side

| Producer | Mechanism | Example |
|---|---|---|
| **Game (system)** | `applyAction` returns `relayMessages: [attestation envelope]` (server-side, in `GameRoomDO`) | OB breach handler emits `{claim: 'oathbreaker.commitment_breached', data: {...}}` as a side effect of slashing |
| **Plugin** | Plugin's server-side handler publishes via `RelayClient.send` (in the workers-server pipeline) | Hypothetical anti-cheat plugin observes impossible move, emits `{claim: 'cheat.suspected', ...}` |
| **Agent** | `attest` MCP/CLI tool routes through `plugin-trust-attestations` (server-side `handleCall`) | Agent calls `attest({subject, claim: 'peer.assessment', data: {tag: 'reliable'}, note: '...'})` |

**Emission is always server-side.** The agent's CLI/MCP call lands at workers-server, the plugin's server-side handler validates and publishes. The agent UI never holds the relay token. One emission boundary, one validation point.

All three publish a relay envelope of `type: 'attestation'`. They share the same scope semantics (always `'all'`), the same delay machinery, the same inspector visibility, the same cursor-based delta semantics.

---

## Scope: always `'all'`

Within-game fog-of-war (player A's covert action shouldn't be visible to player B yet) is handled by **delaying emission**, not by scoping the envelope. The game holds the attestation until the act is publicly visible, then emits it.

Spectator delay (existing, progress-based) handles the human-watching side: spectators see all envelopes including DMs and team chats, scope-tagged for visual marking, behind the standard delay.

Result: attestation envelopes are always public. Schema enforces it (`scope.kind === 'all'` refined on the Zod schema).

---

## Storage: D1, keyed by agentId

Attestations are written to a D1 table keyed by `subject_agent_id`. Same call path that publishes to the relay also INSERTs to D1 — one write, two destinations. PRIMARY KEY is the content hash, so it's idempotent.

At game start, `GameRoomDO` queries D1 for participating agents' prior attestations and hands them to projector plugins as a separate input stream alongside live attestations. The projector decides how to weight historical vs live evidence.

D1 is the canonical store. IPFS/on-chain is layered on top *if* and *when* we want verifiability, not as a primary mechanism.

---

## Consumers: projector plugins (multiple, stackable)

A projector consumes the attestation stream and produces a typed projection. The default projection is `TrustCardV1`s, but the pattern is extensible — different games can ship different projectors, multiple projectors can coexist and produce different kinds of views.

The projector pattern uses the existing `ToolPlugin.modes[].consumes/provides` topology:

```ts
{
  id: 'trust-projector-tragedy',
  modes: [{ name: 'project', consumes: ['attestations'], provides: ['trust-cards'] }],
  agentEnvelopeKeys: { 'trust-cards': 'trustCards' },
  handleData(_, inputs) {
    const atts = inputs.get('attestations') as AttestationV1[];
    return new Map([['trust-cards', buildCards(atts)]]);
  },
}
```

Examples of projectors that could coexist:
- `trust-projector-default` — generic, claim-type-agnostic. Groups attestations by subject, builds one signal per claim-type cluster.
- `trust-projector-tragedy` — knows TOTC mechanics (harvest, regions, influence), produces TOTC-shaped cards.
- `trust-projector-oathbreaker` — knows OB mechanics, produces cooperation-rate signals.
- `trust-graph-projector` — builds a graph view (cooperation/reliability spectrum) instead of cards.
- `trust-evidence-archiver` — Djimo's IPFS publisher, generalised to any game. Gated off by default.

A game opts in via `recommendedPlugins`. Projector receives only attestations the **viewer** is allowed to see (engine filters by relay scope), so cards are naturally viewer-aware.

---

## Games can emit and read attestations directly

**Emitting:** the simplest pattern is the game emits an attestation as a side effect of processing the action that caused it. OB's breach handler:

```ts
case 'breach_commitment': {
  const newState = slashOathbreaker(state, action.player);
  return {
    state: newState,
    relayMessages: [{
      type: 'attestation',
      scope: { kind: 'all' },
      body: {
        issuer: 'system:oathbreaker',
        issuerKind: 'system',
        subject: action.player,
        claim: { type: 'oathbreaker.commitment_breached', data: {...} },
        // ...
      },
    }],
  };
}
```

State change + attestation emission, atomically, in the action handler. No event-loop indirection, no "plugin emits action" pipe (that pipe doesn't exist in the engine and we don't add one).

**Reading:** games can read attestations if they want, two clean patterns:

- **At game init.** `GameRoomDO` queries D1 for participating agents' historical attestations and passes them to `game.init(players, settings, history)`. Game seeds state however it wants — e.g. "this player has 3 prior breach attestations, start them with a stewardship penalty." Pure read at init.
- **Within a round.** If a game wants to react to in-game attestations (e.g. an agent attestation triggers some game logic), it receives them as input alongside actions. Concretely: `applyAction(state, action, ctx)` where `ctx.recentAttestations` includes attestations emitted since the last action. Game inspects them, decides if anything matters.

Both patterns keep the engine simple. The game owns its own integration; no plugin-emits-action mechanism is required.

The default for most games is "emit, don't read" — projector plugins handle the consumer side. Games only opt into reading when the mechanic genuinely needs it (like a reputation-aware difficulty tweak at init).

---

## What the agent sees

Through `agentEnvelopeKeys` (the existing pattern Djimo's PR uses), the projector adds `state.trustCards: TrustCardV1[]` to the agent's payload. Optionally also `state.recentAttestations: AttestationV1[]` (last N viewer-visible) so agents see raw peer claims, not just the projected summary — the difference between "this player has a 'freeloader' tag" and "alpha called this player a freeloader; gamma called them reliable; you decide."

For OB UI specifically: each `TrustCardV1` carries two signal blocks — system-derived (cooperation rate from `oathbreaker.choice` attestations) and agent-derived (most recent peer notes verbatim, with attribution).

---

## What this enables

**Cross-game persistence:** new agent walks into OB → cards already populated from past tragedy games. "Cooperated 47/60 rounds across 12 games, 3 peer accolades, 1 freeloader flag."

**Different games get different trust UX:** TOTC's projector knows about resources and regions; OB's projector knows about C/D ratios. Same primitive feeds both.

**Agents can call each other out:** an agent that detects another agent gaming the system can issue an attestation. Whether anyone weights that attestation depends on the issuing agent's own reputation (stewardship-scaled decay is a deferred design knob).

**Verification later, durability now:** D1 gives us reputation that survives across games. IPFS/on-chain is a verifiability story we can layer on when schemas are stable and there's actual demand for "challenge this attestation isn't in the canonical record."

**Pluggable trust UX:** a game ships with one projector; a power-user spectator interface could load three. The projector layer is where experimentation happens, not the primitive layer.

---

## What's deferred

These were explored in design conversations and consciously punted:

- **On-chain anchoring.** Djimo's IPFS publisher ships gated off. Revisit when D1 reputation has soaked.
- **Time-decay parameters** for historical attestation weighting. Land naive uniform decay first, tune with real data. (Stewardship-scaled decay where reliable issuers' attestations decay slower is a likely improvement.)
- **Sybil resistance / pile-on dampening.** Land naive count-all first. Add diminishing-returns weighting if abuse appears.
- **Attestation revocation.** Currently immutable. If we need it, a `'supersedes'` claim type pointing at the prior attestation is the planned mechanism.
- **Lobby-level reputation lookup** (showing agent rep before they join a game). Useful but not v1.
- **Cross-coalition Community-Notes-style approval.** Considered for ideological capture resistance; our disputes are largely factual, so probably overkill.

---

## Why this shape

- **One primitive, three producers** keeps the data model uniform. Adding a new producer (a referee plugin, a moderator agent, an anti-cheat detector) doesn't add a new envelope type — it just emits attestations with a new claim type.
- **Projectors as plugins** means trust UX is composable and game-specific. We don't bake "what reputation looks like" into the engine.
- **D1 first, on-chain later** trades verifiability for shipping speed, which is correct in this phase. We have web3 enough to defend the eventual on-chain claim; we don't need the round-trip yet.
- **Agent attestations as first-class citizens** is the bet that makes this "agentic trust" rather than "system audit logs." Agents are noisy. The projector layer makes the noise legible.

The architecture is intentionally permissive at the producer end and selective at the consumer end. Anyone can emit; projectors decide what to amplify.
