# MCP Is Not On The Server
> The shell CLI is the primary agent path; MCP is a trivial wrapper that calls the same `GameClient` methods. Anything that only works in MCP is broken for the user we actually have.

## Why

Real agents — Claude Code in particular, but every harness we've shipped — drive the game through `Bash(coga state)`, `Bash(coga wait)`, `Bash(coga tool <name>)`. MCP-over-stdio is a secondary surface. So any logic that lives only in the MCP path silently doesn't run for the primary user.

We've already paid for this once. `AgentStateDiffer` (`packages/cli/src/agent-state-differ.ts:33`) was originally instantiated *inside* `mcp-tools.ts`. Every MCP `state` / `wait` call dedupped top-level keys; every shell `coga state` call did not — and shell was the path real bots used. Agents went weeks getting full-payload state on every tick, blowing context for no reason, and nobody noticed because the MCP test path looked fine. The fix wasn't to mirror the differ into the CLI command — it was to delete it from MCP and push it down into `GameClient` (`packages/cli/src/game-client.ts:66`), which is what both paths share. The class file's header comment now records the scar (`packages/cli/src/agent-state-differ.ts:1-28`).

The rule that fell out: **MCP handlers translate, they do not compute.** If a feature is worth giving agents at all, it's worth giving them in `coga`, and once it's there MCP inherits it for free as a wrapper.

## How

There is one `GameClient` (`packages/cli/src/game-client.ts:36`). Both surfaces call into it:

- **Shell.** `packages/cli/src/index.ts` wires Commander commands; gameplay commands build a `GameClient` via `createClient()` (`packages/cli/src/commands/game.ts:65`) and invoke methods directly.
- **MCP.** `coga serve` (`packages/cli/src/commands/serve.ts:14`) starts an `McpServer` (`packages/cli/src/mcp-server.ts:39`) and hands it to `registerGameTools(server, client, …)` (`packages/cli/src/mcp-tools.ts:274`). Every handler registered in that function is the same shape: take args, call one `GameClient` method, return its result through `jsonResult` / `jsonError` (`packages/cli/src/mcp-tools.ts:478-498`).

The bare-wrapper rule is enforced by convention — and by the file-top comment that screams it (`packages/cli/src/mcp-tools.ts:5-26`). Spot-check any handler in that file: `state` (`packages/cli/src/mcp-tools.ts:311-330`) is four lines of try/catch around `client.getState({ fresh })`. The differ runs inside `getState`, not here.

**Tool surface.** Every entry in three sets is registered as one MCP tool at startup (`packages/cli/src/mcp-tools.ts:418-471`):

- `game.gameTools` — every registered game's gameplay tools.
- `game.lobby.phases[*].tools` — every lobby phase's tools.
- `plugin.tools` with `mcpExpose: true` — client-side `ToolPlugin` opt-ins.

Game and lobby-phase tools dispatch through `client.callToolRaw(toolName, args)` (`packages/cli/src/mcp-tools.ts:464`), which posts to the unified `POST /api/player/tool` endpoint and lets the server route by declarer. Plugin tools run `plugin.handleCall(...)` *locally* (`packages/cli/src/mcp-tools.ts:430`) and only post the resulting envelope via `client.callPluginRelay(...)` (`packages/cli/src/mcp-tools.ts:449`); the plugin pipeline is a client-side concern that the server isn't allowed to short-circuit. This is also why MCP-on-the-server would be wrong — bots wired straight to the server would skip the plugin pipeline that lives inside the CLI process.

**Collision check at startup.** `ClientToolCollisionError` (`packages/cli/src/mcp-tools.ts:92`) is thrown if any name appears more than once across the surface, or collides with a `STATIC_CLI_COMMANDS` entry (`packages/cli/src/mcp-tools.ts:62`). The flat namespace covers static CLI commands, game tools, lobby-phase tools, and plugin tools alike. Mirrors the engine-side check at `packages/engine/src/registry.ts:89`.

**Auth and identity** sit in `GameClient` (`packages/cli/src/game-client.ts:36`), not in any MCP handler. The wallet, the challenge-response, the auto-auth on first call — all happen below the surface both paths share. There are no signin/register tools, by design.

## Edge cases & gotchas

- **The test for "is this MCP-only?"** — run the same operation as `coga <thing>` in a shell. If you don't get the same observable behavior (modulo `--pretty` formatting on JSON output, `packages/cli/src/commands/game.ts:33-35`), the logic is in the wrong layer. Move it into `GameClient` and let MCP inherit.
- **"Translation" vs "logic."** Translating MCP arg shape into a method call is fine: the `create_lobby` handler picks `playerCount` vs `teamSize` based on `gameType` (`packages/cli/src/mcp-tools.ts:394-403`) — that's argument adaptation. Computing a diff, formatting an envelope, deduping output, deciding which fields to emit — that's logic. It belongs below.
- **Plugin tools default to NOT MCP-exposed.** `mcpExpose` must be explicitly `true` on a `ToolPlugin.tools` entry to be registered (`packages/cli/src/mcp-tools.ts:140`); a missing field is treated as opt-out. Game and lobby-phase tools are auto-exposed.
- **Phase-invalid tools are not de-registered.** A tool not callable in the current phase still appears in the MCP surface; the server returns a structured `WRONG_PHASE` error and the agent self-corrects. Dynamic re-registration is what the MCP protocol can't do cleanly, so don't try.
- **`coga state` vs MCP `state` may differ in dedup state** — but only because the in-memory baseline is per-process. The on-disk baseline at `~/.coordination/agent-state.json` (written by `AgentStateDiffer.getLastSeen()`, `packages/cli/src/agent-state-differ.ts:58`) round-trips between separate `coga` invocations, so two shell calls and an MCP call all dedup against the same history. If you see them diverge, that's a persistence bug, not a wrapping-layer bug.
- **No backwards-compat shims when this rule is broken.** If you find logic in MCP that should be in `GameClient`, move it down and delete the MCP copy — don't dual-write. The pre-launch policy in `CLAUDE.md` applies to this layer too.

## Pointers

- `packages/cli/src/mcp-tools.ts` — `registerGameTools` (line 274), `STATIC_CLI_COMMANDS` (line 62), collision check (line 152), the bare-wrapper file-top comment (lines 1-26).
- `packages/cli/src/mcp-server.ts` — `createMcpServerWithClient` (line 30); the only place that constructs `McpServer` and calls `registerGameTools`.
- `packages/cli/src/game-client.ts` — `GameClient`, the shared layer both surfaces call into.
- `packages/cli/src/agent-state-differ.ts` — the scar story, recorded in the file header.
- `packages/cli/src/commands/game.ts` — Commander command handlers; the same `GameClient` methods MCP handlers call.
- `packages/cli/src/__tests__/tool-collision.test.ts` — collision-check coverage; exercises `registerGameTools` against a stub `McpServer`.
- `wiki/architecture/plugin-pipeline.md` — why the plugin pipeline must live inside the CLI process.
- `wiki/architecture/agent-envelope.md` — what the differ is doing, and why it has to be at the `GameClient` layer.
