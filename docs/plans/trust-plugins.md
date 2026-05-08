# Trust Plugin Suite Spec

## Status: Designed, Not Built

Five composable plugins for trust/reputation. EAS attestations on Optimism. Existing EAS code in `relay.ts` (lines ~398-663) needs migration into plugin form.

## The Five Plugins

### 1. `trust-graph` (Tools Only)
Attest, revoke, query reputation. EIP-712 signed locally, anchored on EAS.
- `attest(agent, confidence 1-100, context?)` → relay broadcast
- `revoke(attestationId)` → relay broadcast
- `reputation(agent)` → read-only query (EAS GraphQL + cache)

### 2. `extract-agents` (Producer)
Extracts unique agents from relay data. `provides: ['agents']`. ~30 lines.

### 3. `trust-graph-agent-tagger` (Enricher)
`consumes: ['agents']`, `provides: ['agent-tags']`. Looks up on-chain trust scores.
- Tagging: `≥70 + ≥3 attestations` → trusted, `≥40` → known, `0 attestations` → new, `<20 + ≥2` → suspicious

### 4. `agent-tags-to-message-tags` (Enricher)
`consumes: ['messaging', 'agent-tags']`, `provides: ['messaging']`. Copies agent trust onto messages. ~20 lines.

### 5. `trust-score-filter` (Filter)
`consumes: ['messaging']`, `provides: ['messaging']`. Drops messages from `suspicious` agents. ~20 lines.

## Existing Code to Migrate
- `relay.ts` server: EIP-712 verification, EAS contract calls, GraphQL queries. Currently REST endpoints.
- `commands/trust.ts` CLI: Stubbed. Previously had EIP-712 signing.
- Migration: EAS code stays server-side (needs relayer wallet). Plugin `handleCall` returns relay data. Delete dedicated `/api/relay/attest|revoke|reputation` endpoints.

## Open Questions
- Cross-game attestations? Tagger should query historical on-chain data too.
- EAS schema registration? Current `schemaUid` is a zero hash placeholder.
- Should attestations cost vibes? (spam prevention vs barrier to trust building)
- Topological sort ambiguity: same-type filters (consumes+provides messaging) need ordering hint.
- Trust graph calculation is server-side (PageRank + Sybil resistance). Clients request scores via REST.

---

## Demoted from `wiki/architecture/plugin-pipeline.md` (2026-04-29)

The wiki page used to describe the trust suite as part of the live plugin pipeline architecture. The plugins below are forward-looking design — only `BasicChatPlugin` is implemented today — so this material moved here, where the rest of the trust spec already lives. (Same demotion pattern as `committed-ledger.md`.)

### "Trust Plugin Suite (Designed, Not Yet Built)"

Five composable plugins for trust/reputation:
1. `trust-graph` — tools only (attest, revoke, reputation). EAS on Optimism.
2. `extract-agents` — producer, extracts unique agents from relay data
3. `trust-graph-agent-tagger` — enricher, looks up on-chain trust scores per agent
4. `agent-tags-to-message-tags` — enricher, copies agent tags onto messages
5. `trust-score-filter` — filter, drops messages from `suspicious` agents

The trust graph calculation (PageRank over attestation edges) runs server-side. Clients request scores via REST.

### Type wiring (same as the spec above, in pipeline shorthand)

```
basic-chat          consumes: —              provides: messaging
extract-agents      consumes: —              provides: agents
trust-tagger        consumes: agents         provides: agent-tags
tag-propagator      consumes: messaging, agent-tags  provides: messaging
trust-filter        consumes: messaging      provides: messaging
```

No explicit dependencies — just types. If B consumes what A provides, A runs first. The pipeline builder (`PluginLoader.buildPipeline()` in `packages/engine/src/plugin-loader.ts:106`) builds an edge `i → j` whenever step `j` consumes any type step `i` provides, then runs Kahn's algorithm.

### Pipeline-ordering risks specific to this suite

- `tag-propagator` and `trust-filter` both `consumes: ['messaging']` and `provides: ['messaging']` — that's a 2-cycle in the loader's graph (each builds an edge to the other) and `buildPipeline` will throw. The "topological sort ambiguity" open question above is about exactly this. Possible fixes: introduce an intermediate capability name (`tagged-messaging` between propagator and filter), or add an explicit ordering hint to `PluginMode`. Either is a loader change, not a plugin change.
- A single plugin that both consumes and provides the same type is fine (the loader skips self-loops at `plugin-loader.ts:130`). Two such plugins competing for the same type is the bug.

### Status as of demotion

- `packages/cli/src/commands/trust.ts` — three stubs (`attest`, `revoke`, `reputation`) that print "Not yet implemented" and exit 1.
- `relay.ts`-era EIP-712 signing + EAS GraphQL code referenced in the migration section above is gone from the live tree as of System cleanup v2; rebuild from history if useful, but the spec is the source of truth, not the old code.
- No `trust-graph`, `extract-agents`, `trust-graph-agent-tagger`, `agent-tags-to-message-tags`, or `trust-score-filter` exists in the codebase. The names that show up in `packages/engine/src/__tests__/plugin-loader.test.ts` (`trust`, `reputation`) are pipeline-fixture stand-ins, not implementations.
