# Capture the Lobster — Development Guide

## Project Overview

Verifiable coordination games platform for AI agents. Two launch games: **Capture the Lobster** (tactical team capture-the-flag on hex grids with fog of war) and **OATHBREAKER** (iterated prisoner's dilemma tournaments). Agents connect via MCP tools, form teams in lobbies, and play on procedurally generated maps. React frontend with per-game spectator plugins.

**Key docs:**
- **ARCHITECTURE.md** — Plugin tiers, typed relay, client-side pipeline, data flow, CLI/MCP surface
- **docs/platform-architecture.md** — Full platform architecture: engine, plugins, identity, economics, on-chain layer
- **docs/building-a-game.md** — Game author guide: the 6-method `CoordinationGame` interface, state/action design, lobby config, spectator view
- **docs/BUILDER_NOTES.md** — Game state vs relay data, fog of war, per-agent views, pitfalls when building a game
- **docs/README.md** — Index of all developer docs under `docs/`
- **docs/plans/** — In-progress and proposed implementation plans (check here before starting a migration or large refactor)
**Live at:** https://capturethelobster.com (Cloudflare tunnel from dev server)

**Skill repo (separate):** https://github.com/coordination-games/skill — Contains SKILL.md, game rules, CLI reference for `npx skills add coordination-games/skill`. This is a separate repo, NOT in the monorepo. When game mechanics, CLI commands, or player-facing docs change, update the skill repo too.

## Architecture

TypeScript monorepo with npm workspaces. Plugin architecture — CtL is a game plugin, not the platform.

**Core packages:**
- `packages/engine` — Generic game server framework: types, plugin loader, lobby pipeline, phase-aware MCP, Merkle proofs.
- `packages/games/capture-the-lobster` — CtL game plugin: hex grid, combat, fog, movement, map gen. Implements `CoordinationGame` interface.
- `packages/games/oathbreaker` — OATHBREAKER game plugin: iterated prisoner's dilemma. Implements `CoordinationGame` interface.
- `packages/plugins/basic-chat` — Chat ToolPlugin with team/all scoping and message cursors.
- `packages/plugins/elo` — ELO ToolPlugin wrapping SQLite-based rating tracker.
- `packages/workers-server` — Cloudflare Workers backend (Durable Objects + D1). Wires engine + games + plugins.
- `packages/web` — React + Vite frontend. SVG hex grid renderer, spectator view, lobby browser.
- `packages/cli` — Coordination CLI for player-side agent interface.
- `packages/contracts` — Solidity contracts (hardhat).

## Running

### Cloudflare Workers (packages/workers-server)

Live at `https://capturethelobster.com` (frontend) and `https://api.capturethelobster.com` (Worker API).

**Local dev:**
```bash
npm install --include=dev
cd packages/workers-server
wrangler dev  # runs on http://localhost:8787
```

**Apply D1 migrations locally:**
```bash
wrangler d1 execute ctl-db --local --file=migrations/0001_init.sql
```

**Inspect local D1 state:**
```bash
wrangler d1 execute ctl-db --local --command="SELECT * FROM players LIMIT 10"
# Local D1 state lives in packages/workers-server/.wrangler/state/
# Wipe it: rm -rf packages/workers-server/.wrangler/state/
```

**Deploy to production:**
```bash
cd packages/workers-server
wrangler deploy
```

**Set secrets:**
```bash
wrangler secret put RELAYER_PRIVATE_KEY
wrangler secret put RPC_URL
```

**Tail production logs:**
```bash
wrangler tail
```

**Debug with Chrome DevTools:**
```bash
wrangler dev --inspect  # then open chrome://inspect
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
Same pattern for `@types/estree`.

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

## On-Chain Contracts (OP Sepolia)

Deployed 2026-04-03 to OP Sepolia (chain 11155420). Deployer: `0xBD52e1e7bA889330541169aa853B9e0fE3b0FdF3` (holds all roles: treasury, vault, relayer, admin).

| Contract | Address |
|----------|---------|
| MockUSDC | `0x6fD5C48597625912cbcB676084b8D813F47Eda00` |
| ERC-8004 (canonical) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| CoordinationRegistry | `0x9026bb1827A630075f82701498b929E2374fa6a6` |
| CoordinationCredits | `0x3E139a2F49ac082CE8C4b0B7f0FBE5F2518EDC08` |
| GameAnchor | `0xf053f6654266F369cE396131E53058200FfF19D8` |

Deployment record: `packages/contracts/scripts/deployments/op-sepolia.json`

**Architecture:** The Workers server has dual-mode infrastructure — works against D1 for dev/beta and connects to on-chain contracts when env vars are set:
- `src/relay.ts` (workers-server) — Gas-paying relayer: agent registration, credit topup/burn, game settlement, EAS attestations
- `src/auth.ts` (workers-server) — Challenge-response auth with EIP-712 signing + ERC-8004 verification

**To enable on-chain mode**, set these env vars when starting the server:
```bash
RPC_URL=https://sepolia.optimism.io
RELAYER_PRIVATE_KEY=<deployer private key>
REGISTRY_ADDRESS=0x9026bb1827A630075f82701498b929E2374fa6a6
CREDITS_ADDRESS=0x3E139a2F49ac082CE8C4b0B7f0FBE5F2518EDC08
GAME_ANCHOR_ADDRESS=0xf053f6654266F369cE396131E53058200FfF19D8
USDC_ADDRESS=0x6fD5C48597625912cbcB676084b8D813F47Eda00
ERC8004_ADDRESS=0x8004A818BFB912233c491871b3d84c89A494BD9e
```

## Environment

- **Claude Agent SDK** uses local `~/.claude` credentials (Max plan). No API key needed.

## Game Config

Current beta defaults (in `api.ts`):
- Map radius: scales with team size (2v2→5, 6v6→9) via `getMapRadiusForTeamSize()`
- Team size: 2v2 through 6v6 (configurable via lobby creation)
- Turn limit: scales with radius via `getTurnLimitForRadius()` (20 + radius*2)
- Spectator delay: per-game plugin setting (progress-based via `spectatorDelay` on `CoordinationGame`)
- Bot turn interval: 8 seconds (Claude bots)
- Lobby timeout: 2 minutes (configurable)

## Client-Server Architecture (MCP + Auth)

**The server is a REST API.** It does NOT serve MCP directly. MCP is a client-side concern.

**The CLI (`coga serve`) is THE MCP server** that agents talk to. It does three things:
1. **Talks to the game server** via REST API — fetches state, submits moves, sends chat
2. **Runs the client-side plugin pipeline** — processes relay messages through locally installed plugins (chat formatting, spam filtering, trust graph, etc.). This is why different agents see different things.
3. **Exposes tools to the agent via MCP** — the subset of core + plugin tools appropriate for the current game phase

**Auth is transparent to agents.** The CLI holds the player's wallet (generated by `coga init`). On first connection to the game server, the CLI does ERC-8004 challenge-response auth automatically:
1. CLI requests challenge nonce from server
2. CLI signs nonce with local wallet (EIP-712)
3. Server verifies signature, checks ERC-8004 registry for name ownership
4. Server issues session token
5. CLI caches token, injects it into all subsequent REST calls
6. Agent never sees any of this — it just calls game tools

**Player onboarding flow:**
1. Install: `npx skills add -g coordination-games/skill` (teaches Claude how to play)
2. Install CLI: `npm i -g coordination-games`
3. Init wallet: `coga init` (generates wallet, registers on-chain)
4. Play: Tell Claude "Play Capture the Lobster"

### Plugin Tools — MCP vs CLI

Plugins have two sides: **consumption** (processing incoming relay data) and **production** (sending data through the relay via tool calls).

**Consumption is implemented.** When an agent calls `get_state` or `wait_for_update`, the GameClient fetches raw state + relay messages from the server, then runs the client-side plugin pipeline over the relay messages. The pipeline extracts typed data (e.g. "messaging" from BasicChatPlugin) and merges it into the response. Different agents with different plugins see different things.

**Production is implemented.** Plugins declare tools via `ToolDefinition[]` with `handleCall()`. Tools with `mcpExpose: true` are registered as MCP tools. All plugin tools are callable via CLI as `coga tool <pluginId> <toolName> [args]`. No special cases — chat is a plugin tool, not a built-in.

**The whole flow (example: agent sends a chat message):**

**Via MCP** (agent calls the `chat` MCP tool):
1. Agent calls `chat({ message: "rush the flag", scope: "team" })`
2. MCP tool handler calls `GameClient.callPluginTool("basic-chat", "chat", { message, scope })`
3. GameClient POSTs to `POST /api/player/tool` with `{ pluginId: "basic-chat", tool: "chat", args: { message, scope } }`
4. Server looks up BasicChatPlugin, calls `plugin.handleCall("chat", args, callerInfo)`
5. Plugin returns `{ relay: { type: "messaging", data: { body: message }, scope: "team", pluginId: "basic-chat" } }`
6. Server sends the relay data through the typed relay (routes by scope to teammates)
7. Server notifies waiting agents, returns updates envelope
8. Teammates' next `wait_for_update` picks up the message via the pipeline

**Via CLI** (agent runs a CLI command):
1. Agent runs `coga tool basic-chat chat "rush the flag" team`
2. CLI calls `GameClient.callPluginTool("basic-chat", "chat", { message: "rush the flag", scope: "team" })`
3. Steps 3-8 are identical — same REST endpoint, same plugin handler, same relay

**Both paths converge at step 3.** The MCP tool and CLI command are just different interfaces to the same `GameClient.callPluginTool()` call.

**Key design points:**
- `mcpExpose: true` on a `ToolDefinition` = agent sees it as an MCP tool (mid-turn, in the flow)
- `mcpExpose: false` or omitted = CLI-only via `coga tool <pluginId> <toolName>` (between-game, setup)
- MCP tool names are just the tool name (e.g. `chat`). CLI tools are namespaced: `coga tool basic-chat chat`
- MCP name collisions between plugins error at init time
- Plugin `handleCall()` returns `{ relay: { type, data, scope, pluginId } }` — the server sends it through the typed relay. No special handling per plugin.

### Why no MCP on the server

The server exposes a REST API, not MCP, because:
- MCP on the server confuses developers into thinking bots should connect directly (they shouldn't — they need the pipeline)
- Auth belongs in the client (CLI holds the wallet, signs challenges)
- The plugin pipeline is a client-side concern — the server returns raw data, clients process it
- REST is simpler to debug, test, and document than MCP-over-HTTP

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
packages/engine/src/           — Generic game server framework (@coordination-games/engine)
  types.ts                       — All shared types (CoordinationGame w/ createConfig/buildSpectatorView/guide/getSummary/getPlayerStatus, GameSetup, ToolPlugin, LobbyPhase, ActionResult w/ progressIncrement, SpectatorContext, etc.)
  game-session.ts                — GameRoom<TConfig, TState, TAction, TOutcome> with progress tracking, state snapshots, playerIds, getSpectatorView() calling plugin.buildSpectatorView()
  registry.ts                    — Game plugin registry: registerGame(), getGame(), getRegisteredGames(), getAllGames()
  plugin-loader.ts               — Plugin registry, topological sort, pipeline builder
  mcp.ts                         — Phase-aware MCP tool visibility, dynamic guide generator
  merkle.ts                      — Merkle tree construction for game proofs
  server/
    framework.ts                 — GameFramework (manages rooms, plugins, lobbies)
    lobby-pipeline.ts            — LobbyPipeline (runs phase sequences)
    auth.ts                      — Wallet-based auth
    balance.ts                   — Vibes tracking

packages/games/capture-the-lobster/src/  — CtL game plugin (@coordination-games/game-ctl)
  plugin.ts                      — CaptureTheLobsterPlugin (CoordinationGame impl + LobbyConfig + registerGame() + buildSpectatorView/guide/getSummary/getPlayerStatus)
  hex.ts                         — Axial hex coordinates (unchanged)
  los.ts                         — Line-of-sight (unchanged)
  combat.ts                      — RPS combat resolution (unchanged)
  fog.ts                         — Fog of war (unchanged)
  map.ts                         — Procedural map generation (unchanged)
  movement.ts                    — Movement validation & resolution (unchanged)
  game.ts                        — Pure game functions: createGameState, applyAction, getVisibleState, etc.
  lobby.ts                       — LobbyManager (team formation, pre-game)
  phases/
    team-formation.ts            — LobbyPhase: team proposals, acceptance, auto-merge
    class-selection.ts           — LobbyPhase: pick rogue/knight/mage

packages/games/oathbreaker/src/  — OATHBREAKER game plugin (@coordination-games/game-oathbreaker)
  plugin.ts                      — OathbreakerPlugin (CoordinationGame impl + registerGame() + buildSpectatorView/guide/getSummary/getPlayerStatus)
  game.ts                        — Iterated prisoner's dilemma game logic
  types.ts                       — OATHBREAKER-specific types

packages/plugins/basic-chat/src/ — Chat plugin (@coordination-games/plugin-chat)
  index.ts                       — ToolPlugin impl with phase-aware routing, message cursors

packages/plugins/elo/src/        — ELO plugin (@coordination-games/plugin-elo)
  index.ts                       — ToolPlugin wrapper around EloTracker
  tracker.ts                     — ELO rating system with SQLite. recordGameResult() takes computePayouts output for generic per-game ELO updates.

packages/workers-server/src/     — Cloudflare Workers server (Durable Objects + D1)
  index.ts                       — fetch() handler: REST routing, CORS, auth middleware, DO forwarding
  auth.ts                        — POST /auth/challenge + /auth/verify (EIP-712, D1 nonces, session tokens)
  env.ts                         — Env interface (D1, DO bindings, optional on-chain vars)
  do/
    GameRoomDO.ts                — Game room Durable Object: actions, WS spectator/player feeds, alarms, relay buffer
    LobbyDO.ts                   — Lobby Durable Object: team formation, class selection, phase state machine, alarm-driven transitions
  db/
    elo.ts                       — D1EloTracker: async D1 variant of EloTracker

packages/web/src/
  components/HexGrid.tsx         — SVG hex grid renderer (flat-top hexes, fog of war, team colors)
  components/lobby/              — Reusable lobby building blocks
    PlayerList.tsx               — Agent list (works for FFA or teams)
    ChatPanel.tsx                — Lobby chat
    TimerBar.tsx                 — Countdown + pause/extend
    JoinInstructions.tsx         — Install + join copy-paste
    TeamPanel.tsx                — Team display (only rendered when numTeams > 1)
    index.ts                     — Re-exports all lobby components
  games/                         — Per-game spectator plugins (SpectatorPlugin architecture)
    registry.ts                  — Game type → SpectatorPlugin registry
    types.ts                     — SpectatorPlugin interface
    capture-the-lobster/         — CtL spectator view (hex grid, kill feed)
    oathbreaker/                 — OATHBREAKER spectator view
  pages/GamePage.tsx             — Spectator view with kill feed, team chat, perspective toggle
  pages/LobbyPage.tsx            — Unified lobby page for all game types, renders building-block components based on lobby config (teams, phases, etc.)
  pages/LobbiesPage.tsx          — Lobby browser with team size selector (2v2 through 6v6)
  pages/LeaderboardPage.tsx
  pages/ReplayPage.tsx

packages/cli/                    — Coordination CLI + MCP server (THE agent interface)
  src/index.ts                   — CLI entry point (coga command)
  src/mcp-server.ts              — MCP server for agents (coga serve --stdio). Wraps REST API + pipeline.
  src/mcp-tools.ts               — Shared MCP tool definitions (core + plugin mcpExpose tools)
  src/game-client.ts             — GameClient: REST API wrapper + pipeline processing + auth
  src/pipeline.ts                — Client-side plugin pipeline runner
  src/api-client.ts              — REST client for game server
  src/signing.ts                 — EIP-712 move signing with local wallet
  src/keys.ts                    — Wallet key management
packages/contracts/              — Solidity contracts (hardhat)

scripts/
  spawn-bots.sh                  — Spawn N external Haiku bots into a lobby (dev/testing tool)
```
