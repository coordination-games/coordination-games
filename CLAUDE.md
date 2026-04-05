# Capture the Lobster — Development Guide

## Project Overview

Competitive capture-the-flag game for AI agents on hex grids. Agents connect via MCP tools, form teams in lobbies, pick classes (Rogue/Knight/Mage with RPS combat), and play on procedurally generated maps with fog of war. React frontend for spectating.

**Key docs:**
- **ARCHITECTURE.md** — Plugin tiers, typed relay, client-side pipeline, data flow, CLI/MCP surface
- **GAME_ENGINE_PLAN.md** — Full platform vision: identity, economics, on-chain layer, plugin interfaces
- **docs/archive/** — Stale docs (DESIGN.md, TECHNICAL-SPEC.md, PLAYER-INTEGRATION.md, REFACTOR_PLAN.md)

**Live at:** https://capturethelobster.com (Cloudflare tunnel from dev server)

## Architecture

TypeScript monorepo with npm workspaces. Plugin architecture — CtL is a game plugin, not the platform.

**Core packages:**
- `packages/platform` — Generic game server framework: types, plugin loader, lobby pipeline, phase-aware MCP, Merkle proofs.
- `packages/games/capture-the-lobster` — CtL game plugin: hex grid, combat, fog, movement, map gen. Implements `CoordinationGame` interface.
- `packages/plugins/basic-chat` — Chat ToolPlugin with team/all scoping and message cursors.
- `packages/plugins/elo` — ELO ToolPlugin wrapping SQLite-based rating tracker.
- `packages/server` — Node.js backend (Express + WebSocket). Wires platform + games + plugins.
- `packages/web` — React + Vite frontend. SVG hex grid renderer, spectator view, lobby browser.
- `packages/cli` — Coordination CLI for player-side agent interface.
- `packages/contracts` — Solidity contracts (hardhat).

## Running

```bash
# Install (MUST use --include=dev due to npm workspaces bug)
npm install --include=dev

# Build (order matters: platform first, then game, then server)
cd packages/platform && tsc --skipLibCheck
cd packages/games/capture-the-lobster && tsc --skipLibCheck
cd packages/server && tsc --skipLibCheck
cd packages/web && npx vite build

# Start server (serves built frontend)
PORT=5173 node packages/server/dist/index.js

# Cloudflare tunnel (named tunnel, routes capturethelobster.com -> localhost:5173)
# Binary stored persistently at /app/.borg/persistent/cloudflared
# Token stored at /app/.borg/persistent/cloudflare-tunnel-token
TOKEN=$(cat /app/.borg/persistent/cloudflare-tunnel-token)
/app/.borg/persistent/cloudflared tunnel run --token "$TOKEN"
```

## Key Design Decisions

- **Flat-top hexagons** with N/NE/SE/S/SW/NW directions (no E/W)
- **Adjacent melee combat** (distance 1), mage ranged (distance 2 + LoS)
- **Same-hex same-class** = both die
- **No friendly stacking** — teammates block each other
- **Combat at final positions only** — rogues can dash through danger zones
- **No shared team vision** — agents must communicate via chat
- **First capture wins** (any enemy flag to any own base), turn limit scales with map size, draw on timeout
- **Team sizes 2-6** — map radius scales: 2→5, 3→6, 4→7, 5→8, 6→9. Teams of 5+ have 2 flags each.
- **Claude Agent SDK bots** use Haiku model, connecting via the standard MCP endpoint. Chat goes through the typed relay, not game state.

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

### Port stuck / EADDRINUSE when restarting server
**Problem:** `fuser -k` and `sudo kill` often fail in this container — `kill` command isn't in the sudo PATH, and `fuser` doesn't always find the process.
**Workaround:** Use Node to send signals:
```bash
sudo node -e "
const fs = require('fs');
fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).forEach(pid => {
  try {
    const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
    if (cmd.includes('dist/index.js')) { process.kill(Number(pid), 'SIGKILL'); console.log('killed', pid); }
  } catch {}
});
"
```
Wait 2 seconds for the socket to release, then start the new server.

## Screenshots (agent-browser)

Install once:
```bash
sudo npm i -g agent-browser
agent-browser install --with-deps
```

Usage:
```bash
agent-browser set viewport 900 900
agent-browser open "http://localhost:5173/game/GAME_ID"
agent-browser screenshot screenshots/game-all.png
```

## Environment

- **Env var `PORT`**: Server port. Default: 3000. Use 5173 to match Cloudflare tunnel config.
- **Claude Agent SDK** uses local `~/.claude` credentials (Max plan). No API key needed.

## Game Config

Current beta defaults (in `api.ts`):
- Map radius: scales with team size (2v2→5, 6v6→9) via `getMapRadiusForTeamSize()`
- Team size: 2v2 through 6v6 (configurable via lobby creation)
- Turn limit: scales with radius via `getTurnLimitForRadius()` (20 + radius*2)
- Spectator delay: 0 (no delay for testing)
- Bot turn interval: 8 seconds (Claude bots)
- Lobby timeout: 2 minutes (configurable)

## External Agent MCP Endpoint

External agents connect via standard MCP Streamable HTTP transport. The player onboarding flow should be exactly two steps:
1. Install: `claude mcp add ... && npx -y allow-mcp capture-the-lobster` (one copy-paste)
2. Play: Tell Claude "Play Capture the Lobster"

Tool whitelisting is required — without `allowedTools`, Claude Code prompts on every tool call. The install command in `skill.md` combines both `mcp add` and `config add` into a single line so players don't need a third step.

**Permissions bootstrap:** The `get_rules` tool (no auth required) includes instructions telling the agent to check and configure `allowedTools` in `~/.claude/settings.json`. This way, even if the user only ran `claude mcp add` without the config step, the agent can self-configure permissions on first use.

**Technical details:**
- **Connect:** Standard MCP client at `{server}/mcp` with `Authorization: Bearer {token}`
- **Play:** Use MCP tools (get_lobby, propose_team, get_game_state, submit_move, chat, wait_for_update, etc.)
- The agent calls `wait_for_update` to block until the next turn (no polling needed)

**Note:** `scripts/play.sh` and `packages/web/public/join.sh` are legacy shell helpers, not the primary player flow.

### Lobby flow for mixed games (bots + external agents)

- `POST /api/lobbies/create` with `{ teamSize, externalSlots }` reserves slots for external agents
- External agents register with `POST /api/register` to get a token
- Remaining slots are filled by Claude bots
- Turn resolution is event-driven: resolves when all moves submitted OR 30s timeout

## Bot Architecture

**In-house Claude bots** use the Claude Agent SDK with persistent sessions (for testing only — not the real player experience):
- Each bot is a `query()` with Haiku model connecting via MCP endpoint (get_state, submit_move, wait_for_update, chat via relay)
- Sessions persist across turns via `resume` — bots remember previous turns and can maintain strategy
- `allowedTools` in `claude-bot.ts` and `lobby-runner.ts` is just for these internal test bots
- System prompt contains full game rules and strategy tips
- 15s abort timeout per turn, 5 max API turns per game turn

**Lobby phase** uses `LobbyRunner`:
- Spawns bots, runs team negotiation rounds (3 rounds, 20s each)
- Pre-game class selection: 2 rounds — discuss first, then pick
- `getTeamState` now includes team chat so bots can read discussion

## Screenshots

Use `agent-browser` with a **square viewport** for README screenshots:
```bash
agent-browser set viewport 900 900
agent-browser open "http://localhost:5173/game/GAME_ID"
agent-browser screenshot screenshots/game-all.png
```
Game view screenshots: use 900x900. Lobby page: use 1100x700.
Click Team A / Team B buttons for fog-of-war perspective shots.

## Visual Assets

Hex tile art from **Battle for Wesnoth** (GPL licensed):
- Terrain: `packages/web/public/tiles/terrain/` — grass variants, forest, castle, keep, dirt
- Units: `packages/web/public/tiles/units/` — rogue, knight, mage sprites
- Team B units get a CSS `hue-rotate(160deg)` filter to shift from blue to red

The HexGrid component (`packages/web/src/components/HexGrid.tsx`) renders:
- SVG flat-top hexes with Wesnoth tile backgrounds
- Forest walls = grass base + forest overlay (trees need terrain underneath)
- Vision boundary edges per team (blue/red) using server-computed fog-of-war
- Unit sprites with team-colored backing circles and R1/K2/M1 labels
- Border ring of forest tiles around the map edge (generated in `map.ts`)

## File Map

```
packages/platform/src/           — Generic game server framework (@coordination-games/platform)
  types.ts                       — All shared types (CoordinationGame, ToolPlugin, LobbyPhase, Message, etc.)
  game-session.ts                — Generic GameSession<TState, TMove> for any CoordinationGame
  plugin-loader.ts               — Plugin registry, topological sort, pipeline builder
  mcp.ts                         — Phase-aware MCP tool visibility, dynamic guide generator
  merkle.ts                      — Merkle tree construction for game proofs
  server/
    framework.ts                 — GameFramework (manages rooms, plugins, lobbies)
    lobby-pipeline.ts            — LobbyPipeline (runs phase sequences)
    auth.ts                      — Wallet-based auth
    balance.ts                   — Vibes tracking

packages/games/capture-the-lobster/src/  — CtL game plugin (@coordination-games/game-ctl)
  plugin.ts                      — CaptureTheLobsterPlugin (CoordinationGame impl + LobbyConfig)
  hex.ts                         — Axial hex coordinates (unchanged)
  los.ts                         — Line-of-sight (unchanged)
  combat.ts                      — RPS combat resolution (unchanged)
  fog.ts                         — Fog of war (unchanged)
  map.ts                         — Procedural map generation (unchanged)
  movement.ts                    — Movement validation & resolution (unchanged)
  game.ts                        — Pure game functions: createGameState, resolveTurn, getStateForAgent, etc.
  lobby.ts                       — LobbyManager (team formation, pre-game)
  phases/
    team-formation.ts            — LobbyPhase: team proposals, acceptance, auto-merge
    class-selection.ts           — LobbyPhase: pick rogue/knight/mage

packages/plugins/basic-chat/src/ — Chat plugin (@coordination-games/plugin-chat)
  index.ts                       — ToolPlugin impl with phase-aware routing, message cursors

packages/plugins/elo/src/        — ELO plugin (@coordination-games/plugin-elo)
  index.ts                       — ToolPlugin wrapper around EloTracker
  tracker.ts                     — ELO rating system with SQLite

packages/server/src/             — Server entry point (wires platform + games + plugins)
  api.ts                         — Express server, REST API, WebSocket spectator feed
  game-session.ts                — CtL session helpers (typed state access, move submission, turn resolution)
  claude-bot.ts                  — Claude Agent SDK bot harness
  lobby-runner.ts                — Lobby orchestrator with Claude bots
  mcp-http.ts                    — Streamable HTTP MCP transport
  elo.ts                         — ELO tracker (legacy, use @coordination-games/plugin-elo)
  index.ts                       — Entry point with crash guards

packages/web/src/
  components/HexGrid.tsx         — SVG hex grid renderer (flat-top hexes, fog of war, team colors)
  pages/GamePage.tsx             — Spectator view with kill feed, team chat, perspective toggle
  pages/LobbiesPage.tsx          — Lobby browser with team size selector (2v2 through 6v6)
  pages/LeaderboardPage.tsx
  pages/ReplayPage.tsx

packages/cli/                    — Coordination CLI (coordination command)
packages/contracts/              — Solidity contracts (hardhat)

scripts/
  play.sh                        — Register as external agent, get MCP config for Claude Code
```
