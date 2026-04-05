# Generic Bot Harness — Spec

## Goal

Any game on the platform gets test bots for free. Bots connect via the same MCP endpoint as external agents — they don't know what game they're playing until they read the guide.

---

## Two Bot Types

### 1. Claude Bots (Haiku)

AI-powered bots using Claude Haiku via the Agent SDK. They read the game guide, understand the rules, form strategies, and communicate with teammates.

**How they work today (CtL-specific):**
- Hardcoded system prompt with CtL rules, hex grid, class strategy
- 3 in-process MCP tools (`get_state`, `submit_move`, `chat`) wired directly to `GameSession`
- CtL-specific bot harness in `claude-bot.ts`

**How they should work (game-generic):**
- Connect to the standard MCP endpoint at `{server}/mcp` with a bot auth token
- Call `get_guide()` on first turn — this IS the system prompt (game rules, available tools, strategy)
- Use the same tools any external agent uses (`get_state`, `submit_move`, `chat`, `wait_for_update`)
- System prompt is just: "You are a game-playing agent. Call get_guide() to learn the rules, then play."

**Architecture:**
```
Bot Harness (generic)
  ├── Creates auth token for bot
  ├── Connects to MCP endpoint (same as external agents)
  ├── Calls get_guide() → injects as system context
  ├── Loop: wait_for_update → decide → submit_move
  └── Claude Haiku handles strategy via Agent SDK
```

**What changes from current:**
- Remove hardcoded CtL system prompt from `claude-bot.ts`
- Remove in-process MCP server creation — connect to the real endpoint
- The `createGameMcpServer()` function is deleted entirely
- Bot harness becomes ~40 lines: create token, connect, query with "play the game"
- Game-specific knowledge comes from `get_guide()`, not from code

### 2. Heuristic Bots (No AI)

Random-move bots for load testing and game loop verification. No Claude API calls. Instant.

**How they work:**
1. Connect to MCP endpoint
2. Call `get_guide()` — parse available move types (not needed for random play)
3. Each turn: call `get_state()`, try random valid moves until one succeeds
4. Optionally send random chat messages ("glhf", "nice move", random strings)

**Architecture:**
```
Heuristic Bot (generic)
  ├── Creates auth token for bot
  ├── Connects to MCP endpoint
  ├── Loop:
  │   ├── wait_for_update
  │   ├── get_state → extract available actions
  │   ├── Pick random action, call submit_move
  │   ├── If rejected, try another random action (max 5 attempts)
  │   └── If all fail, submit empty move (pass/stay)
  └── No AI, no API calls, instant turns
```

**Implementation:** ~50 lines. The key insight is that `submit_move` with `validateMove` tells you if a move is valid — so you just try random moves until one works. For CtL, random moves are random direction paths up to speed. For tic-tac-toe, random empty cells. The bot doesn't need to know the game — it just needs to try moves.

---

## Server-Side Changes

### Bot Registration

Bots need auth tokens like external agents. Options:
1. **Internal tokens** — server generates tokens for bots without the `/api/register` flow
2. **Self-register** — bots call the same register endpoint as external agents

Option 1 is simpler and what we do today (bots get implicit auth). Keep it.

### Bot Lifecycle

```
Lobby created
  → fill-bots requested
  → Server creates N bot instances (Claude or heuristic, configurable)
  → Each bot gets an auth token + MCP connection
  → Bots join lobby, negotiate teams, pick classes (via MCP tools)
  → Game starts
  → Each turn: bots receive state via wait_for_update, submit moves
  → Game ends, bots disconnect
```

### Turn Timing

- Claude bots: 15s timeout per turn (API latency)
- Heuristic bots: <100ms per turn (no API call)
- Mixed: some Claude + some heuristic for testing

---

## What Builders Get

When you register a new `CoordinationGame`, you automatically get:
- Claude Haiku bots that read your `get_guide()` and play intelligently
- Heuristic bots that randomly explore your move space
- A `fill-bots` endpoint that populates lobbies for testing
- E2E game loop verification without any bot-specific code

No game-specific bot code needed. Your `get_guide()` output IS the bot's brain.

---

## Implementation Status

- [x] **Refactor `claude-bot.ts`** — Game-generic, connects via real MCP HTTP endpoint with configurable URL (defaults to `http://localhost:${PORT}/mcp`). Uses `get_guide()` for game rules instead of hardcoded system prompts.
- [x] **Update `lobby-runner.ts`** — Bots get pre-registered auth tokens via `createBotToken()`, connect via MCP HTTP endpoint during lobby and pre-game phases.
- [x] **Update `mcp-http.ts`** — Added `createBotToken()` for internal bot auth. Bearer token pre-binding so bots don't need to call `signin()`.
- [x] **Configurable server URL** — `GAME_SERVER_URL` env var or constructor parameter, passed through lobby-runner and api.ts.
- [ ] **Add `heuristic-bot.ts`** — Simple random-move bot, no AI. For load testing and game loop verification.
- [ ] **Test with a minimal game** — Create a trivial game (coin flip? rock-paper-scissors?) to verify bots work game-generically
