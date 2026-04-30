# PR #37 Cleanup Spec — Agentic Trust + TOTC

**Audience:** Djimo (PR #37 author)
**Status:** Draft, sent for alignment
**Authors:** Lucian, Borg
**Context:** see `agentic-trust-vision.md` for where this is heading (the destination, no PR sequencing). See `agentic-trust-followup.md` for what we land on top of your PR after it merges.

This doc is the agreed delta from PR #37's current state to a state we can merge. Nothing here is a critique of the design — your trust primitives and the TOTC integration are landing largely as you wrote them. The asks below are about (a) detaching the PR from your sibling repo, (b) slotting the trust pipeline into our plugin architecture, and (c) one engine-level fix that's our problem, not yours.

---

## What we're keeping from PR #37 as-is

- **Trust primitive types** (`TrustEvidenceRefV1`, `TrustSignalV1`, `TrustCardV1` in `engine/src/types.ts`) — shape is exactly right, no changes requested.
- **Reasoning plugin** (`@coordination-games/plugin-reasoning`) — clean, generic, lands as-is.
- **TOTC game logic** — game.ts, plugin.ts, types.ts, tests.
- **TOTC web view** — `OriginalObservatory.tsx` and the components in `web/src/components/games/tragedy/` — keep the wholesale port from your prototype.
- **Inspector diagnostics page, NeuralSwarm hero, HomePage rewrite, local model harness scripts** — all stay. One PR is fine.
- **IPFS / on-chain publisher** (`trust-publisher.ts`) — keep the code, keep it gated behind `TRUST_IPFS_PUBLISH_ENABLED` (already is). We'll revisit when D1 reputation is stable. **No on-chain writes, no IPFS uploads in default config.**

---

## What needs to change

### 1. Drop the `@agentic-trust/*` external deps

**Problem:** `workers-server/package.json` pins `@agentic-trust/cg-adapter` and `@agentic-trust/core` as `file:../../../agentic-trust/packages/...`. That repo isn't in our monorepo and isn't on npm — CI fails on `npm install` and contributors can't build.

**Fix:** vendor both into this repo.

#### 1a. Vendor `@agentic-trust/core` helpers

Copy `canonicalizeJson` and `keccak256CanonicalJson` into a new file:

```
packages/engine/src/canonical-encoding.ts
```

Tiny, framework-agnostic — exports two functions, used by `trust-publisher.ts`. Update imports in `trust-publisher.ts` accordingly. Drop `@agentic-trust/core` from `workers-server/package.json`.

#### 1b. Vendor `@agentic-trust/cg-adapter` reducer as a plugin

Currently `trust-cards.ts` calls `createTragedyVisibleTrust` from the external repo. That reducer (tragedy player counters → `TrustCardV1`) becomes a first-class plugin in this repo:

```
packages/plugins/trust-projector-tragedy/
  package.json
  src/
    index.ts           # ToolPlugin export
    reducer.ts         # the createTragedyVisibleTrust logic, copy-pasted
    types.ts
```

See §3 for the plugin's exact `ToolPlugin` shape.

Drop `@agentic-trust/cg-adapter` from `workers-server/package.json`.

---

### 2. Move trust-card derivation out of `GameRoomDO` (THE ONE RULE)

**Problem:** `GameRoomDO.getVisibleState` and `getSpectatorPayload` post-process state through `withVisibleTrustCards()` (`trust-cards.ts`). This makes trust card injection a server-only feature — the CLI path (`coga state`) doesn't see trust cards. That violates `CLAUDE.md`'s ONE RULE: every agent-facing feature must work identically through CLI and MCP.

**Fix:** trust cards must come from a plugin in the standard pipeline, not from a `GameRoomDO` post-processor.

Concretely:

- Delete `withVisibleTrustCards` from `GameRoomDO.ts`.
- Delete its call sites at `:1481` (getVisibleState) and `:1569` (getSpectatorPayload).
- The new `trust-projector-tragedy` plugin produces `trustCards` via the existing pipeline, declared on the plugin via `agentEnvelopeKeys` (see §3).

End state: `coga state` and the MCP/HTTP `/state` endpoint both return `state.trustCards` from the same plugin output, identically.

---

### 3. Add the `AttestationV1` primitive + producer→consumer pipeline

This is where TOTC's trust derivation gets restructured to flow through the engine's plugin pipeline. Game emits attestations, plugin consumes them, plugin produces trust cards. Same data path that we'll use for OB system + agent attestations later.

#### 3a. New engine type

Add to `packages/engine/src/types.ts`:

```ts
/**
 * Raw evidence atom emitted by a producer. Producers: game (system),
 * plugin, or agent (via attest tool). Travels on the relay as a
 * dedicated envelope type. Cross-game persistent (post-merge follow-up
 * adds D1 storage).
 */
export interface AttestationV1 {
  schemaVersion: 'attestation/v1';
  /** Content hash. Engine fills if omitted. Required to be deterministic. */
  id: string;
  /** Who emitted this. agentId for agents/system; pluginId-prefixed for plugins. */
  issuer: string;
  issuerKind: 'agent' | 'system' | 'plugin';
  /** ERC-8004 agentId being attested about. */
  subject: string;
  /** Discriminated-union over claim.type, validated by relay schema. */
  claim: {
    type: string;
    data: unknown;
  };
  /** Optional free-text annotation, ≤200 chars. */
  note?: string;
  confidence?: number;
  round: number;
  issuedAt: number;
  evidenceRefs?: TrustEvidenceRefV1[];
}
```

#### 3b. New relay envelope schema

Register `'attestation'` as a relay envelope type. Always `scope: 'all'` (private/team-scoped attestations don't exist by design — within-game fog-of-war is implemented by *delaying* emission, not by scoping the envelope).

In `packages/workers-server/src/plugins/relay-schemas.ts` (or wherever we register schemas — see existing `chat`, `dm`, etc.):

```ts
registerEnvelope({
  type: 'attestation',
  schema: AttestationV1Schema,  // Zod, refines scope.kind === 'all'
  scope: 'all',  // forced
});
```

#### 3c. TOTC emits attestations from `applyAction`

Currently TOTC trust cards are derived from game state at view time. New flow: TOTC emits an `AttestationV1` envelope at meaningful events, the projector plugin consumes those envelopes.

In `packages/games/tragedy-of-the-commons/src/game.ts`, `applyAction`:

```ts
// after each round resolves:
const attestations: RelayEnvelope[] = state.players.map(player => ({
  type: 'attestation',
  scope: { kind: 'all' },
  body: {
    schemaVersion: 'attestation/v1',
    id: deterministicId(state.gameId, state.round, player.agentId, 'tragedy.round_choice'),
    issuer: 'system:tragedy-of-the-commons',
    issuerKind: 'system',
    subject: player.agentId,
    claim: {
      type: 'tragedy.round_choice',
      data: {
        harvest: player.lastHarvest,
        regionsControlled: player.regionsControlled,
        influence: player.influence,
      },
    },
    round: state.round,
    issuedAt: Date.now(),
  } satisfies AttestationV1,
}));

return { state: newState, relayMessages: attestations };
```

(Concrete claim types — pick what makes sense; suggested set: `tragedy.round_choice`, `tragedy.commitment_made`, `tragedy.commitment_breached`, `tragedy.coalition_joined`. Document each one's `data` shape in `tragedy-of-the-commons/src/types.ts`.)

#### 3d. The `trust-projector-tragedy` plugin (new package, see §1b)

Plugin shape:

```ts
import type { ToolPlugin, AttestationV1, TrustCardV1 } from '@coordination-games/engine';

export const tragedyTrustProjector: ToolPlugin = {
  id: 'trust-projector-tragedy',
  modes: [
    {
      name: 'project',
      consumes: ['attestations'],
      provides: ['trust-cards'],
    },
  ],
  agentEnvelopeKeys: { 'trust-cards': 'trustCards' },

  // Standard relay-cursor consumer pattern. Engine feeds attestations
  // for the current viewer (already scope-filtered).
  handleData(_ctx, inputs) {
    const attestations = inputs.get('attestations') as AttestationV1[];
    const cards = buildTragedyTrustCards(attestations);  // your reducer
    return new Map([['trust-cards', cards]]);
  },
};
```

`buildTragedyTrustCards` is your existing `createTragedyVisibleTrust` reducer logic, adapted to take attestations as input instead of game state. The mapping is straightforward — each `tragedy.round_choice` attestation contributes one signal worth of evidence; aggregate by subject.

TOTC declares the projector in its `recommendedPlugins`:

```ts
// packages/games/tragedy-of-the-commons/src/index.ts
export const game: CoordinationGame = {
  // ...
  recommendedPlugins: ['trust-projector-tragedy', 'reasoning'],
};
```

The plugin lands `trustCards: TrustCardV1[]` on `state.trustCards` via `agentEnvelopeKeys`. UI reads `state.trustCards` exactly as it does today; the *source* of those cards is now the plugin instead of the `GameRoomDO` post-processor.

---

### 4. Leave `OBSERVATORY_DM_SPECTATOR_GAMES` alone — we'll fix it later

**No action needed from you on this one.**

The hardcoded set at `GameRoomDO.ts:73` works around a real bug: `relay-client.ts:188` filters spectators to `scope === 'all'` only, so DMs and team chats are invisible to spectators in *every* game, not just tragedy. You correctly noticed that TOTC needs spectators to see the chatter; the right fix is at the engine level (spectators see all envelopes, scope-tagged for UI marking, subject to the existing spectator delay) — not a per-game flag.

We'll fix this in a follow-up PR after yours merges. That follow-up will also delete the `OBSERVATORY_DM_SPECTATOR_GAMES` set + its two conditionals (`:1061`, `:1572`) since they become dead code once the engine-level fix is in. CtL and OB get spectator DM visibility for free.

**Your hack stays as-is in this PR.** Tragedy observatory continues working correctly via the hack until our follow-up replaces it. No rebase on our stuff required.

---

## What's NOT in this PR

For clarity — these items are *our* follow-up, not yours:

- D1 `attestations` table for cross-game persistence.
- `plugin-trust-attestations` (the `attest` MCP tool that lets agents emit peer attestations).
- OB system attestations on round end + OB UI showing system + agent signals.
- `playerId` → `agentId` rename across the codebase (tracked in a separate issue).

Once your PR merges, we layer all four on top without touching your code.

---

## Optional offer: we'll do §3 if you'd rather

If §3 (the AttestationV1 primitive + TOTC `applyAction` changes + the tragedy projector plugin) is more scope than you want to take on, just say the word and we'll send a PR against your branch implementing all of it. You'd own §1, §2, and the rebase for §4; we'd own §3. Either way is fine — no preference on our end, just want to land it cleanly.

---

## Summary checklist

- [ ] §1a: vendor `core` helpers into `packages/engine/src/canonical-encoding.ts`
- [ ] §1b: vendor `cg-adapter` reducer as new `packages/plugins/trust-projector-tragedy/` package
- [ ] §1: drop `@agentic-trust/*` from `workers-server/package.json`
- [ ] §2: delete `withVisibleTrustCards` + its two call sites in `GameRoomDO.ts`
- [ ] §3a: add `AttestationV1` to `engine/src/types.ts`
- [ ] §3b: register `'attestation'` relay envelope schema (scope: all forced)
- [ ] §3c: TOTC `applyAction` returns attestation envelopes in `relayMessages`
- [ ] §3d: `trust-projector-tragedy` plugin consumes attestations, produces trust cards via `agentEnvelopeKeys`
- §4: nothing for you — we're handling it in a follow-up

Test: `coga state` and the MCP `state` tool return identical `state.trustCards` for a tragedy game in progress.
