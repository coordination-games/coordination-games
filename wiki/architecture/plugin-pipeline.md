# Plugin Pipeline

## Plugin Interface

```typescript
interface ToolPlugin {
  readonly id: string;
  readonly version: string;
  readonly modes: PluginMode[];       // consumes/provides declarations
  readonly purity: 'pure' | 'stateful';
  readonly tools?: ToolDefinition[];  // mcpExpose controls visibility
  readonly agentEnvelopeKeys?: Record<string, string>; // capability → envelope key (optional)
  handleData(mode: string, inputs: Map<string, any>): Map<string, any>;
  handleCall?(tool: string, args: unknown, caller: AgentInfo): unknown;
}
```

## Surfacing Output to the Agent

`modes.provides` names a capability internal to the pipeline. To surface that capability on the agent-facing response, a plugin declares `agentEnvelopeKeys: { [capability]: envelopeKey }`. The CLI's `buildEnvelopeExtensions` (`packages/cli/src/pipeline.ts`) projects declared capabilities onto the top-level response at the chosen keys; undeclared capabilities stay internal (consumed by downstream plugins but not shown to agents).

BasicChatPlugin maps its `'messaging'` capability to the `newMessages` envelope key. By convention, delta-semantics fields use a `new` prefix; snapshot fields don't. See `wiki/architecture/agent-envelope.md` for the top-level diff that dedupes these keys on every call.

## Type-Based Resolution

Plugins declare `consumes` and `provides` — capability type names, not plugin IDs. The pipeline builder (`PluginLoader.buildPipeline()` in `packages/engine/src/plugin-loader.ts`) builds an edge `i → j` whenever step `j` consumes any type that step `i` provides, then runs **Kahn's algorithm** on that graph.

```
basic-chat          consumes: —              provides: messaging
extract-agents      consumes: —              provides: agents
trust-tagger        consumes: agents         provides: agent-tags
tag-propagator      consumes: messaging, agent-tags  provides: messaging
trust-filter        consumes: messaging      provides: messaging
```

**No explicit dependencies.** Just types. If B consumes what A provides, A runs first.

## Edge Cases

- **Unresolved types:** Plugin consumes a type nobody provides → the consumer just receives no entry for that capability key. No warning, no skip — pipeline runs, plugin gets `undefined`.
- **Type overwriting:** Multiple plugins provide same type → later step in the topo order overwrites the accumulated map entry (intentional for filters/enrichers).
- **Cycles error fast.** Same-type cycles (two steps that each consume what the other provides) leave the queue empty before all steps are processed; `buildPipeline()` throws `Plugin dependency cycle detected: <id>:<mode> → ...`. There is no fallback ordering — a cycle is a configuration bug, not a tiebreak.
- **Self-loops are allowed.** A single step that both consumes and provides the same type (`consumes: ['messaging'], provides: ['messaging']`) doesn't form a cycle — the edge-build skips `i === j`. Two same-type filters from different plugins, however, will cycle and error.

## Current Plugins

| Plugin | ID | Where | Notes |
|---|---|---|---|
| BasicChat | `basic-chat` | `packages/plugins/basic-chat/` (client + server halves) | Tier 2 relayed; provides `chat` tool |
| ELO | `elo` | `packages/workers-server/src/plugins/elo/` | Tier 3 server-side; capability-injected via `ServerPluginRuntime` |
| Settlement | `settlement` | `packages/workers-server/src/plugins/settlement/` | Tier 3 server-side; wraps the on-chain settlement state machine (Phase 5.3) |

## Trust Plugin Suite (Designed, Not Yet Built)

Five composable plugins for trust/reputation:
1. `trust-graph` — tools only (attest, revoke, reputation). EAS on Optimism.
2. `extract-agents` — producer, extracts unique agents from relay data
3. `trust-graph-agent-tagger` — enricher, looks up on-chain trust scores per agent
4. `agent-tags-to-message-tags` — enricher, copies agent tags onto messages
5. `trust-score-filter` — filter, drops messages from `suspicious` agents

The trust graph calculation (PageRank over attestation edges) runs server-side. Clients request scores via REST. Plan: `docs/plans/trust-plugins.md`.

## Server-Side Plugin Runtime

Phase 4.3 added `ServerPluginRuntime` (`packages/workers-server/src/plugins/runtime.ts`) — the host that loads server-side halves of plugins (ELO, Settlement, basic-chat server piece) and injects `Capabilities` (relay client, settlement, persistence). See `packages/workers-server/src/plugins/capabilities.ts`.

See: `packages/engine/src/plugin-loader.ts`, `packages/plugins/`, `packages/workers-server/src/plugins/`
