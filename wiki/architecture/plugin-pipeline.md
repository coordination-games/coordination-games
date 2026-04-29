# Plugin Pipeline
> Client-side plugins compose by capability type, not by plugin id; the loader topologically sorts them so adding a plugin can never silently land before its inputs.

## Why

The pipeline runs *on the agent's machine* — it processes the relay messages the server hands the CLI on every `getState` and projects the results into the agent's response envelope. There are two reasons it has to be a real pipeline rather than a hardcoded function call:

1. **Plugins compose.** Today only `BasicChatPlugin` ships, but the design has always been "producer → enricher → filter" chains (e.g. extract-agents → trust-tagger → trust-filter, see `docs/plans/trust-plugins.md`). Hardcoding "chat first, then everything else" would make the chain brittle to reorder and impossible to extend without touching the runner.
2. **The CLI is the only place this can run.** The plugin pipeline is a *client* concern — different agents have different plugins installed, and that's the point. A server-side pipeline would force one shape on every agent. So the runner sits next to `GameClient`, in `packages/cli/src/pipeline.ts`, and MCP inherits it as a wrapper. See `wiki/architecture/mcp-not-on-server.md`.

The design pressure that pinned typed dependencies (rather than explicit `dependsOn: ['chat']` lists) was that explicit-id dependencies couple every plugin author to every other plugin's id. Capability types invert that: a filter says "I take `messaging` and produce `messaging`" without knowing which plugin produced it, and the loader resolves the order. Multiple plugins providing the same type compose as a chain in topo order; that's how an enricher and a filter can both touch `messaging` without either knowing the other exists.

## How

**Plugin shape.** A `ToolPlugin` (`packages/engine/src/types.ts:449`) declares:

- `id`, `version`, `purity`.
- `modes: PluginMode[]` — each mode (`packages/engine/src/types.ts:499`) declares `consumes: string[]` and `provides: string[]`. Capability names are free-form strings (`messaging`, `agents`, `agent-tags`); the loader treats them as opaque keys.
- `tools?` — MCP-exposed tools, registered separately by `packages/cli/src/mcp-tools.ts`. Independent of pipeline ordering.
- `agentEnvelopeKeys?` — declares which provided capabilities are projected onto the top-level agent response. Authoritative explanation in `wiki/architecture/agent-envelope.md`; `pipeline.ts` only references the field.
- `handleData(mode, inputs) → outputs` — the pipeline-step body.

**Loader and topo sort.** `PluginLoader.buildPipeline()` (`packages/engine/src/plugin-loader.ts:106`) flattens active plugins into one `PipelineStep` per `(plugin, mode)`, then for every pair `(i, j)` adds an edge `i → j` if step `j` consumes any type step `i` provides (`:128-146`). Self-loops (`i === j`) are skipped intentionally — a single step that consumes and provides the same type is a filter, not a cycle. Kahn's algorithm (`:148-174`) emits the sorted step list; if processed count `!= steps.length`, the unprocessed steps are still in-degree-positive and the loader throws `Plugin dependency cycle detected: <id>:<mode> → ...` (`:182`).

**Execution.** `PluginPipeline.execute(initial)` (`packages/engine/src/plugin-loader.ts:35`) walks the sorted steps with a single accumulator `Map<string, unknown>`:

- A producer (no `consumes`) gets the *full* accumulator as input — that's how it reads the raw `relay-messages` that `runPipeline` seeds (`packages/cli/src/pipeline.ts:38`).
- A consumer gets a filtered map containing only its declared `consumes` keys.
- Outputs are merged back into the accumulator, overwriting any prior key. This is the by-design path for filters: a `provides: ['messaging']` step that consumes `messaging` replaces the upstream value.

**Registration on the client.** `initPipeline` (`packages/cli/src/pipeline.ts:24`) registers `DEFAULT_PLUGINS = [BasicChatPlugin]` plus any extras handed in. `GameClient.processResponse` (`packages/cli/src/game-client.ts:444`) calls `processState` (`packages/cli/src/pipeline.ts:60`), which runs the pipeline over `serverResponse.relayMessages` and hands the result map to `buildEnvelopeExtensions` (the `agentEnvelopeKeys` projection — see agent-envelope.md). The extensions are spliced onto the top-level response and the differ runs after.

**What ships today.** Exactly one client-side `ToolPlugin`: `BasicChatPlugin` (`packages/plugins/basic-chat/src/index.ts:122`). Its mode `{ name: 'messaging', consumes: [], provides: ['messaging'] }` makes it the producer that turns raw `RelayEnvelope`s of `type: 'messaging'` into `Message[]`. Server-side `ServerPlugin`s — ELO (`packages/workers-server/src/plugins/elo/index.ts`), Settlement (`packages/workers-server/src/plugins/settlement/index.ts`) — are a *separate* runtime (`ServerPluginRuntime`, `packages/workers-server/src/plugins/runtime.ts:48`); they do not go through `PluginPipeline` and don't have `consumes`/`provides`. Don't conflate the two.

## Edge cases & gotchas

- **Unresolved `consumes` is silent.** A consumer that declares `consumes: ['agent-tags']` when nobody provides `agent-tags` runs anyway — its `inputs` map just has no entry for that key, and `handleData` sees `undefined` on lookup. No warning, no skip. Helpful for "optional enrichment" plugins; trap for typos. The pipeline's only loud failure mode is a cycle.
- **Cycles throw, including same-type pairs.** Two plugins both declaring `consumes: ['messaging'], provides: ['messaging']` form a 2-cycle (each builds an edge to the other). `buildPipeline` throws (`packages/engine/src/plugin-loader.ts:182`); there is no tiebreak. A single plugin with `consumes: ['messaging'], provides: ['messaging']` is fine — the self-loop is skipped (`:130`) and it runs once. So the trust-suite design (see `docs/plans/trust-plugins.md`) needs an ordering hint before it can ship two `messaging`-filter plugins together.
- **Producers see the entire accumulator, not just `relay-messages`.** `PluginPipeline.execute` hands a producer `new Map(data)` (`:45`), not just the seeded entry. That's how a producer can layer on top of upstream producers, but it also means a producer's `inputs.get('relay-messages')` is the same object every consumer would see — don't mutate.
- **Same-type providers merge by overwrite, in topo order.** Two independent steps that both `provides: ['agent-tags']` end up running in some valid topological order (the test suite covers this, `packages/engine/src/__tests__/plugin-loader.test.ts:93`). Whichever runs second overwrites the first's accumulator entry. If you wanted a *merge* you have to write the consumer to do it; the loader doesn't.
- **Pipeline runs only when there are relay messages.** `GameClient.processResponse` short-circuits when `relayMessages` is empty or absent (`packages/cli/src/game-client.ts:447-448`) — no pipeline run, no envelope extensions for that response. Plugins that want to emit something every tick regardless of relay traffic don't fit the current shape.
- **`getTools` is independent of `buildPipeline`.** Tool registration walks every active plugin's `tools` (`packages/engine/src/plugin-loader.ts:189`); a plugin with a tool but no modes still surfaces tools to the MCP layer. Don't assume a plugin only "exists" if it has pipeline steps.

## Pointers

- `packages/engine/src/plugin-loader.ts` — `PluginLoader.buildPipeline` (line 106), `PluginPipeline.execute` (line 35), cycle error (line 182).
- `packages/engine/src/types.ts:449` — `ToolPlugin` interface; `PluginMode` at line 499.
- `packages/cli/src/pipeline.ts` — `initPipeline` (line 24), `runPipeline` (line 35), `processState` (line 60). Default plugin set at line 18.
- `packages/cli/src/game-client.ts:444` — `processResponse`, the only caller of `processState` on the live path.
- `packages/plugins/basic-chat/src/index.ts:122` — the only shipped `ToolPlugin`.
- `packages/engine/src/__tests__/plugin-loader.test.ts` — topo-sort, cycle-detection, and same-type-merge fixtures.
- `wiki/architecture/agent-envelope.md` — `agentEnvelopeKeys` (the plugin → envelope projection).
- `wiki/architecture/data-flow.md` — what `relayMessages` is (and isn't) before it reaches the pipeline.
- `wiki/architecture/mcp-not-on-server.md` — why the runner lives in the CLI process, not the server.
- `docs/plans/trust-plugins.md` — proposed multi-plugin chain that exercises every edge case above.
