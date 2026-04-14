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

Plugins declare `consumes` and `provides` — capability type names, not plugin IDs. The pipeline builder runs Kahn's topological sort on type edges.

```
basic-chat          consumes: —              provides: messaging
extract-agents      consumes: —              provides: agents
trust-tagger        consumes: agents         provides: agent-tags
tag-propagator      consumes: messaging, agent-tags  provides: messaging
trust-filter        consumes: messaging      provides: messaging
```

**No explicit dependencies.** Just types. If B consumes what A provides, A runs first.

## Edge Cases

- **Unresolved types:** Plugin consumes a type nobody provides → warning, plugin skipped (graceful degradation)
- **Type overwriting:** Multiple plugins provide same type → later plugin overwrites (intentional for filters/enrichers)
- **Same-type filters** (consumes X, provides X): Pipeline builder needs to order filters after enrichers. Current approach: insertion order as tiebreaker when topological order is ambiguous.

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
