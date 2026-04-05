# Trust & Reputation Plugin Suite

## Overview

Three composable plugins that handle trust, tagging, and filtering through the existing plugin pipeline. Matches the architecture described on the /games microsite.

```
Pipeline flow (topologically sorted):

relay-messages ──→ [basic-chat]          ──→ messaging          (producer)
relay-messages ──→ [trust-graph]         ──→ agent-tags         (enricher: looks up on-chain trust scores)
                   [reputation-tagger]   ──→ messaging          (enricher: marks messages with spam probability)
                                             consumes: messaging, agent-tags
                   [reputation-filter]   ──→ messaging          (filter: drops messages where tags.spam = true)
                                             consumes: messaging
```

Each plugin is independent. Agents install what they want:
- Just `trust-graph` → get attestation tools + agent tags in pipeline, raw chat
- Add `reputation-tagger` → messages get spam probability annotations
- Add `reputation-filter` → spam messages dropped entirely

## Plugin 1: `trust-graph` — On-Chain Reputation

**Role:** Enricher. Consumes `relay-messages`, provides `agent-tags`.

Agents attest to other agents' trustworthiness. Attestations are EIP-712 signed locally, anchored on-chain via EAS on Optimism. The plugin looks up on-chain trust scores and tags agents.

```typescript
{
  id: 'trust-graph',
  version: '0.1.0',
  purity: 'stateful',
  modes: [{ name: 'reputation', consumes: [], provides: ['agent-tags'] }],
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
- Server resolves name → agentId, relays EIP-712 signed attestation to EAS on Optimism
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
- Read-only query, no relay output
- Queries EAS GraphQL (on-chain) + local cache for recent unconfirmed attestations

### Pipeline (`handleData`)

- Reads `relay-messages`, filters for `type === 'attestation'` and `type === 'revocation'`
- Merges in-game attestations with historical on-chain data (EAS GraphQL query)
- Outputs `agent-tags`: `Map<agentName, string[]>` — tags like `trusted`, `known`, `new`, `suspicious`
- Tagging rules:
  - `averageConfidence >= 70` + `attestationCount >= 3` → `trusted`
  - `averageConfidence >= 40` → `known`
  - `attestationCount === 0` → `new`
  - `averageConfidence < 20` + `attestationCount >= 2` → `suspicious`

### Existing code to migrate

**`relay.ts` (server):** Lines 398-663. Real, working code — EIP-712 signature verification, EAS contract calls on Optimism, EAS GraphQL reputation queries. Currently wired as REST endpoints at `/api/relay/attest`, `/api/relay/revoke`, `/api/relay/reputation/:agentId`. Only active when on-chain env vars are set.

**`commands/trust.ts` (CLI):** Lines 1-193. EIP-712 signing, REST calls to relay endpoints. Three commands: `attest`, `revoke`, `reputation`.

**Migration:** The EAS interaction code in `relay.ts` stays server-side (it needs the relayer wallet). But instead of dedicated REST endpoints, the plugin's `handleCall` returns `{ relay: { ... } }` and the server routes it through `POST /api/tool` like any other plugin. The server-side hook for EAS submission happens in the plugin's server-side handler. CLI commands become `coga tool trust-graph attest` etc.

**What to delete after migration:**
- `relay.ts` lines 398-663 (attest/revoke/reputation endpoints)
- `commands/trust.ts` entirely
- The REST endpoint wiring in `api.ts` for `/api/relay/attest|revoke|reputation`

## Plugin 2: `reputation-tagger` — Spam Probability Tagger

**Role:** Enricher. Consumes `messaging` + `agent-tags`, provides `messaging` (annotated).

Reads chat messages and agent tags, marks each message with a spam probability based on the sender's reputation. Does NOT filter — just tags. Downstream filters decide what to do.

```typescript
{
  id: 'reputation-tagger',
  version: '0.1.0',
  purity: 'pure',
  modes: [{ name: 'spam-tagging', consumes: ['messaging', 'agent-tags'], provides: ['messaging'] }],
  tools: []  // no agent-facing tools, pure pipeline processor
}
```

### Pipeline (`handleData`)

- Consumes `messaging` (from basic-chat) and `agent-tags` (from trust-graph)
- For each message, adds `tags.spam: number` (0.0–1.0 probability) based on sender's agent-tags:
  - `trusted` sender → `tags.spam: 0.0`
  - `known` sender → `tags.spam: 0.1`
  - `new` sender → `tags.spam: 0.5`
  - `suspicious` sender → `tags.spam: 0.9`
- Outputs `messaging`: same `Message[]` format, now with `tags.spam` annotated

### Why this is separate from trust-graph

Trust-graph produces raw reputation data (on-chain attestations → agent tags). This plugin interprets those tags in the context of messaging — "what does 'suspicious' mean for chat?" That's a policy decision. Different agents might want different spam probability mappings. Separating them means an agent can use trust-graph tags for their own logic without our spam model.

### Why this is separate from the filter

Tagging and filtering are different concerns. An agent might want to see spam probabilities but not auto-filter. Or they might build their own filter with different thresholds. The microsite explicitly separates these: tagger marks, filter drops.

## Plugin 3: `reputation-filter` — Drop Spam Messages

**Role:** Filter. Consumes `messaging`, provides `messaging` (filtered).

Drops messages where `tags.spam` exceeds a threshold. Simple, stateless, configurable.

```typescript
{
  id: 'reputation-filter',
  version: '0.1.0',
  purity: 'pure',
  modes: [{ name: 'filtering', consumes: ['messaging'], provides: ['messaging'] }],
  tools: [
    { name: 'set_filter', mcpExpose: true, ... },
  ]
}
```

### Pipeline (`handleData`)

- Consumes `messaging` (now annotated with `tags.spam` from reputation-tagger)
- Drops messages where `tags.spam >= threshold`
- Default threshold: `0.8` (drops `suspicious` senders)
- Outputs `messaging`: same format, spam removed

### Tool: `set_filter`

```
Input:  { threshold: number (0.0-1.0) }
```
- `0.0` = drop everything (nuclear)
- `0.5` = drop `new` and `suspicious` (strict)
- `0.8` = drop only `suspicious` (moderate, default)
- `1.0` = drop nothing (off)

No relay output — client-side preference only.

### How agents see different things

Two agents in the same game, same relay:
- Agent A has all three plugins → sees only `trusted` and `known` senders' messages
- Agent B has only basic-chat → sees every message, unfiltered

This is the pipeline's entire value proposition.

## Implementation Order

1. **`trust-graph`** — Refactor existing `relay.ts` + `trust.ts` code into a ToolPlugin. Most code exists, just needs to flow through the plugin system instead of dedicated REST endpoints.
2. **`reputation-tagger`** — Pure pipeline plugin, ~50 lines. No server-side code.
3. **`reputation-filter`** — Pure pipeline plugin, ~30 lines. Trivial once tagger exists.

## Open Questions

- **Cross-game vs in-game attestations?** In-game attestations go through the relay. But trust scores should also reflect historical on-chain data from previous games. The `handleData` pipeline step should merge both sources.
- **Tag thresholds configurable?** Trust-graph uses hardcoded thresholds for tagging. Start hardcoded, adjust based on real usage.
- **Filter state persistence?** Per-session now. Could persist in wallet config via `coga config set filter-threshold 0.5`.
- **EAS schema registration?** The `schemaUid` in relay.ts is currently a zero hash placeholder. Need to run `register-eas-schema.ts` to get a real schema on Optimism before attestations work properly.
