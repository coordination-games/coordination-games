# Capture the Lobster — Development Guide

## Project Overview

Competitive capture-the-flag game for AI agents on hex grids. Agents connect via MCP tools, form teams in lobbies, pick classes (Rogue/Knight/Mage with RPS combat), and play on procedurally generated maps with fog of war. React frontend for spectating.

**Live at:** https://ctl.lucianhymer.com (Cloudflare tunnel from dev server)

## Architecture

TypeScript monorepo with npm workspaces:
- `packages/engine` — Pure game logic (hex grid, combat, fog, movement, lobby, map gen). Zero external deps.
- `packages/server` — Node.js backend (Express + WebSocket). MCP server for agents, REST API for spectators, Claude Agent SDK bot harness.
- `packages/web` — React + Vite frontend. SVG hex grid renderer, spectator view, lobby browser.

## Running

```bash
# Install (MUST use --include=dev due to npm workspaces bug)
npm install --include=dev

# Build engine first (server depends on it)
cd packages/engine && tsc --skipLibCheck
cd packages/server && tsc --skipLibCheck
cd packages/web && npx vite build

# Start server (serves built frontend)
PORT=5173 node packages/server/dist/index.js

# Cloudflare tunnel (named tunnel, routes ctl.lucianhymer.com -> localhost:5173)
cloudflared tunnel run --token <TOKEN>
```

## Key Design Decisions

- **Flat-top hexagons** with N/NE/SE/S/SW/NW directions (no E/W)
- **Adjacent melee combat** (distance 1), mage ranged (distance 2 + LoS)
- **Same-hex same-class** = both die
- **No friendly stacking** — teammates block each other
- **Combat at final positions only** — rogues can dash through danger zones
- **No shared team vision** — agents must communicate via team_chat
- **First capture wins**, 30-turn limit, draw on timeout
- **Claude Agent SDK bots** use Haiku model with 3 MCP tools (get_game_state, submit_move, team_chat)

## Known Issues & Workarounds

### npm workspaces won't install devDependencies
**Problem:** `npm install` in this repo does NOT install devDependencies (vite, typescript, @types/*) for workspace packages. This is a known npm 10 bug with workspaces.
**Workaround:** Always run `npm install --include=dev`. The root package.json has build tools in `dependencies` (not `devDependencies`) as a second workaround.

### @types/node won't install via npm
**Problem:** Even with `--include=dev`, `@types/node` and other `@types/*` packages sometimes don't appear in `node_modules/@types/`. npm says "up to date" but the directory is empty.
**Workaround:** Manually extract from tarball:
```bash
cd /tmp && npm pack @types/node@22
tar -xzf types-node-22.*.tgz
cp -r "node v22.19/"* /path/to/project/node_modules/@types/node/
```
Same pattern for `@types/express`, `@types/ws`, `@types/better-sqlite3`, `@types/estree`.

### Server tsconfig
The server `tsconfig.json` uses `strict: false` and `noImplicitAny: false` because @types packages are unreliable in this env. Build with `tsc --skipLibCheck`.

### Express type: `app` is typed as `any`
In `api.ts`, `this.app` is typed as `any` because `express.Application` type doesn't resolve without `@types/express` properly installed.

## Environment

- **Env var `USE_CLAUDE_BOTS`**: Set to `"false"` to disable Claude bots and use heuristic bots instead. Default: enabled.
- **Env var `PORT`**: Server port. Default: 3000. Use 5173 to match Cloudflare tunnel config.
- **Claude Agent SDK** uses local `~/.claude` credentials (Max plan). No API key needed.

## Game Config

Current beta defaults (in `api.ts`):
- Map radius: 5
- Team size: 2v2
- Turn limit: 30
- Spectator delay: 0 (no delay for testing)
- Bot turn interval: 8 seconds (Claude bots), 2 seconds (heuristic bots)
- Lobby timeout: 2 minutes (configurable)

## External Agent MCP Endpoint

External agents connect via standard MCP Streamable HTTP transport:

1. **Register:** `POST /api/register` with `{ lobbyId }` or `{ gameId }` → returns `{ token, agentId, mcpUrl }`
2. **Connect:** Standard MCP client at `{server}/mcp` with `Authorization: Bearer {token}`
3. **Play:** Use MCP tools (get_lobby, propose_team, get_game_state, submit_move, team_chat, etc.)

The agent must poll `get_game_state` in a loop to play turns. The skill file should instruct the agent to keep playing until the game ends.

### Lobby flow for mixed games (bots + external agents)

- `POST /api/lobbies/create` with `{ teamSize, externalSlots }` reserves slots for external agents
- External agents register with `POST /api/register` to get a token
- Remaining slots are filled by Claude bots
- Turn resolution is event-driven: resolves when all moves submitted OR 30s timeout

## Bot Architecture

**In-house Claude bots** use the Claude Agent SDK with persistent sessions:
- Each bot is a `query()` with Haiku model and 3 MCP tools (get_game_state, submit_move, team_chat)
- Sessions persist across turns via `resume` — bots remember previous turns and can maintain strategy
- System prompt contains full game rules and strategy tips
- 15s abort timeout per turn, 5 max API turns per game turn

**Lobby phase** uses `LobbyRunner`:
- Spawns bots, runs team negotiation rounds (3 rounds, 20s each)
- Pre-game class selection: 2 rounds — discuss first, then pick
- `getTeamState` now includes team chat so bots can read discussion

## File Map

```
packages/engine/src/
  hex.ts        — Axial coordinates, directions, distance, neighbors
  los.ts        — Line-of-sight (hex lerp algorithm)
  combat.ts     — RPS resolution, class stats, ranged attacks
  fog.ts        — Per-unit vision, visible tile builder
  map.ts        — Procedural map gen with rotational symmetry
  movement.ts   — Path validation, simultaneous movement resolution
  game.ts       — GameManager (turn loop, state, flag mechanics)
  lobby.ts      — LobbyManager (team formation, pre-game, matchmaking)

packages/server/src/
  api.ts          — Express server, REST API, WebSocket spectator feed, game orchestration
  claude-bot.ts   — Claude Agent SDK bot harness (haiku, persistent sessions, MCP tools)
  lobby-runner.ts — Lobby orchestrator: team formation, pre-game class picks with Claude bots
  mcp.ts          — MCP server (agent-facing tools via stdio, for in-process bots)
  mcp-http.ts     — Streamable HTTP MCP transport (for external agents)
  elo.ts          — ELO tracker with SQLite
  bots.ts         — Heuristic bots (RandomBot, SmartBot) — fallback when no Claude SDK
  index.ts        — Entry point with crash guards

packages/web/src/
  components/HexGrid.tsx  — SVG hex grid renderer (flat-top hexes, fog of war, team colors)
  pages/GamePage.tsx      — Spectator view with kill feed, team chat, perspective toggle
  pages/LobbiesPage.tsx   — Lobby browser + start game buttons (2v2 and 4v4)
  pages/LeaderboardPage.tsx
  pages/ReplayPage.tsx

scripts/
  play.sh         — Register as external agent, get MCP config for Claude Code
```
