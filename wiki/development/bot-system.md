# Bot System

Bots use Claude Haiku via the Agent SDK with in-process MCP.

## Architecture

1. Server creates bot via `createSdkMcpServer()` + `tool()` from Agent SDK
2. Each MCP tool calls `GameClient` methods → REST API (same path as real players)
3. Bots get server-issued tokens (`createBotToken()`) — no wallet auth needed
4. Sessions persist via Agent SDK `resume` — bots remember strategy across turns
5. System prompt is generic. Game knowledge comes from `get_guide()`, not hardcoded rules.

## Key Design Decisions

- **Same pipeline as real players** — bots go through GameClient → REST → pipeline. No shortcuts.
- **Haiku for cost** — bots are cheap. Turn interval is 8 seconds.
- **Generic bot harness** — `getPlayersNeedingAction(state)` lets the engine schedule bot turns for any game. No game-specific bot code needed.

## Spawning Bots

Three dev test flows, all in `scripts/`:

- **`setup-bot-pool.ts`** — one-time. Creates 8 persistent bot wallets, registers + faucets them, writes `~/.coordination/bot-pool.json`.
- **`fill-bots.ts <lobbyId> [count]`** — the game-designer workflow. You join a lobby yourself, run this, it joins pool bots into the remaining seats and spawns `claude --print` per bot. Bots drive lobby phases and gameplay via the generic `lobby_action` MCP tool + `get_guide`. No game-specific harness code.
- **`run-game.ts`** — full E2E. Spawns ephemeral wallets, creates a lobby, joins everyone, hands off to Claude. Same generic driver as fill-bots.
- **`spawn-bots.sh`** — older script that exposes `coga serve --http` for manual MCP connection. Use when you want to drive bots from your own Claude session, not automated.

The lobby UI also has a "Fill Bots" button (admin password protected) that triggers bot creation server-side.

All client-driven scripts share `scripts/lib/bot-agent.ts` (auth, pool persistence, `runClaudeAgent`).

## Bot Auth vs Player Auth

Bots skip the ERC-8004 challenge-response flow entirely. `createBotToken()` generates an in-memory token. From `GameClient`'s perspective, it's just a token — same code path after that point.
