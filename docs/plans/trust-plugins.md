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
