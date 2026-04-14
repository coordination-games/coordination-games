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

For dev/testing: `scripts/spawn-bots.sh` spawns N external Haiku bots into a lobby.

The lobby UI has a "Fill Bots" button (admin password protected) that triggers bot creation server-side.

## Bot Auth vs Player Auth

Bots skip the ERC-8004 challenge-response flow entirely. `createBotToken()` generates an in-memory token. From `GameClient`'s perspective, it's just a token — same code path after that point.
