# Bot System

Bots use Claude Haiku via the Agent SDK with in-process MCP.

## Architecture

1. Server creates bot via `createSdkMcpServer()` + `tool()` from Agent SDK
2. Each MCP tool calls `GameClient` methods → REST API (same path as real players)
3. Bots authenticate with their own ephemeral wallet via the standard ERC-8004 challenge-response flow — same code path as real players, no auth bypass
4. Sessions persist via Agent SDK `resume` — bots remember strategy across turns
5. System prompt is generic. Game knowledge comes from `get_guide()`, not hardcoded rules.

## Key Design Decisions

- **Same pipeline as real players** — bots go through GameClient → REST → pipeline. No shortcuts.
- **Haiku for cost** — bots are cheap. Turn interval is 8 seconds.
- **Generic bot harness** — `getPlayersNeedingAction(state)` lets the engine schedule bot turns for any game. No game-specific bot code needed.

## Spawning Bots

Three dev test flows, all in `scripts/`:

- **`setup-bot-pool.ts`** — one-time. Creates 8 persistent bot wallets, registers + faucets them, writes `~/.coordination/bot-pool.json`.
- **`fill-bots.ts <lobbyId> [count]`** — the game-designer workflow. You join a lobby yourself, run this, it joins pool bots into the remaining seats and spawns `claude --print` per bot. Bots discover the per-phase tool list from `get_state.currentPhase.tools` and call each tool by name (`propose_team`, `accept_team`, `choose_class`, `move`, `propose_pledge`, `submit_decision`, `chat`). No game-specific harness code.
- **`run-game.ts`** — full E2E. Spawns ephemeral wallets, creates a lobby, joins everyone, hands off to Claude. Same generic driver as fill-bots.
- **`spawn-bots.sh`** — older script that exposes `coga serve --http` for manual MCP connection. Use when you want to drive bots from your own Claude session, not automated.

The lobby UI also has a "Fill Bots" button (admin password protected) that triggers bot creation server-side.

All client-driven scripts share `scripts/lib/bot-agent.ts` (auth, pool persistence, `runClaudeAgent`).

## Tool Surface

Post unified-tool-surface cutover, there is no `submit_move` / `lobby_action` passthrough. Every player-callable action is a named MCP tool with its own JSON schema — the agent picks the right tool for the current phase and passes its args directly. Dispatch goes through the single `POST /api/player/tool { toolName, args }` endpoint.

Errors from the dispatcher are structured so a Haiku bot can self-correct without human intervention:

- `UNKNOWN_TOOL` — not in this session's registry. Includes `validToolsNow[]`.
- `WRONG_PHASE` — declared elsewhere. Includes `currentPhase` and `validToolsNow[]`.
- `INVALID_ARGS` — shape mismatch. Includes `fieldErrors[]`.
- `VALIDATION_FAILED` — shape OK, semantics rejected (e.g. move out of range). Includes the validator's message.

See `docs/plans/unified-tool-surface.md` for the full error taxonomy. The `INITIAL_PROMPT` in `scripts/lib/bot-agent.ts` teaches the bot to recognise these codes and react.

## Bot Auth

Bots use the same ERC-8004 challenge-response flow as real players. Each bot has its own wallet (ephemeral in `run-game.ts` / `spawn-bots.sh`, persistent in `~/.coordination/bot-pool.json` for `fill-bots.ts`) and `GameClient` auto-authenticates before the first API call.

This is load-bearing: there is no bot-specific auth bypass anywhere on the server. Any future auth hardening (rate limits, signature replay protection, registration gating) covers bots automatically because they traverse the same code path.
