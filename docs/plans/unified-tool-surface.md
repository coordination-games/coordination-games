# Unified Tool Surface

**Status:** Proposed. Not yet built. Validated against codebase 2026-04-16.

Replace the triad of `submit_move` / `lobby_action` / `plugin tools` with a single discoverable tool registry. Every player-callable action — game move, lobby coordination, plugin helper — is a named `ToolDefinition` with its own `inputSchema`. Agents call tools by name; the server routes by who declared the tool.

## Motivation

### Problems today

1. **Phase-based tool switching is a leaky abstraction.** Agents must pick between `submit_move` (game phase) and `lobby_action` (lobby phases). Wrong tool in the wrong phase produces confusing errors or silent no-ops.
2. **`lobby_action` is a type-erased passthrough.** `packages/cli/src/mcp-tools.ts:210-225` takes `type: string, payload: any` with no per-action schema. Agents can't discover the shape.
3. **The `coga tool <game> <name>` CLI path was a silent-success footgun.** When Lucian's agent called `coga tool capture-the-lobster accept_team teamId=team_14` on 2026-04-16, the plugin-tool stub route returned `{ok:true}` without ever reaching the real `LobbyDO` validator (which at `packages/games/capture-the-lobster/src/phases/team-formation.ts:350-357` *does* correctly return a typed 404 when called via the proper `lobby_action` path). The right fix is to retire the ambiguous route and give every tool a single, validated path.
4. **`submit_move` is a JSON blob.** Agent reads markdown `guide` to know action shapes. No schema exposed, no MCP-level validation.
5. **Three different almost-validators:** MCP boundary (thin zod, only `string/number/array<string>`), server relay (accepts anything), phase `validateAction` (the only one that actually enforces semantics). Discovery and validation live in different places.
6. **Tool discovery relies on parsing markdown.** No structured source of truth.

### Property we want

**Adding a game or plugin adds tools, never endpoints.** Same unification rule as `wiki/architecture/engine-philosophy.md` applies to lobbies.

## Design

### The universal contract

Every player-callable action is a `ToolDefinition` (this interface already exists at `packages/engine/src/types.ts` and is used by both `ToolPlugin.tools` and `LobbyPhase.tools`):

```ts
interface ToolDefinition {
  name: string;             // e.g. "move", "propose_team", "choose_class", "send_message"
  description: string;      // agent-facing
  inputSchema: JSONSchema;  // strict shape; drives both client zod + server validation
  mcpExpose?: boolean;      // false = hidden from MCP surface (internal/debug)
}
```

GamePhase needs to expose its actions the same way. This is the main new thing.

### Four destinations, one surface

From the agent's perspective: one discoverable set of named tools, one dispatcher. From the server's perspective, routing is a pure function of who declared the tool.

| Declarer                 | Player-callable?             | Dispatch                                                | In action log?          |
|--------------------------|-----------------------------|---------------------------------------------------------|-------------------------|
| `GamePhase.tools`        | yes, `POST /api/player/tool` | `GameRoomDO.applyAction` via `validateAction` + `applyAction` | yes, Merkle-anchored    |
| `LobbyPhase.tools`       | yes, `POST /api/player/tool` | `LobbyDO.phase.handleAction`                            | no (ephemeral)          |
| `ToolPlugin.tools`       | yes, client-side             | `plugin.handleCall()` locally; optional relay post      | no                      |
| **System actions**       | **no, engine-emitted only**  | `GameRoomDO.applyActionInternal(null, ...)` from `alarm()` or lobby→game handoff | yes, Merkle-anchored |

**Key security invariant** (already true in the codebase at `plugin.ts:450-461` and `oathbreaker/game.ts:112-126`): for every tool in `gameTools ∪ LobbyPhase.tools`, `validateAction(state, playerId, action)` MUST return false when `playerId === null`. For every system action type, `validateAction` MUST return false when `playerId !== null`. No type is valid for both. This invariant is testable and MUST be asserted in CI.

System actions are deliberately NOT declared as `ToolDefinition[]` on the plugin. Declaring them would create a footgun where accidental inclusion in the dispatcher registry becomes a privilege-escalation bug. They stay implicit: the engine code that emits them (`GameRoomDO.alarm()`, lobby→game handoff) is the authoritative source, and the `playerId === null` gate defends the apply path.

### Server changes

**1. `CoordinationGame.gameTools`.**

Extend the `CoordinationGame` interface (`packages/engine/src/types.ts`):

```ts
interface CoordinationGame {
  // ...existing fields...
  /** Player-callable tools during the game phase. Dispatcher reconstructs
   *  `{type: tool.name, ...args}` before passing to validateAction/applyAction. */
  gameTools?: ToolDefinition[];
}
```

For CtL: one entry for `move`. For OATHBREAKER: entries for `propose_pledge` and `submit_decision`. `validateAction`/`applyAction` stay as the execution layer. `gameTools` is the **declaration**; the existing methods are the **implementation**.

Shape the field so that a future migration to `GamePhase` (peer of `LobbyPhase`, supporting multi-game-phase games) is a rename rather than a rewrite. Specifically: the engine's dispatcher logic should treat `gameTools` as "the tools of the current game phase" from day one, even when there's only one game phase.

**2. Single tool-call endpoint.**

```
POST /api/player/tool { toolName: "move", args: { path: ["N","NE"] } }
```

Server dispatch:

1. Look up `toolName` in the session's tool registry (built at game load: `gameTools ∪ currentLobbyPhase.tools`).
2. If not found → `UNKNOWN_TOOL` error with the list of tools valid in the current phase.
3. If found but declared on a phase other than the current one → `WRONG_PHASE` error with current phase + list of tools valid now.
4. Dispatch by declarer:
   - **GamePhase tool:** reconstruct `action = { type: toolName, ...args }`, forward to `GameRoomDO /action`. GameRoomDO runs `validateAction(state, playerId, action)` (unchanged path), rejects with `VALIDATION_FAILED` + the validator's error if false, applies otherwise. **Critical: the stored action object in `_actionLog` is `{type, ...args}` — the exact shape today — so Merkle hashes are identical to pre-refactor. Cryptographic continuity is preserved.**
   - **LobbyPhase tool:** forward to `LobbyDO /action`, `phase.handleAction({type: toolName, payload: args})` runs.

Existing endpoints (`/api/player/move`, `/api/player/lobby/action`) remain for one release as deprecated shims that internally convert to the new format. Remove after the deprecation window (see Migration).

**3. Tool discovery via existing state endpoint.**

`LobbyDO.buildState()` already returns `currentPhase.tools` (`packages/workers-server/src/do/LobbyDO.ts:587`). **Extend `GameRoomDO.buildState()` to include `currentPhase.tools: gameTools`.** CLI + MCP read from state on every `get_state` / `wait_for_update` — zero staleness, no separate discovery endpoint, no cache logic.

**4. Collision detection at session init.**

On session init (server side for phases, client side for plugins):

```
full_surface = gameTools ∪ lobbyPhases.flatMap(p => p.tools) ∪ pluginTools
for each (name, declarers[]) in groupBy(full_surface, 'name'):
  if declarers.length > 1:
    throw ToolCollisionError(name, declarers)
```

Hard error at session start. No silent precedence. Error message lists every declarer and suggests concrete resolutions:

```
Tool name collision: "move" is declared by:
  - GamePhase of game "capture-the-lobster"
  - ToolPlugin "@cg/plugin-pathfinder"

Resolve by:
  - removing one plugin from your session config, or
  - (future) using renameTools config: { "@cg/plugin-pathfinder": { move: "pf_move" } }
```

GamePhase vs LobbyPhase collisions count (same MCP namespace), even though temporally exclusive. No current game has such collisions; the rule just needs to be stated for future game authors.

**5. Observability.**

Structured log per tool call at the dispatcher:

```ts
log('tool.call', {
  sessionId, playerId, toolName, declarer: 'game'|'lobby'|'plugin',
  phaseAtDispatch, validationResult: 'ok'|'unknown'|'wrong_phase'|'invalid_args'|'validation_failed',
  latencyMs, errorCode?, errorMessage?
});
```

Admin introspection endpoint `GET /api/admin/session/:id/tools` returns the full live registry for any session — useful when an operator asks "why did my bot get UNKNOWN_TOOL?"

### Client (CLI) changes

The CLI keeps **static top-level commands**; dynamic tools are namespaced under `coga tool <name>`. This preserves predictable `--help`, predictable argparse, predictable error shapes. No top-level flag surface changes based on a server call.

```
Static (built-in, --help never changes):
  coga join_lobby LOBBY_ID
  coga create_lobby [--game ctl] [--team-size 2]
  coga list_lobbies
  coga state
  coga wait
  coga tools                   # lists currently-callable dynamic tools
  coga guide [--game X]        # markdown rules

Dynamic (namespaced under `tool`):
  coga tool <name> [k=v ...]   # dispatches to /api/player/tool
  coga tool <name> --help      # prints inputSchema from server
```

**Arg parsing from JSON Schema:**
- `k=v` → `properties[k]` with type coercion (string/number/boolean)
- `k=v1,v2` → array
- `k=@file.json` → load JSON from file
- `--json '{...}'` → raw JSON passthrough for complex shapes
- Missing required → error listing required fields with descriptions

**MCP surface:** The CLI's embedded MCP server registers phase tools as first-class MCP tools (not behind a dispatcher), because machine clients thrive on explicit tool lists. The CLI registers the union of `state.currentPhase.tools` (server-authoritative) + locally-loaded `ToolPlugin.tools` with `mcpExpose: true`. When a phase changes, tools from other phases return `WRONG_PHASE` at dispatch time (we do NOT dynamically re-register MCP tools — the protocol doesn't support it cleanly).

Two surfaces, one source of truth. Humans get stable CLI ergonomics; bots get discoverable MCP tools.

### Error taxonomy

All dispatcher errors return a structured payload:

```ts
{ error: { code: ErrorCode, message: string, ...contextFields } }

type ErrorCode =
  | 'NO_SESSION'          // no authenticated session
  | 'UNKNOWN_TOOL'        // toolName not in session registry; includes validToolsNow[]
  | 'WRONG_PHASE'         // tool exists but belongs to a different phase; includes currentPhase, validToolsNow[]
  | 'INVALID_ARGS'        // args failed inputSchema validation; includes fieldErrors[]
  | 'VALIDATION_FAILED'   // phase.validateAction / game.validateAction rejected; includes validator's message
  | 'DISPATCH_FAILED'     // internal (DO unreachable, etc.); includes sessionId for ops
  | 'PLUGIN_ERROR'        // client-side plugin.handleCall threw
  | 'RELAY_UNREACHABLE'   // plugin tool tried to post and relay endpoint failed
  | 'COLLISION'           // init-time only: tool name declared by multiple sources
```

Every error includes enough context for the agent to self-correct (what was expected, what's currently valid).

### Testing — drift invariants

To prevent the schema-vs-validator drift that caused the original footgun:

1. **Declared shape is accepted:** for every tool in `gameTools ∪ LobbyPhase.tools`, generating a sample from `inputSchema` and submitting with a valid `playerId` must result in `validateAction` / `handleAction` returning either `ok` or a *semantic* rejection — never `INVALID_ARGS` (shape mismatch).
2. **Undeclared shape is rejected:** for every tool, submitting args with an extra field or missing required field produces `INVALID_ARGS`.
3. **System-action isolation:** for every system action type emitted by the engine, `validateAction(state, <any non-null playerId>, {type})` returns false. For every tool in the callable surface, `validateAction(state, null, {type: tool.name, ...})` returns false.
4. **Collision detector:** a test fixture with two plugins both naming a `chat` tool produces `COLLISION` at init.

These tests are MVP-blocking — they're the reason for the whole refactor.

## Migration

### Order of work

The plan is built up in implementable increments. Each phase is independently shippable and deliverable value-positive on its own.

**Phase 1 — MVP (highest value, smallest blast radius):**
- Add `gameTools?: ToolDefinition[]` on `CoordinationGame`.
- Extend `GameRoomDO.buildState()` to include `currentPhase.tools`.
- CtL declares `gameTools: [{name: "move", ...}]`. OATHBREAKER declares `[{name: "propose_pledge", ...}, {name: "submit_decision", ...}]`.
- Replace the `lobby_action` MCP tool with per-name MCP entries generated from `currentPhase.tools` (LobbyPhase already exposes them). `coga tool <name>` dispatcher added to the CLI.
- `submit_move` MCP tool stays for now.
- Collision detection extended to cover phase-tool ∪ plugin-tool ∪ static-CLI.
- Drift tests + error taxonomy + observability logging implemented.

Ship Phase 1 and validate with real bots before proceeding.

**Phase 2:**
- Same MCP-unification treatment for game tools. `submit_move` MCP tool becomes a deprecated shim; agents call `coga tool move` or the `move` MCP tool directly.
- Skill repo updated.

**Phase 3 (server-side cleanup, no user-visible change):**
- Unify `/api/player/move` and `/api/player/lobby/action` under `POST /api/player/tool`. Old endpoints remain as shims behind a feature flag for one release.
- Delete shims.

### External coordination

- **Skill repo** (`coordination-games/skill`, SEPARATE from this monorepo per `/home/lucian/workspace/capture-the-lobster/CLAUDE.md`): update docs and example commands to use `coga tool <name>`.
- **Bot scripts** — audit and update:
  - `packages/cli/src/commands/game.ts` (local bot harness)
  - `scripts/drive-bots-adhoc.ts`, `scripts/fill-bots.ts`, `scripts/setup-bot-pool.ts` (untracked per `git status`)
  - Haiku bot harness per `wiki/development/bot-system.md`
  - Hetzner trading server bot configs (see `/home/lucian/workspace/CLAUDE.md`)
- **`docs/building-a-game.md`** — tutorial update: new `gameTools` field, drift-test requirement, system-action conventions.

### Client version detection

New CLIs talking to old servers: `/api/player/tool` 404s → CLI falls back to `/api/player/move` / `/api/player/lobby/action` with reconstructed shapes. Detected by a `server_version` field in `get_state` (add in Phase 1 even before it matters — cheap).

Old CLIs talking to new servers: shims are in place for one release, so calls succeed. Deprecation warning logged server-side when shim is used; included in `tool.call` log with `legacyEndpoint: true`.

### Rollback plan

If `/api/player/tool` has a regression post-cutover:
1. Re-enable the `/api/player/move` + `/api/player/lobby/action` shims via feature flag (they're retained as code through the deprecation window).
2. CLI flag `--legacy-endpoints` forces old routes.
3. Admin endpoint `POST /api/admin/session/:id/reset-to-legacy` disables the new dispatcher per-session.
4. If schema changes broke things: `gameTools` is additive on `CoordinationGame` — removing the field falls back to the pre-refactor applyAction-only path without deploy.

## Non-goals

- **Onchain tool type registry.** Tracked separately as a future issue. Great idea for credible-neutrality (agents can verify game rules onchain) but out of scope here. Trust boundary stays at server-side `validateAction`.
- **Declaring system actions as ToolDefinitions.** Creates a footgun (see Security invariant above). Stay implicit, defended by `playerId === null` gate.
- **Relocating physical asset PNGs.** Covered in the sibling spec `docs/plans/spectator-colocation.md`.
- **Dynamic MCP tool re-registration on phase change.** MCP protocol doesn't support it cleanly. We register the superset at session start and gate at dispatch time.
- **Multi-game-phase games** (e.g. draft → play → vote). `gameTools` is a flat array sufficient for CtL and OATHBREAKER today. Future migration to `GamePhase[]` peer of `LobbyPhase` is a rename of the field, not a rearchitecture.
- **Plugin rename config** (operator escape hatch for forced collisions). Mention as future work; not needed for MVP.

## Open questions

- **`type` field in the wire action object:** the action as stored in the Merkle log is `{type: toolName, ...args}`. The wire format agents send is `{toolName, args}`. Server reconstructs. Agents never see the `type` field. This is the chosen approach — stated here to close the earlier "decide during implementation" hedge.
- **Relay propagation from GamePhase tools:** `LobbyPhase.handleAction` can return relay messages via `PhaseActionResult.relay`. Should `GamePhase`-dispatched actions be able to do the same? Today `applyAction` returns `ActionResult` which doesn't include relay emissions. Not blocking MVP; address when a game needs it.

## Related

- `wiki/architecture/data-flow.md` — game state vs relay data; game actions vs lobby actions onchain distinction
- `wiki/architecture/engine-philosophy.md` — "adding a game adds no endpoints" unification rule
- `docs/plans/spectator-colocation.md` — sibling spec for the spectator/asset scatter cleanup
