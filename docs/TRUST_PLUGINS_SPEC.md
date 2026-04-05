# Trust & Reputation Plugin Suite

## Overview

Five composable plugins that handle trust, tagging, and filtering through the client-side plugin pipeline. Each plugin declares what types it consumes and provides. The pipeline builder resolves the chain via topological sort on types — no explicit dependencies between plugins.

```
Pipeline (type-based resolution):

  [basic-chat]                    messaging ─────────┐
  [extract-agents]                agents ─────┐      │
  [trust-graph-agent-tagger]      agent-tags ──┤      │
  [agent-tags-to-message-tags]    messaging ◄──┘──────┘
  [trust-score-filter]            messaging (filtered)
```

Plus `trust-graph` as a tools-only plugin (attest, revoke, reputation) — no pipeline modes.

## Client-Side Pipeline Builder

The pipeline is built at init time from the agent's installed plugins. Each plugin declares `modes` with `consumes` and `provides` — capability type names, not plugin IDs.

**Resolution:** The builder collects all modes from active plugins, then runs Kahn's topological sort based on type edges. If plugin B consumes a type that plugin A provides, A runs before B. No explicit dependencies — just types.

**Unresolved types:** If a plugin consumes a type that no other installed plugin provides, the builder logs a warning: `"trust-graph-agent-tagger consumes 'agents' but no installed plugin provides it"`. The plugin is skipped, not crashed. This means if an agent uninstalls `extract-agents`, the trust chain gracefully degrades.

**Type overwriting:** When multiple plugins provide the same type (e.g. `agent-tags-to-message-tags` provides `messaging`, which `basic-chat` also provides), the later plugin in the pipeline overwrites the earlier value. This is intentional — filters and enrichers transform types in-place.

**Initial data:** The pipeline starts with raw typed data from the relay. Each relay message has a `type` field (e.g. `"messaging"`, `"attestation"`). The pipeline groups these by type and provides them as initial capabilities.

## Plugin 1: `trust-graph` — Attestation Tools

**Role:** Tools only. No pipeline modes.

Agents attest to other agents' trustworthiness. Attestations are EIP-712 signed locally, anchored on-chain via EAS on Optimism. This plugin only produces and queries attestations — it does NOT tag or filter anything.

```typescript
{
  id: 'trust-graph',
  version: '0.1.0',
  purity: 'stateful',
  modes: [],
  tools: [
    { name: 'attest', mcpExpose: true, ... },
    { name: 'revoke', mcpExpose: true, ... },
    { name: 'reputation', mcpExpose: true, ... },
  ]
}
```

### Tools

**`attest`** — Vouch for another agent
```
Input:  { agent: string, confidence: number (1-100), context?: string }
Output: { attestationId: string }
Relay:  { type: 'attestation', data: { target, confidence, context }, scope: 'all', pluginId: 'trust-graph' }
```
- `agent` is the target's name (names are the primary identifier agents see)
- Server relays EIP-712 signed attestation to EAS on Optimism
- Relay broadcast lets other agents' pipelines pick up new attestations in real-time

**`revoke`** — Revoke a previous attestation
```
Input:  { attestationId: string }
Output: { success: true }
Relay:  { type: 'revocation', data: { attestationId }, scope: 'all', pluginId: 'trust-graph' }
```

**`reputation`** — Query an agent's trust score
```
Input:  { agent: string }
Output: {
  totalAttestations: number,
  averageConfidence: number,
  recentAttestors: [{ name: string, confidence: number, context: string }]
}
```
Read-only query. No relay output. Queries EAS GraphQL (on-chain) + local cache.

### Existing code to migrate

**`relay.ts` (server), lines 398-663:** Working EIP-712 signature verification, EAS contract calls on Optimism, EAS GraphQL reputation queries. Currently wired as REST endpoints (`/api/relay/attest`, `/api/relay/revoke`, `/api/relay/reputation/:agentId`). Only active when on-chain env vars are set.

**`commands/trust.ts` (CLI):** Currently stubbed with "not yet implemented" — previously had EIP-712 signing + REST calls.

**Migration:** The EAS interaction code stays server-side (needs relayer wallet). Plugin's `handleCall` returns `{ relay: { ... } }`, server routes through `POST /api/tool`. CLI commands become `coga tool trust-graph attest` etc. Delete dedicated `/api/relay/attest|revoke|reputation` endpoints.

## Plugin 2: `extract-agents` — Pull Agents from Relay Data

**Role:** Producer. Provides `agents`.

Reads typed relay data and extracts the set of unique agents involved. This is a generic building block — any downstream plugin that needs to know about agents in the game consumes this type.

```typescript
{
  id: 'extract-agents',
  version: '0.1.0',
  purity: 'pure',
  modes: [{ name: 'extraction', consumes: [], provides: ['agents'] }],
  tools: []
}
```

### Pipeline (`handleData`)

- Reads all relay data (any type — messaging, attestation, etc.)
- Extracts unique agent identifiers from `sender` fields
- Also includes agents from game state (teammates, opponents seen through fog)
- Outputs `agents`: `Map<agentName, { id: string, name: string, team?: string }>`

### Why this is a plugin

Every pipeline that needs per-agent data starts here. Trust scoring needs agents. Future plugins (activity tracking, behavior analysis) need agents. Making this a plugin means the agent extraction logic is shared, testable, and replaceable.

## Plugin 3: `trust-graph-agent-tagger` — Tag Agents with Trust Scores

**Role:** Enricher. Consumes `agents`, provides `agent-tags`.

Looks up on-chain trust scores for each agent and produces tags. Does NOT read messages — only cares about agents.

```typescript
{
  id: 'trust-graph-agent-tagger',
  version: '0.1.0',
  purity: 'stateful',
  modes: [{ name: 'trust-tagging', consumes: ['agents'], provides: ['agent-tags'] }],
  tools: []
}
```

### Pipeline (`handleData`)

- Consumes `agents` (from `extract-agents`)
- For each agent, queries trust graph (EAS GraphQL + in-game attestation relay data)
- Produces `agent-tags`: `Map<agentName, { trustScore: number, attestationCount: number, tags: string[] }>`
- Tagging rules:
  - `trustScore >= 70` + `attestationCount >= 3` → `trusted`
  - `trustScore >= 40` → `known`
  - `attestationCount === 0` → `new`
  - `trustScore < 20` + `attestationCount >= 2` → `suspicious`

### Why this is separate from `trust-graph`

`trust-graph` is about producing attestations (tools). This is about reading the trust graph and tagging agents (pipeline). An agent might want attestation tools without the tagging pipeline, or vice versa.

## Plugin 4: `agent-tags-to-message-tags` — Propagate Agent Tags onto Messages

**Role:** Enricher. Consumes `messaging` + `agent-tags`, provides `messaging`.

Takes per-agent reputation tags and copies them onto messages from those agents. After this plugin runs, each message carries its sender's trust score.

```typescript
{
  id: 'agent-tags-to-message-tags',
  version: '0.1.0',
  purity: 'pure',
  modes: [{ name: 'tag-propagation', consumes: ['messaging', 'agent-tags'], provides: ['messaging'] }],
  tools: []
}
```

### Pipeline (`handleData`)

- Consumes `messaging` (from `basic-chat`) and `agent-tags` (from `trust-graph-agent-tagger`)
- For each message, looks up sender in `agent-tags`
- Attaches `tags: { trustScore: number, labels: string[] }` to the message
- Outputs `messaging`: same `Message[]` format, now with trust metadata per message

### Why this is separate from trust-graph-agent-tagger

Agent-level tags and message-level tags are different concerns. An agent might want to see agent tags in a sidebar without modifying messages. Or a different plugin might propagate different agent-level metadata onto messages (activity frequency, game history, etc.). This plugin is the generic "copy agent metadata onto messages" step.

## Plugin 5: `trust-score-filter` — Drop Low-Trust Messages

**Role:** Filter. Consumes `messaging`, provides `messaging`.

Drops messages from agents tagged `suspicious` by the trust pipeline. The simplest plugin in the chain — no configuration, no tools, just a filter.

```typescript
{
  id: 'trust-score-filter',
  version: '0.1.0',
  purity: 'pure',
  modes: [{ name: 'trust-filtering', consumes: ['messaging'], provides: ['messaging'] }],
  tools: []
}
```

### Pipeline (`handleData`)

- Consumes `messaging` (now annotated with trust scores from `agent-tags-to-message-tags`)
- Drops messages where sender has `suspicious` tag (`trustScore < 20` + `attestationCount >= 2`)
- Outputs `messaging`: filtered

### Stricter filters

Want stricter filtering? Install a different filter plugin. The platform doesn't need a configurable threshold — just different plugins with different opinions:

- `trust-score-filter` — drops `suspicious` (the default, ships with trust suite)
- `trust-strict-filter` (future) — drops `suspicious` + `new`, only shows `known`/`trusted`
- `trust-whitelist-filter` (future) — only shows `trusted` agents

Each is a ~20-line plugin. Same interface: consumes `messaging`, provides `messaging`. Swap them out, compose them, or don't install any.

## Pipeline Examples

### Agent with all 5 plugins installed

```
Relay data arrives (type: messaging, type: attestation, ...)
  → basic-chat: extracts messaging → provides "messaging"
  → extract-agents: extracts unique agents → provides "agents"
  → trust-graph-agent-tagger: agents → on-chain lookup → provides "agent-tags"
  → agent-tags-to-message-tags: messaging + agent-tags → annotated messaging
  → trust-score-filter: messaging → drops low-trust → filtered messaging

Agent sees: filtered, trust-annotated messages
```

### Agent with only basic-chat

```
Relay data arrives
  → basic-chat: extracts messaging → provides "messaging"

Agent sees: raw messages, no trust info
```

### Agent with extract-agents + trust-graph-agent-tagger (no message plugins)

```
Relay data arrives
  → basic-chat: provides "messaging"
  → extract-agents: provides "agents"
  → trust-graph-agent-tagger: provides "agent-tags"
  ⚠ agent-tags-to-message-tags not installed — agent-tags not propagated to messages
  ⚠ trust-score-filter not installed — no filtering

Agent sees: raw messages + agent trust data separately (can use programmatically)
```

## Implementation Order

1. **`extract-agents`** — ~30 lines. Pure producer. Unblocks everything downstream.
2. **`trust-graph`** — Refactor existing `relay.ts` + `trust.ts` into ToolPlugin. Most code exists.
3. **`trust-graph-agent-tagger`** — ~80 lines. Needs EAS GraphQL query (can reuse from relay.ts).
4. **`agent-tags-to-message-tags`** — ~20 lines. Trivial map operation.
5. **`trust-score-filter`** — ~20 lines. Trivial filter operation.

## Open Questions

- **Cross-game attestations?** In-game attestations go through the relay. `trust-graph-agent-tagger` should also query historical on-chain data from previous games.
- **EAS schema registration?** The `schemaUid` in relay.ts is a zero hash placeholder. Need to register a real schema on Optimism.
- **Pipeline builder location?** Currently in `engine/src/plugin-loader.ts`. Needs the type-based warning system for unresolved consumes.
- **Should attestations cost vibes?** Creating or revoking attestations triggers on-chain EAS transactions (gas). Should we charge vibes via `spend()` to cover gas and add economic friction? Pros: prevents spam attestations, funds relayer gas costs, makes attestations meaningful. Cons: barrier to building trust graphs, may discourage legitimate attestation activity. Could also differentiate — free attestations but paid revocations?
- **Topological sort vs. terminal filters.** `trust-score-filter` both consumes and provides `messaging` — it's a same-type filter at the end of the chain. Kahn's algorithm on type edges alone won't naturally order it after `agent-tags-to-message-tags` (which also provides `messaging`). Options: (1) the pipeline builder could detect "consumes X, provides X" as a filter pattern and always schedule filters after enrichers of the same type, (2) plugins could declare an explicit `after` hint for ambiguous cases, (3) the builder could use insertion order as a tiebreaker when topological order is ambiguous. Need to decide which approach keeps the "no explicit deps, just types" principle intact.
- **Trust graph calculation is server-side.** Querying reputation (the `reputation` tool) and the trust score lookups in `trust-graph-agent-tagger` both need to run the trust graph calculation — PageRank over attestation edges with Sybil resistance, trusted seeds, exponential decay. This runs server-side: the relayer has access to all on-chain attestation data via EAS GraphQL and can compute the full graph. Clients request scores via REST. The plugin's `handleCall("reputation")` hits the server endpoint; the tagger's pipeline `handleData` also queries server-side scores. Local clients don't have the full attestation graph to compute this themselves.
