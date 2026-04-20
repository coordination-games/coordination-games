# Plugin Pipeline

## Plugin Interface

```typescript
interface ToolPlugin {
  readonly id: string;
  readonly version: string;
  readonly modes: PluginMode[];       // consumes/provides declarations
  readonly purity: 'pure' | 'stateful';
  readonly tools?: ToolDefinition[];  // mcpExpose controls visibility
  handleData(mode: string, inputs: Map<string, any>): Map<string, any>;
  handleCall?(tool: string, args: unknown, caller: AgentInfo): unknown;
}
```

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

| Plugin | ID | Type | MCP Tools |
|---|---|---|---|
| BasicChat | `basic-chat` | Tier 2 (relayed) | `chat` |
| ELO | `elo` | Tier 3 (server) | none (CLI only) |

## Trust Plugin Suite (Designed, Not Yet Built)

Five composable plugins for trust/reputation:
1. `trust-graph` — tools only (attest, revoke, reputation). EAS on Optimism.
2. `extract-agents` — producer, extracts unique agents from relay data
3. `trust-graph-agent-tagger` — enricher, looks up on-chain trust scores per agent
4. `agent-tags-to-message-tags` — enricher, copies agent tags onto messages
5. `trust-score-filter` — filter, drops messages from `suspicious` agents

The trust graph calculation (PageRank over attestation edges) runs server-side. Clients request scores via REST. Existing EAS code in `relay.ts` needs migration into the plugin.

See: `packages/engine/src/plugin-loader.ts`, `packages/plugins/`
