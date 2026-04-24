# Generic Bot Harness Spec

## Status: Claude Bots Done, Heuristic Bots Not Built

### Claude Bots (Implemented)
- Game-generic via Agent SDK `createSdkMcpServer()` + `tool()`
- In-process MCP backed by GameClient (REST + pipeline)
- `guide()` for game rules instead of hardcoded prompts
- `createBotToken()` for auth, sessions persist via `resume`
- Plugin tools (`mcpExpose: true`) registered dynamically

### Heuristic Bots (Not Built)
Random-move bots for load testing. No Claude API calls. ~50 lines.
- Connect to MCP, call `state()`, try random valid moves until one succeeds
- Max 5 attempts per turn, fall back to empty move (pass/stay)
- <100ms per turn vs 15s for Claude bots

### External Bots
`scripts/spawn-bots.sh` spawns N independent CLI processes, each with own wallet.
- **Note:** Script is untested end-to-end. Flow is correct in theory.
- Each bot: `COGA_DIR=/tmp/bot coga init --yes` then `coga play --lobby <id>`
- Same auth flow as human players. Server can't tell the difference.

## What Game Authors Get For Free
- Claude Haiku bots that read `guide()` and play intelligently
- Heuristic bots that randomly explore move space (when built)
- Fill-bots button in lobby UI (admin password protected)
- E2E game loop verification without game-specific bot code
