# Agent Envelope
> Top-level-key dedup over the agent-facing response: every key the agent sees has a single "change cadence," and unchanged keys collapse into `_unchangedKeys` so the next call carries only what moved.

## Why

Agents call `coga state` constantly. Every full-payload response burns context, and most of the payload doesn't move tick-to-tick — `mapStatic` is identical every turn, `summary.score` only changes on a kill, and the chat backlog grew by zero or one entry. If the agent eats the whole envelope every time, its window fills with re-observations of state it already saw and the model gets dumber for no reason.

The envelope has one job: every top-level key is observed against the agent's last response, and any key whose JSON is byte-identical to last time gets dropped from the payload and its name pushed onto `_unchangedKeys: [...]`. The agent reuses its previous value for those keys. That dedup only works if (a) the dedup engine actually runs on the path the agent uses and (b) keys are sharded by change cadence — `mapStatic` separated from `visibleWalls`, `turn` separated from the richer per-turn `summary`. Mix two cadences into one key and the whole key invalidates on the fast cadence's tick, dragging the slow cadence with it.

There is one **scar** on this design: `AgentStateDiffer` (`packages/cli/src/agent-state-differ.ts:33`) used to live inside `mcp-tools.ts`, which meant *only* MCP-driven agents got dedup. Real agents drive `Bash(coga state)`, the shell handlers called `client.getState()` raw, and zero dedup reached the primary user for months. The fix (commit `a4fe17e refactor(cli): delete MCP-side dedup — GameClient owns it now`) moved the differ down into `GameClient` (`packages/cli/src/game-client.ts:66`) so both surfaces share it. The class file's header comment records the scar in detail (`packages/cli/src/agent-state-differ.ts:1-28`); the rule "MCP is a bare wrapper" in `wiki/architecture/mcp-not-on-server.md` exists because of this.

The other consequence of the move is that *plugins* contribute envelope keys too — the chat plugin's `newMessages` is just as much "an agent-facing top-level key" as the game plugin's `mapStatic` — so the projection from plugin pipeline output to envelope keys (`agentEnvelopeKeys`) lives at the same layer the differ does. One pipeline, one differ, one envelope.

## How

```
getVisibleState(state, playerId)         // game plugin — per-player fog-filtered state
      +
plugin.agentEnvelopeKeys extensions      // ToolPlugin contributions, e.g. BasicChatPlugin → newMessages
      ↓
AgentStateDiffer.diff()                  // top-level deepEqualJson per key, per-(agent, scope) baseline
      ↓
agent-visible response                   // changed keys pass through; unchanged → _unchangedKeys: [...]
```

**Top-level diff.** `AgentStateDiffer.diff()` (`packages/cli/src/agent-state-differ.ts:67`) holds one `lastSeen: Record<string, unknown> | null` baseline per instance. On each call:

- For each key in the current response:
  - If the key was present last time AND `JSON.stringify(curr[key]) === JSON.stringify(prev[key])` (`packages/cli/src/agent-state-differ.ts:105-116`), the key name lands in `unchanged`.
  - Otherwise the key passes through verbatim into `changed`.
- Keys present in `prev` but absent from `curr` surface as `_removedKeys: [...]` (`:93-95`). Removed keys answer "did this vanish or stay the same?" — `_unchangedKeys` is silent about absent keys.
- `_unchangedKeys` and `_removedKeys` themselves never enter the baseline.

First observation passes through in full and seeds the baseline (`:74-78`). Reset via `differ.reset()` (`:49-51`); the CLI exposes this through `state({ fresh: true })` and `wait({ fresh: true })` — both also wipe the persisted on-disk baseline (`packages/cli/src/game-client.ts:243-245`, `:272-274`).

**Why `JSON.stringify` works.** `deepEqualJson` (`packages/cli/src/agent-state-differ.ts:105`) leans on `JSON.stringify` because the response is already pure JSON (no functions, no cycles, no Dates). Stable insertion order isn't a separate constraint — the server builds the same response shape for the same state on every call, so a key's stringification is stable across observations of stable state. If you ever start mutating object key order between calls (e.g. spreading a `Record` whose iteration order shifts), dedup silently degrades; don't.

**Persistence across processes.** Two separate `coga state` invocations against the same `(agent, scope)` need to dedup against each other. `GameClient` round-trips the baseline through `~/.coordination/agent-state.json` via `agentPersistence` (`packages/cli/src/game-client.ts:495-503`): `loadPersistedLastSeen()` rebuilds the differ from the persisted entry at the entry of every state-returning method (`:247, 276, 301, 316, 358`); `applyAgentDiff` writes the updated baseline back via `differ.getLastSeen()` after the diff (`:478`). In-memory is the hot-path; disk is the source of truth. Persistence is scope-bound — `coga lobbies`, `coga wallet`, etc. don't dedup at all (`:468`).

**Static vs dynamic split.** The diff only helps if unchanging data lives on its own key. Mixing static and dynamic into one object invalidates the whole key on every tick. CtL's envelope splits along this exact line:

- `mapStatic: { radius, bases }` — identical every turn after game start, dedupes forever after turn 0. Bases carry coords as `HexTuple` (`[q, r]`).
- `visibleWalls: HexTuple[]` — fog-filtered, changes when the viewer moves. Pure-coord list, so tuples (no object wrapper).
- `visibleOccupants: VisibleOccupant[]` — per-turn fog view of units/flags. Each entry is `{ pos: [q, r], unit?, flag? }` — coord is a tuple, metadata stays nested.
- `summary: { pos, carrying, alive, moveSubmitted, score, yourFlag, enemyFlag, enemies, flags }` — at-a-glance scalars, diff-friendly because small changes invalidate only this key.
- Canonical `turn` and `phase` live at the top level of the envelope (not duplicated under `summary`) so they dedup independently of the richer payload.
- `yourUnit: { position: [q, r], ..., visionRange, attackRange }` — player-specific per-turn state; includes static scalars so the agent doesn't need to hardcode class tables.

**Coord format rule of thumb** (used across hex-grid games via `HexTuple` from `@coordination-games/engine`, `packages/engine/src/types.ts:32`):

- Pure-coord arrays → `HexTuple[]` (tuples). Example: `visibleWalls`.
- Entries with metadata beyond coords → `{ pos: HexTuple, ...rest }`. Example: `visibleOccupants`, `summary.enemies`, `summary.flags`.
- Single coord on a metadata-carrier object → direct `HexTuple`. Example: `summary.pos`, `yourUnit.position`.
- Internal game state (unit/flag positions, map tiles, combat/fog/LoS, spectator view, replay, web UI) stays on `{q, r}` objects. Only the agent-envelope emit boundary converts.

Rule of thumb: every top-level key should have a single change cadence. Static info per game, per phase, per turn, per tick — each gets its own key.

**Plugin extensions: `agentEnvelopeKeys`.** A `ToolPlugin` declares which of the capabilities it provides should surface to the agent and at what envelope key (`packages/engine/src/types.ts:486`):

```typescript
export const BasicChatPlugin: ToolPlugin = {
  id: 'basic-chat',
  modes: [{ name: 'messaging', consumes: [], provides: ['messaging'] }],
  agentEnvelopeKeys: { messaging: 'newMessages' },
  // ...
};
```

`buildEnvelopeExtensions` (`packages/cli/src/pipeline.ts:46`) iterates registered plugins, pulls each declared capability from the pipeline output map, and places it at the plugin-chosen envelope key. Capabilities that *don't* appear in any plugin's `agentEnvelopeKeys` stay internal to the pipeline — consumed by downstream plugins but invisible to the agent. The extensions get spliced onto the top-level response in `GameClient.processResponse` (`packages/cli/src/game-client.ts:444-451`), and only then does the differ run over the merged shape. So plugin-contributed keys dedup on the same path as game-state keys — there is no second projection.

**Naming convention** for plugin-contributed keys: fields that carry *delta* semantics (cursor-filtered to "items new since last observation") use a `new` prefix — `newMessages`, future `newOffers`, `newVotes`. The relay cursor on the server already filters to deltas, so empty-array stable-equals-empty-array dedupes naturally. Snapshot fields (full state, replayed every tick) use plain names. The prefix is the contract that surfaces this to the reader.

**Why deduping is implicit, not plugin-declared.** Plugins emit their current value honestly; the differ does the rest:

- Stable-output plugin → emits the same value call-to-call → `deepEqualJson` returns true → key lands in `_unchangedKeys`.
- Delta plugin → emits only new items (relay cursor does that work) → empty `[]` when nothing new → dedupes against last-seen empty `[]`.

Any plugin opting into the envelope via `agentEnvelopeKeys` gets dedup for free.

## Edge cases & gotchas

- **Forgetting `agentEnvelopeKeys` makes the plugin invisible.** A plugin that runs in the pipeline and produces a capability but doesn't list it in `agentEnvelopeKeys` is internal-only. That's the default and usually correct (extractor / enricher / filter steps shouldn't all surface to the agent), but if you wonder why your new plugin's output isn't reaching the agent, this is the first thing to check.
- **Key collisions are first-write-wins.** `buildEnvelopeExtensions` overwrites `ext[envelopeKey]` per plugin in registration order (`packages/cli/src/pipeline.ts:54`). Two plugins claiming the same envelope key (e.g. both mapping `messaging → newMessages`) silently clobber. The pipeline-side type system doesn't catch this — capability *names* (`messaging`) are what the loader checks for cycles; envelope *keys* (`newMessages`) are an unrelated namespace. Pick keys defensively.
- **A "static" key that secretly ticks invalidates every call.** If `mapStatic` includes a `serverTimestamp` or any per-call counter, the key is no longer static and dedup collapses. The compact-vs-pretty audit (`a4fe17e`) and the coord-format regression (`e71a27f`) both fell out of cases where a "static" thing wasn't. Run a two-call test, look at `_unchangedKeys` — if your key isn't in there for a tick where nothing changed, the key is mis-cadenced.
- **Stringified key order matters but isn't enforced.** `deepEqualJson` uses `JSON.stringify` over object key insertion order. The server builds responses consistently today (no Map-iteration leakage, no random-order reductions), but if a future builder spreads two `Record`s in mixed order, dedup quietly degrades. There's no schema-level guard.
- **`_unchangedKeys` / `_removedKeys` are presentation, not state.** They're omitted from the next-call baseline (`packages/cli/src/agent-state-differ.ts:96`). An agent that copies them into its own state and resends them back doesn't break anything, but it's reading meta as data.
- **First call after `fresh: true` re-emits everything.** That's by design — the disk baseline is wiped (`packages/cli/src/game-client.ts:243-245`), so the next call seeds a new baseline and dedup starts from scratch. If `coga state` looks suddenly verbose after a `--fresh`, that's why.
- **Unscoped commands don't dedup.** `coga lobbies`, `coga wallet`, identity commands skip `applyAgentDiff` entirely (`packages/cli/src/game-client.ts:468`) — no scope, no persistence, no diff. By design; their output is small and not per-game.
- **The shell-vs-MCP parity test.** Run the same operation as `coga <thing>` in a shell. If you see a different envelope shape than the MCP path produces (modulo `--pretty`), the diff/extension projection has been lifted into one path and not the other — the scar story above. Push it back into `GameClient`.

## Pointers

- `packages/cli/src/agent-state-differ.ts` — `AgentStateDiffer` class (line 33), `diff()` method (line 67), `deepEqualJson` (line 105). File header records the scar story.
- `packages/cli/src/pipeline.ts:46` — `buildEnvelopeExtensions`, the `agentEnvelopeKeys` projection. `processState` at line 60.
- `packages/cli/src/game-client.ts` — `processResponse` (line 444), `applyAgentDiff` (line 463), `loadPersistedLastSeen` (line 495). All state-returning methods load before, write after.
- `packages/engine/src/types.ts:486` — `ToolPlugin.agentEnvelopeKeys` field; `HexTuple` at line 32.
- `packages/plugins/basic-chat/src/index.ts:128` — the only live `agentEnvelopeKeys` declaration today (`{ messaging: 'newMessages' }`).
- `packages/cli/src/__tests__/agent-state-differ.test.ts` — `_unchangedKeys`, `_removedKeys`, baseline-hydration coverage.
- `wiki/architecture/plugin-pipeline.md` — how `messaging` ends up in the pipeline output map in the first place.
- `wiki/architecture/mcp-not-on-server.md` — the bare-wrapper rule, why the differ lives in `GameClient`.
- `wiki/architecture/data-flow.md` — relay cursor, how delta-prefixed keys carry only-new items.
- `docs/plans/agent-envelope-fix.md` — the original handoff that pushed dedup down out of MCP.
