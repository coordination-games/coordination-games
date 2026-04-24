# Agent Envelope Fix — Handoff Plan (v2, critique-reconciled)

## THE ONE RULE (read first)

**MCP is the barest possible wrapper around the CLI. All logic lives in the CLI.** The shell `coga` command is the primary agent path — MCP handlers just delegate to `GameClient` methods and return results verbatim. There is ONE path, not two. The wrapper inherits everything from the CLI because it IS a wrapper.

This plan exists because we violated this rule. Don't violate it while fixing it. Every change in this plan happens in the shared CLI layer; MCP handlers become thinner as a side effect.

## Context

One session tried to make the agent envelope lean and diff-efficient.
Envelope SHAPE is mostly right. LAYER is wrong — the dedup lives in
MCP only, while real agents use `coga` as a shell command via Bash. So
every dedup win we measured via an MCP probe reaches nobody.

## The Four Shipped Problems

1. **MCP-only dedup.** `AgentStateDiffer` is instantiated at
   `packages/cli/src/mcp-tools.ts:269` and applied at lines 307, 321,
   429, 444. Shell handlers in `packages/cli/src/commands/game.ts:361`
   (`state`) and `:391` (`wait`) call `client.getState()` /
   `client.waitForUpdate()` with **no differ**. Shell bypasses.
2. **Coord format.** Every coord field on the envelope is `{q,r}`
   (verified: `hex.ts:5`, `game.ts:62-66,81,89,91,102,118,120`,
   `fog.ts:94`). Agreed spec was 2-tuple `[q,r]`. Regressed silently
   during implementation.
3. **Pretty-printed shell JSON.** `commands/game.ts` has **8** call
   sites doing `JSON.stringify(result, null, 2)` (lines 345, 375, 405,
   535, 540, 546, 549, 556, 558). Tripled byte cost vs compact.
4. **`currentPhase` (and any other always-emitted field) re-emits
   every call.** In the shell path this is collateral damage from #1 —
   fixing the diff fixes it. But the plan must still explicitly audit
   each top-level key to decide: *inside the diff's scope and expected
   to dedup* vs *volatile by design*. `timeRemainingSeconds` is the
   likely volatile offender (computed fresh each call against
   `deadlineMs`), and will invalidate dedup tests if not addressed.

## Principle Violated

**MCP is a subset of the CLI path, not a parallel path.** Agent-facing
features (diff, envelope extensions, format, delta semantics) live at
the layer every caller shares. Splitting them guarantees the "human"
shell path silently becomes second-class for agents.

## Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Callers: shell commands (commands/game.ts), MCP handlers     │
│ (mcp-tools.ts), programmatic bots, tests                     │
└──────────────────────────────────────────────────────────────┘
                          │  (all call into)
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ GameClient.getState / waitForUpdate / callTool (one path)    │
│   1. ApiClient.fetch (sinceIdx from persisted cursor)        │
│   2. flattenStateEnvelope                                    │
│   3. processResponse: plugin pipeline + envelope extensions  │
│   4. applyAgentDiff: file-backed lastSeen per (agent, game)  │
│   5. serialize: compact JSON by default                      │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
                agent-facing JSON string
```

Everything below this line is the *current* envelope shape, which
stays. Don't touch those key names.

## Persistent State Design (Decide Now — Not an Open Question)

**Location:** `~/.coordination/agent-state.json`.

**Shape:**
```json
{
  "_v": 1,
  "agents": {
    "<agentAddress>": {
      "<gameOrLobbyId>": {
        "relayCursor": 42,
        "lastSeen": { /* flattened state payload from last call */ }
      }
    }
  }
}
```

- Keyed by `(agentAddress, gameOrLobbyId)` so an agent switching
  games doesn't mix state.
- `_v: 1` for schema migration. Unknown version = reset file (log a
  warning).
- **Write strategy: atomic write via tmp + rename.** (`fs.writeFile`
  to `agent-state.json.tmp`, then `fs.rename`.)
- **Concurrency: advisory lock via `proper-lockfile` (or equivalent
  single-file lock).** Hold only during read-modify-write; release
  immediately. Contention is fine — next reader just gets the latest.
  Don't invent; use an existing npm lockfile lib.
- `--fresh` (shell) and `fresh: true` (MCP) both delete the
  `(agentAddress, gameOrLobbyId)` entry before the fetch — resetting
  cursor AND lastSeen together.

## Concrete Work Plan

### Phase 1 — Persistent (cursor + lastSeen) file

Non-negotiable prerequisite for the diff. Ship together.

- New module: `packages/cli/src/agent-persistence.ts`.
- API:
  ```ts
  type PersistedEntry = { relayCursor: number; lastSeen: unknown };
  function read(agent: string, scopeId: string): PersistedEntry | null;
  function write(agent: string, scopeId: string, entry: PersistedEntry): void;
  function clear(agent: string, scopeId: string): void;
  ```
- Use `proper-lockfile` for mutual exclusion, atomic-rename for writes,
  JSON `_v: 1` header.
- **Wire `ApiClient._relayCursor` to this module.** Currently pure
  in-memory (`api-client.ts:147`). Every fetch reads the persisted
  cursor; every successful fetch writes the new cursor.

### Phase 2 — Move the diff into the shared path

- Move `AgentStateDiffer` out of `mcp-tools.ts`. New home:
  `packages/cli/src/agent-state-differ.ts`.
- Replace in-memory `lastSeen` with `agent-persistence.read/write`.
- Add a `GameClient.applyAgentDiff(raw)` method that calls into the
  differ.
- Update `GameClient.getState / waitForUpdate / callTool /
  callToolRaw / callPluginRelay` to call `applyAgentDiff` as the final
  step before returning. (All five already route through
  `processResponse` — good — so the extension splice is shared. The
  diff hasn't been.)
- Delete the four `agentDiffer.diff(result)` calls in `mcp-tools.ts`
  (lines 307, 321, 429, 444). MCP handlers now get the diff for free
  via the shared `GameClient` methods.

### Phase 3 — Compact JSON by default for shell output

- Audit `commands/game.ts` — all 8 `JSON.stringify(x, null, 2)` sites.
  Flip default to `JSON.stringify(x)` (compact).
- Add a `--pretty` flag on each shell subcommand that prints
  agent-facing JSON. Default off. Humans opt in.
- Confirm MCP path (`mcp-tools.ts:jsonResult`) already emits compact.

### Phase 4 — Volatile-field audit (addresses problem #4)

List every top-level key in the agent envelope and classify:

| Key | Dedupable? | Action |
|---|---|---|
| `summary` | yes (object) | in-diff |
| `turn` | yes (scalar, changes per tick only) | in-diff |
| `phase` | yes | in-diff |
| `yourUnit` | yes per-turn | in-diff |
| `mapStatic` | yes (static) | in-diff |
| `visibleWalls` | yes per-turn-per-position | in-diff |
| `visibleOccupants` | yes per-turn | in-diff |
| `yourFlag`/`enemyFlag` | yes | in-diff |
| `timeRemainingSeconds` | **NO — ticks per call** | **replace with `deadlineMs` (absolute, changes only on turn tick)** |
| `moveSubmitted` | yes per-turn | in-diff |
| `score` | yes per-turn | in-diff |
| `gameType`/`gameId`/`gameOver` | yes | in-diff |
| `currentPhase` | yes per-phase | in-diff (will stabilize once differ runs on shell too) |
| `newMessages` | delta | in-diff (dedupes when empty `[]`) |

**Action:** replace `timeRemainingSeconds` with `deadlineMs` in the
envelope. Agent computes seconds-left from `Date.now()` client-side.
Removes the one truly anti-dedup field.

### Phase 5 — Coord format `{q,r}` → `[q,r]`

Scope is larger than it sounds. Do a full file-level inventory first.

**Boundary discipline:** internal game state (`GameUnit.position`,
`FlagState.position`, map storage, combat/movement/los/fog internals,
spectator view, replay, web UI) stays `{q,r}`. Only the **envelope
emit** converts to `HexTuple`.

**Type:** add `export type HexTuple = [number, number]` to
`packages/engine/src/types.ts` (shared so other games adopt the same
convention).

**Files to change (confirmed via live code audit):**
- `packages/games/capture-the-lobster/src/game.ts` — `AgentMapStatic`,
  `AgentSummary`, `GameState`, `getStateForAgent` emit. For inline
  `{q, r, unitClass}` in `AgentSummary.enemies` / `{q, r, team}` in
  `.flags`, decide shape: use `[q, r, unitClass]` (3-tuple) or
  `{ pos: [q,r], unitClass }`. **Recommendation: 3-tuple** for
  consistency and brevity. Same for `flags`.
- `packages/games/capture-the-lobster/src/fog.ts` —
  `VisibleOccupant.{q, r}` → `pos: HexTuple` (object still, since it
  carries optional `unit`/`flag`).
- `packages/games/capture-the-lobster/src/plugin.ts` — CTL_GUIDE
  envelope examples.
- `packages/games/capture-the-lobster/src/__tests__/game.test.ts` —
  tests asserting `{q,r}` shapes on agent output.
- `wiki/architecture/agent-envelope.md` — update examples.
- `docs/building-a-game.md` — update examples.
- Skill repo `SKILL.md` — PR #3 already has generic keys, but update
  the coord example too before merging.

**Non-goal:** don't touch `buildSpectatorView`, replay, web UI, or
any non-agent consumer. If `getStateForAgent` shares helpers with
spectator code, split them.

### Phase 6 — Verify end-to-end (shell-first)

All assertions MUST be on the shell path. MCP is a downstream consumer
now; it inherits correctness from the shared layer.

**Test A — diff fires across process boundaries.**
1. `rm -f ~/.coordination/agent-state.json`
2. `coga create-lobby -s 2 -g capture-the-lobster` → save $LOBBY
3. `coga join $LOBBY`
4. Fill bots to start the game (fill-bots script).
5. `coga state > /tmp/s1.json`
6. `coga state > /tmp/s2.json`
7. Assert: `jq '._unchangedKeys' /tmp/s2.json` lists every
   **non-volatile** key (`mapStatic`, `visibleOccupants`, etc.).
   `timeRemainingSeconds` must NOT appear as a key (replaced with
   `deadlineMs`, which itself dedupes).

**Test B — fresh works.**
- `coga state --fresh` after Test A returns full state with no
  `_unchangedKeys`.

**Test C — walls change when player moves.**
- Submit a move that changes LoS. Next `coga state` has
  `visibleWalls` in the changed set, not in `_unchangedKeys`.

**Test D — `newMessages` flows through shell.**
- Have a teammate chat. Next `coga state` (or `coga wait`) carries
  `newMessages`. Empty on no-chat ticks — in `_unchangedKeys`.

**Test E — compact by default.**
- `coga state` stdout has no `\n  ` indentation. `coga state --pretty`
  does.

**Test F — coord format.**
- `coga state | jq '.visibleWalls[0]'` returns an array
  (`[-3, 2]`-shape), not an object (`{"q":-3,"r":2}`).

**Test G — concurrency.**
- Spawn two `coga state` processes in parallel against the same agent.
  Neither crashes with lockfile errors. Both succeed. The
  `agent-state.json` is valid JSON afterward.

**Test H — measurement baselines (reproducible).**
Script: on a lobby fresh-started with 4 Haiku bots, after reaching
turn 3 stable (both teams formed, class picks done):
- `wc -c` of `coga state` compact JSON: target **≤ 1.5KB**
  (first-observation, baseline ~4.5KB).
- `wc -c` of a second `coga state` immediately after: target **≤
  300B**.
- Run the whole bot game to completion: **zero errors** (WRONG_PHASE,
  UNKNOWN_TOOL, DISPATCH_FAILED, TypeErrors). Use seed=default
  (whatever the DOs assign).

### Phase 7 — Ship

**Order (this order matters):**
1. All Phase 6 tests pass locally.
2. Bump `packages/cli/package.json` from `0.11.1` → `0.12.0`
   (breaking: coord format + `deadlineMs` rename + file-state deps).
3. Rebuild engine (for plugins to pick up the new type if any are
   updated — for this PR, no plugin changes, but still: workspace
   build order).
4. `git tag v0.12.0 && git push origin v0.12.0` → publish workflow.
5. Wait for npm publish to complete. `npm view coordination-games
   version` returns `0.12.0`.
6. Deploy worker (`npx wrangler deploy` in `packages/workers-server`).
   Worker uses the new `getStateForAgent` envelope shape; prod and
   CLI must roll together.
7. Merge skill repo PR #3 after (6) is live.

**Post-ship acceptance:**
- Re-run Test H against prod with freshly-installed CLI — same
  targets hold.
- User runs their own Claude session against prod and confirms dedup
  fires in shell output.

## Don't Change

- Envelope key names: `summary`, `mapStatic`, `visibleWalls`,
  `visibleOccupants`, `newMessages`, `yourUnit.visionRange/attackRange`.
- `ToolPlugin.agentEnvelopeKeys` mechanism.
- Fog-filter on walls (per-turn LoS).
- `computeTileSets` returning `{wallSet, walkableTiles, allHexes}`.
- Dead-code deletion of `buildVisibleState`.

## Not in This PR

- Generalize delta semantics beyond `new*` naming (add
  `deltaSemantics: 'replace' | 'delta'` on plugin manifest). YAGNI.
- Multi-unit-per-hex in `buildVisibleOccupants`.
- Spectator/replay/web UI coord format migration.

## Open Questions (True Open — Decide During Implementation)

- **Lock library choice.** `proper-lockfile` is suggested; confirm
  it's acceptable vs writing a 20-line file-based lock. (Dependency
  audit — is `proper-lockfile` used elsewhere? If not, inline is
  fine.)
- **Is `scopeId` always the active game/lobby ID, or is it null for
  pre-lobby state calls?** `coga lobbies` lists lobbies before the
  agent picks one — does that produce stateful output that needs
  persistence? Probably not, but confirm before Phase 1.

## Audit Notes (Cross-Referenced With Live Code)

- `commands/game.ts` contains both `state` and `wait` handlers; no
  `commands/state.ts` exists. **v1 plan had wrong filenames.**
- `ApiClient._relayCursor` is at `api-client.ts:147`, pure in-memory.
  `resetSessionCursors()` at L182 only zeroes memory.
- `GameClient.processResponse` routes through `processState` (pipeline
  + envelope extensions) for all five state-returning methods
  (lines 137, 144, 166, 179, 218). Shell already gets
  `newMessages` via this path — the *format* and the *diff* are what
  shell loses, not the extension splice.
- `AgentSummary.enemies` and `.flags` use inline object literals with
  extra fields, not bare `Hex`. Phase 5 must handle the tuple+extra
  case explicitly.
- `buildVisibleState` is deleted. `computeTileSets` returns
  `{wallSet, walkableTiles, allHexes}`. Confirmed.
- Current CLI version: `0.11.1`.

## Handoff Checklist

For the next engineer starting this:

- [ ] Read this whole doc.
- [ ] Read `packages/cli/src/{game-client.ts, api-client.ts,
      mcp-tools.ts}` and `packages/cli/src/commands/game.ts` before
      writing any code.
- [ ] Read `packages/games/capture-the-lobster/src/game.ts` from line
      55 (type definitions) through line 700 (getStateForAgent end).
- [ ] Start Phase 1. Don't skip to Phase 2 — the differ depends on
      persistent state.
- [ ] Build engine once before each phase that touches types.
- [ ] Ship Phases 1–6 as one PR. Phase 7 (ship order) after PR
      merges to main.
