# Agent Envelope

> **Architectural rule:** every piece of envelope assembly described here lives in the shared CLI layer (`GameClient` and below). MCP is a bare wrapper that calls into these methods and returns the result. There is one path, not two. If you're tempted to add envelope logic to `mcp-tools.ts`, stop — it belongs in `game-client.ts`. See `CLAUDE.md` and `wiki/architecture/mcp-not-on-server.md`.

What an agent sees when it runs `coga state` (shell) or calls the equivalent MCP tool is the **agent envelope**: the game's visible state plus any plugin contributions, run through a top-level diff so unchanged keys drop off the wire.

## Layers

```
getVisibleState(state, playerId)         // game plugin — per-player fog-filtered state
      +
plugin.agentEnvelopeKeys extensions       // e.g. BasicChatPlugin → `newMessages`
      ↓
AgentStateDiffer.diff()                   // top-level deepEqualJson per key
      ↓
agent-visible response                    // changed keys pass through; unchanged → `_unchangedKeys: [...]`
```

The agent is expected to reuse its last-seen value for any key listed in `_unchangedKeys`. First observation in a session pass-through in full; every subsequent call carries only what changed.

## Top-Level Diff

`AgentStateDiffer` (`packages/cli/src/mcp-tools.ts`) holds one `lastSeen` per client. On each call:

- For each key in the current response:
  - If the key was present last time AND `JSON.stringify(curr[key]) === JSON.stringify(prev[key])`, push into `unchanged`.
  - Otherwise pass through.
- Keys removed since last observation surface as `_removedKeys: [...]`.
- Special keys (`_unchangedKeys`, `_removedKeys`) are themselves excluded from the comparison.

Reset via `state({ fresh: true })` — useful if the agent suspects cache drift.

`deepEqualJson` uses `JSON.stringify`. Stability of key order matters; server builders construct objects consistently so the same state produces the same stringified form every call.

## Static vs Dynamic Split (Game Author Guidance)

The top-level diff only helps if unchanging data lives on its own key. Mixing "static" and "dynamic" into one object invalidates the whole key on every tick.

CtL example:

- `mapStatic: { radius, bases }` — identical every turn, dedupes forever after turn 0. Bases carry coords as `HexTuple` (`[q, r]`): `{ flag: [q, r], spawns: [q, r][] }`.
- `visibleWalls: HexTuple[]` — fog-filtered per turn, changes when the viewer moves. Pure-coord list, so tuples (no object wrapper).
- `visibleOccupants: VisibleOccupant[]` — per-turn fog view of units/flags. Each entry is `{ pos: [q, r], unit?, flag? }` — the coord is a tuple, metadata stays nested.
- `summary: { pos: [q, r], carrying, alive, moveSubmitted, score, yourFlag, enemyFlag, enemies, flags }` — scalar at-a-glance; diff-friendly because small changes invalidate only this key. `enemies` and `flags` are `{ pos: [q, r], ...metadata }[]`. Canonical `turn` and `phase` live at the top level of the envelope (not duplicated here) so they dedup independently of the richer summary payload.
- `yourUnit: { position: [q, r], ..., visionRange, attackRange }` — player-specific per-turn state; includes static scalars so the agent doesn't need to hardcode class tables.

**Coord format rule of thumb** (used across hex-grid games via `HexTuple`
from `@coordination-games/engine`):
- Pure-coord arrays → `HexTuple[]` (tuples). Example: `visibleWalls`.
- Entries with metadata beyond coords → `{ pos: HexTuple, ...rest }`.
  Example: `visibleOccupants`, `summary.enemies`, `summary.flags`.
- Single coord on a metadata-carrier object → direct `HexTuple`. Example:
  `summary.pos`, `yourUnit.position`.
- Internal game state (unit/flag positions, map tiles, combat/fog/LoS
  input, spectator view, replay, web UI) stays on `{q, r}` objects. Only
  the agent-envelope emit boundary converts.

Rule of thumb: every top-level key should have a single "change cadence". Static info per game, per phase, per turn, per tick — each gets its own key.

## Plugin Extensions: `agentEnvelopeKeys`

Plugins that want their pipeline output exposed to the agent declare the envelope key explicitly:

```typescript
export const BasicChatPlugin: ToolPlugin = {
  id: 'basic-chat',
  modes: [{ name: 'messaging', consumes: [], provides: ['messaging'] }],
  agentEnvelopeKeys: { messaging: 'newMessages' },
  // ...
};
```

The CLI's `buildEnvelopeExtensions` (`packages/cli/src/pipeline.ts`) iterates registered plugins, pulls each declared capability from the pipeline output map, and places it at the plugin-chosen key. Capabilities without a declared envelope key stay internal to the pipeline (not agent-visible).

**Naming convention:** fields that are **delta** rather than snapshot carry a `new` prefix (`newMessages`, `newOffers`, `newVotes`). The relay cursor on the server already filters to items since last observation — the `new*` name makes the accumulation contract explicit.

## Why Deduping is Implicit, Not Plugin-Declared

Plugins don't need to know about the diff. They produce their current value honestly:

- Stable-output plugin → emits same value call-to-call → `deepEqualJson` returns `true` → key lands in `_unchangedKeys`.
- Delta plugin → emits only new items (server relay cursor does this work) → empty `[]` when nothing new → deep-equals last-seen empty `[]` → dedupes.

Any plugin that opts into the envelope via `agentEnvelopeKeys` participates in dedup for free.

## Where This Lives

- Diff: `packages/cli/src/mcp-tools.ts` (`AgentStateDiffer`).
- Plugin output projection: `packages/cli/src/pipeline.ts` (`buildEnvelopeExtensions`).
- Plugin manifest: `ToolPlugin.agentEnvelopeKeys` in `packages/engine/src/types.ts`.
- Response assembly: `GameClient.processResponse` in `packages/cli/src/game-client.ts`.

See also: `wiki/architecture/data-flow.md` for state vs relay, `wiki/architecture/plugin-pipeline.md` for capability-based plugin composition.
