# Cloudflare Workers + D1 Migration Plan

**Status:** Phase 1 complete. Phase 2 not started.
**Audience:** Mid-level engineer picking this up cold
**Estimated effort:** 4–5 weeks (after bot removal is done on main)

---

## Goal

Migrate `packages/server` from Node.js + Express + WebSocket + in-memory state to Cloudflare Workers + Durable Objects + D1. The frontend moves to Cloudflare Pages. The on-chain relay code ports as-is.

## Non-goals

- **No in-process bots.** Bot removal is a prerequisite (see "Phase 0" below). External bots will connect as normal players via the CLI later.
- **No feature changes.** This is infrastructure-only. The game rules, plugin API, CLI, and REST contract should be identical to users.
- **No on-chain changes.** The relay contracts stay where they are on OP Sepolia.

## Codebase Research Notes

### Phase 0 Verification (confirmed complete as of 2026-04-08)
- `packages/server/src/claude-bot.ts` — deleted ✓
- `packages/web/src/components/lobby/FillBotsPanel.tsx` — deleted ✓
- All bot endpoints (`/fill-bots`, `/games/start`), imports (`runAllBotsTurn`, `createBotSessions`, `BotSession`, `createBotToken`), and `@anthropic-ai/claude-agent-sdk` dep — all gone ✓
- `packages/server/src/lobby-runner.ts` — bot methods removed, external-agents-only ✓
- `docs/external-bots.md` and `scripts/spawn-bots.sh` — exist (Phase 0.5 done) ✓
- `e2e-local.sh` — does NOT reference `/fill-bots` or `/games/start` ✓

### Merkle tree risk (Risk #2 — pre-resolved)
- `packages/engine/src/merkle.ts` uses **SHA-256** (not keccak256): `crypto.createHash('sha256')`
- `packages/contracts/contracts/GameAnchor.sol` — does NOT compute the hash; it only stores `bytes32 movesRoot` as submitted by the relayer. There is no on-chain hash mismatch today.
- **Risk #2 is a non-issue as long as the relayer submits the same SHA-256 root it always has.** Do not change the hash function during migration.

### Full REST API surface (packages/server/src/api.ts)

**Public (no auth):**
- `GET /api/framework` — server info + registered games
- `GET /api/lobbies` — list lobbies
- `GET /api/lobbies/:id` — lobby state
- `POST /api/lobbies/create` — create lobby
- `DELETE /api/lobbies/:id` — disband lobby
- `GET /api/games` — list active games
- `GET /api/games/:id` — spectator game state
- `GET /api/games/:id/state` — current state only
- `GET /api/games/:id/bundle` — full game bundle for verification
- `GET /api/games/:id/result` — result + Merkle root
- `GET /api/leaderboard` — ELO leaderboard
- `GET /api/replays/:id` — replay data
- `POST /api/player/auth/challenge` — issue nonce for wallet challenge
- `POST /api/player/auth/verify` — verify EIP-712 signature → session token
- Relay endpoints: `POST /api/relay/register`, `POST /api/relay/topup`, `GET /api/relay/faucet/:address`, `POST /api/relay/burn-request`, `POST /api/relay/burn-execute`, `POST /api/relay/settle`

**Auth-required (session token in `Authorization: Bearer <token>`):**
- `GET /api/player/guide` — dynamic playbook from game plugin
- `GET /api/player/state` — fog-filtered state for this player
- `GET /api/player/wait` — long-poll for updates (25s timeout)
- `POST /api/player/move` — submit move or lobby action
- `POST /api/player/lobby/join` — join lobby
- `POST /api/player/lobby/create` — create lobby
- `POST /api/player/team/propose` — propose team
- `POST /api/player/team/accept` — accept team invite
- `POST /api/player/team/leave` — leave team
- `POST /api/player/class` — choose class (rogue/knight/mage)
- `POST /api/player/tool` — plugin tool invocation (chat, ELO, etc.)
- `GET /api/player/leaderboard` — leaderboard (auth required)
- `GET /api/player/stats` — player's own stats

**WebSocket:**
- `GET /ws/game/:id` — spectator feed
- `GET /ws/lobby/:id` — lobby updates

### Key TypeScript interfaces (packages/server/src/api.ts)

```typescript
export interface GameRoomData {
  gameType: string;
  plugin: any;
  game: GameRoom<any, any, any, any>;
  spectators: Set<WebSocket>;
  finished: boolean;
  externalSlots: Map<string, ExternalSlot>;
  handleMap: Record<string, string>;
  relay: GameRelay;
  lobbyChat: ChatMessage[];
  preGameChatA: ChatMessage[];
  preGameChatB: ChatMessage[];
  turnTimeoutMs?: number;
}

export interface Lobby {
  id: string;
  gameType: string;
  plugin: any;
  players: { id: string; handle: string }[];
  targetPlayers: number;
  spectators: Set<WebSocket>;
  runner?: LobbyRunner;       // team games with phases
  lobbyManager?: EngineLobbyManager;
  externalSlots: Map<string, ExternalSlot>;
  createdAt: number;
}

export interface ExternalSlot {
  token: string;
  agentId: string;
  connected: boolean;
}
```

### LobbyRunner phase machine (packages/server/src/lobby-runner.ts)
```
forming (240s) → pre_game (300s) → starting → game
                                 ↘ failed
```
- Auto-merges teams on timeout
- `onGameCreated` callback fires when `starting` completes

### mcp-http.ts — NOT an MCP server
`packages/server/src/mcp-http.ts` is a **utility module only**. It provides:
- `tokenRegistry: Map<token, {agentId, name, expiresAt}>` — `TOKEN_TTL_MS = 24 * 60 * 60 * 1000`
- `handleRegistry: Map<display_name, agentId>` — persistent across sessions
- `notifyAgent()`, `waitForAgentUpdate()` — long-poll wakeups via internal Promises
- `agentMessageCursor`, `agentLastKnownTurn` — per-agent message tracking
- `getNewMessages()`, `peekNewMessages()` — cursor advancement

**In the Worker:** These in-memory maps must move to DO storage. Long-poll Promises become DO alarms.

### ELO plugin — existing SQLite schema (packages/plugins/elo/src/tracker.ts)
The D1 migration SQL in Phase 1 must match this schema:

```sql
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  elo INTEGER DEFAULT 1200,
  games_played INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  map_seed TEXT,
  turns INTEGER,
  winner_team TEXT,
  started_at TEXT,
  ended_at TEXT,
  replay_data TEXT
);

CREATE TABLE match_players (
  match_id TEXT REFERENCES matches(id),
  player_id TEXT REFERENCES players(id),
  team TEXT,
  class TEXT,
  elo_before INTEGER,
  elo_after INTEGER,
  PRIMARY KEY (match_id, player_id)
);
```

**Note:** D1 migration `0001_init.sql` in Phase 1 plan also specifies `auth_nonces` and a slightly different `players` schema. Merge carefully — preserve both `elo`/`games_played`/`wins` columns AND `wallet_address`/`created_at` columns.

### Auth flow (packages/engine/src/server/auth.ts + packages/server/src/api.ts)
- `POST /auth/challenge`: generates a random nonce, stores `{ nonce, walletAddress, expiresAt }` (TTL ~5 min), returns `{ nonce }`
- `POST /auth/verify`: reads nonce from store, verifies EIP-712 signature with ethers v6, checks ERC-8004 registry (skipped if `REGISTRY_ADDRESS` not set), issues session token stored in `tokenRegistry`
- In the Worker: nonces go to D1 `auth_nonces` table; session tokens go to DO or KV

### GameRoom — how progress/spectator delay works (packages/engine/src/game-session.ts)
- `_progressCounter`: incremented only when `ActionResult.progressIncrement === true`
- `_progressSnapshots`: state history indices at each progress point
- `getSpectatorView(delay, context)` uses `_progressSnapshots[current - delay]` to serve a delayed view
- **In the Worker:** `_stateHistory` + `_progressSnapshots` must live in DO transactional storage

### typed-relay.ts
`packages/server/src/typed-relay.ts` handles scoped relay message routing (team vs all). This is separate from `relay.ts` (on-chain relayer). Don't confuse the two. During migration, the typed relay buffer moves to DO storage.

### Packages that need Worker-compatible replacements
| Current | Replacement in Worker |
|---|---|
| `better-sqlite3` | D1 via `env.DB` binding |
| `express` | Manual `fetch()` handler + URL routing |
| `ws` | DO hibernatable WS (`state.acceptWebSocket()`) |
| `setTimeout` for timers | `state.storage.setAlarm()` |
| In-memory `Map` for games/lobbies | One DO per game/lobby |
| In-memory `tokenRegistry` | D1 `auth_nonces` table |

### Key file locations for migration implementors
```
packages/engine/src/types.ts               — CoordinationGame, GameRoom, ToolPlugin interfaces
packages/engine/src/game-session.ts        — GameRoom implementation (port to DO)
packages/engine/src/merkle.ts              — SHA-256 Merkle tree (copy as-is)
packages/engine/src/server/auth.ts         — Auth logic (port to D1 nonces)
packages/server/src/api.ts                 — Full Express server (replace with CF Worker)
packages/server/src/lobby-runner.ts        — Phase machine (port to LobbyDO alarms)
packages/server/src/mcp-http.ts            — Token/cursor/waiter utils (port to DO storage)
packages/server/src/relay.ts               — On-chain relayer (copy as-is, works in Workers)
packages/server/src/typed-relay.ts         — Scoped relay routing (port to DO storage)
packages/plugins/elo/src/tracker.ts        — SQLite ELO (needs D1 async variant)
packages/plugins/basic-chat/src/index.ts   — Chat plugin (pure, copy as-is)
```

---

## Why we're doing this

- Eliminates the "one bare server on a box" operational burden
- Scale-to-zero pricing (beta fits inside the $5/mo paid plan)
- Forces a cleaner state model — each game room becomes an isolated Durable Object, which is how we should have been thinking about it anyway
- Frontend on Pages gets global edge caching for free

---

## Prerequisite: Phase 0 — Rip out in-process bots

**This must land on `main` before starting the migration.** The bot code is deeply coupled to the in-memory server state and would fight us the entire way. It's also Workers-hostile (Claude Agent SDK won't run in a Worker).

### Files to delete entirely

- `packages/server/src/claude-bot.ts`
- `packages/web/src/components/lobby/FillBotsPanel.tsx`
- Remove the import of `FillBotsPanel` from `packages/web/src/pages/LobbyPage.tsx`
- Drop `@anthropic-ai/claude-agent-sdk` from `packages/server/package.json` dependencies

### Surgical edits in `packages/server/src/api.ts`

- Imports (top of file): remove `runAllBotsTurn`, `createBotSessions`, `BotSession`, `createBotToken`
- `GameRoomData` interface: remove `botSessions: BotSession[]` field
- Delete the `POST /lobbies/:id/fill-bots` endpoint
- Delete the `POST /games/start` admin endpoint (pure-bot game creation)
- Remove `createBotSessions()` calls in `createBotGame()` and `createGameFromLobby()`
- Remove the `runBotsGeneric()` orchestration block in the turn handler
- Remove bot-notify hooks in the player-join handler

### Surgical edits in `packages/server/src/lobby-runner.ts`

**Do NOT delete this file.** It contains the phase state machine that human players also use. Surgically remove:

- The `@anthropic-ai/claude-agent-sdk` import
- The `createBotMcpServer` import from `claude-bot.ts`
- `runBotLobbyBehavior()`, `runLobbyBot()`, `runPreGameBot()` methods
- The `addBot()` method and `BotSession` type
- Calls to bot methods from phase runners

The existing "no bots present → wait for external agents or timeout" fallback code already handles the human-only path. Verify this by running a lobby end-to-end with two real CLI players after the edit.

### Surgical edits in `packages/server/src/mcp-http.ts`

- Delete `createBotToken()` entirely
- Keep everything else (the `signin()` tool, `tokenRegistry`, `handleRegistry`, waiters — these are used by real players too)

### Auth simplification (do this in the same PR)

The wallet-based challenge/response flow becomes the **only** auth path. There is no more pre-registered-token shortcut. This simplifies tests:

- Test helpers should use `ethers.Wallet.createRandom()` to create ephemeral players, then run the normal `/auth/challenge` → sign → `/auth/verify` flow
- In dev/test mode (no `REGISTRY_ADDRESS` env var set), the server does not check ERC-8004 registration and accepts any wallet that can sign a nonce. This is already how dev mode works — verify nothing depends on the token shortcut.

### Other cleanup

- Check `scripts/e2e-local.sh` and `scripts/e2e-local.ts` — if they depend on `POST /games/start` or `/fill-bots`, rewrite them to spawn ephemeral-wallet players before deleting those endpoints
- Update `CLAUDE.md` in the repo root to remove the bot architecture sections
- Write `docs/external-bots.md` (new file) describing how to run external Haiku bots via `coga` CLI — see Phase 0.5 below

### Phase 0.5 — External bot helper (optional, not blocking migration)

Not part of the migration itself, but worth doing alongside Phase 0:

- Write `scripts/spawn-bots.sh` that takes `(lobby_id, count)` and spawns N subprocess Haiku agents using the Claude Agent SDK, each with its own `coga init`'d wallet, each joining the given lobby via normal player tools
- This replaces the old "fill with bots" button with a dev-tool script
- Document in `docs/external-bots.md`

---

## Target architecture

```
┌─────────────────────────────┐
│  Cloudflare Pages           │   ← packages/web/dist (static)
│  capturethelobster.com      │
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  Cloudflare Worker                          │
│  - Express-free fetch() handler             │
│  - Routes REST → DO or D1                   │
│  - Routes WS upgrade → DO                   │
│  - Holds on-chain relay code (ethers v6)    │
└───────┬──────────────────────┬──────────────┘
        │                      │
        ▼                      ▼
┌──────────────────┐   ┌──────────────────────┐
│ Durable Objects  │   │  D1 (SQLite)         │
│  GameRoomDO      │   │   - players / ELO    │
│  LobbyDO         │   │   - match history    │
│  (1 per active   │   │   - auth nonces      │
│   game/lobby)    │   │   - archived chat    │
└──────────────────┘   └──────────────────────┘
```

**One Durable Object class per coordination primitive, not per game type.** `GameRoomDO` is game-agnostic — it holds state, runs the plugin's `applyAction()`, manages spectator WS connections, and fires turn deadline alarms. Same for `LobbyDO`. Game-specific logic stays in the engine/game plugins.

---

## Phased implementation

### Phase 1 — Foundation (3–4 days)

**Goal:** Empty Worker project compiles, deploys, responds to a health check. No game logic yet.

1. Create `packages/workers-server/` (new package) — do NOT edit `packages/server` yet. We'll delete the old server at the end.
2. Set up `wrangler.toml` with:
   - Worker name, main entry point
   - D1 database binding
   - Durable Object bindings for `GameRoomDO`, `LobbyDO`
   - Secrets: `RELAYER_PRIVATE_KEY`, `RPC_URL`, contract addresses
3. Write D1 schema in `packages/workers-server/migrations/0001_init.sql`:
   - `players` (id, wallet_address, handle, elo, games_played, wins, created_at)
   - `matches` (id, game_type, map_seed, turns, winner_team, started_at, ended_at, replay_json)
   - `match_players` (match_id, player_id, team, class, elo_before, elo_after)
   - `auth_nonces` (nonce, wallet_address, expires_at) — short-lived, cleaned by alarm
4. Implement `GET /health` returning `{ ok: true, build: <git-sha> }`
5. Set up `wrangler dev` for local dev, verify D1 local works
6. Deploy to Workers, verify DNS via a subdomain (e.g., `ctl-beta.capturethelobster.com`)
7. **Update the existing root `CLAUDE.md`** — do NOT create new docs files. `docs/README.md` already declares `CLAUDE.md` as the single source of truth for build/run/ops. Specifically rewrite:
   - The `## Running` section — replace the `tsc && node dist/index.js` sequence with the `wrangler dev` workflow: `npm install --include=dev`, `wrangler dev` (default port 8787), how to apply D1 migrations locally (`wrangler d1 execute DB --local --file=...`), how to inspect local D1 state, where local state lives (`.wrangler/state/`) and how to wipe it
   - The Cloudflare tunnel block — the named tunnel goes away; document that `wrangler dev` is enough for local, and Pages + Workers handles the production domain directly
   - The `### Port stuck / EADDRINUSE` workaround — delete it; it's obsolete, `wrangler dev` manages its own port
   - Add a short "Deployment" subsection covering `wrangler deploy`, secrets via `wrangler secret put`, and how to tail prod logs with `wrangler tail`
   - Add a short "Debugging" note covering `wrangler dev --inspect` for Chrome DevTools attach
8. **Sanity-check `docs/README.md` and `docs/building-a-game.md`** — both currently point at `CLAUDE.md` for build commands. That pointer stays correct, no edits needed. But verify nothing else in `docs/` hardcodes `node dist/index.js` or Express references; if it does, update it in place.

**Exit criteria:** `curl https://ctl-beta.capturethelobster.com/health` returns 200 from Cloudflare's edge, AND a fresh developer following the updated root `CLAUDE.md` can get the worker running locally in under 10 minutes without asking for help.

## Phase 1 Handoff Notes

**Completed:** 2026-04-08  
**Commit:** c354d7f (and the Phase 1 scaffold commit on top of it)

### What exists in `packages/workers-server/`

```
packages/workers-server/
  package.json                  — @coordination-games/workers-server, type: module
  tsconfig.json                 — ES2022, ESNext modules, bundler resolution, strict: false
  wrangler.toml                 — ctl-server worker, D1 binding (ctl-db), GameRoomDO + LobbyDO bindings, route ctl-beta.capturethelobster.com/*
  src/
    index.ts                    — fetch() handler: GET /health → {ok,build}, GET / → redirect, 404 fallback. Exports GameRoomDO + LobbyDO.
    do/
      GameRoomDO.ts             — Stub: extends DurableObject, fetch() returns 501
      LobbyDO.ts                — Stub: extends DurableObject, fetch() returns 501
  migrations/
    0001_init.sql               — Applied to production D1. Tables: players, matches, match_players, auth_nonces
```

### Live infrastructure

- **Worker:** `ctl-server` deployed to Cloudflare Workers
- **D1 database:** `ctl-db`, id `a16be595-731c-4b55-8c4a-d937c142c2da`, region WNAM — **already has the schema applied**
- **DNS:** `ctl-beta.capturethelobster.com` → orange-clouded AAAA `100::` → Worker. Fully propagated.
- **Health check:** `curl https://ctl-beta.capturethelobster.com/health` → `{"ok":true,"build":"c354d7f"}` HTTP 200

### How to deploy changes

```bash
cd packages/workers-server
wrangler dev              # local dev on :8787
wrangler deploy           # push to production
wrangler tail             # stream production logs
```

### D1 migration notes

- `0001_init.sql` is already applied to production — do NOT re-run it
- Phase 2 should add a new file `migrations/0002_auth.sql` if schema changes are needed (auth_nonces is already in 0001)
- To apply a new migration: `wrangler d1 execute ctl-db --remote --file=migrations/0002_something.sql`
- Local dev D1 state: `packages/workers-server/.wrangler/state/` (wipe with `rm -rf` to reset)

### DO exports — critical gotcha

`src/index.ts` MUST export `GameRoomDO` and `LobbyDO` at the top level. If you add more DO classes in Phase 3+, export them from `index.ts` too or the Worker will fail to deploy.

### Wrangler auth

Wrangler is already authenticated on this machine (`wrangler whoami` to verify). The OAuth token has `workers:write`, `d1:write`, `workers_routes:write` — sufficient for all remaining phases.

### What Phase 2 should NOT change

- Do not touch `wrangler.toml` D1 binding or DO bindings — they're correct
- Do not re-run `0001_init.sql` — auth_nonces table is already there
- The `nodejs_compat` flag in `wrangler.toml` is load-bearing for ethers v6 later — do not remove it

### Phase 2 — Auth and read-only state (3–4 days)

**Goal:** Players can authenticate and read their profile. No games yet.

1. Port `auth.ts` logic: `POST /auth/challenge` writes a nonce to D1, `POST /auth/verify` reads it, validates EIP-712 signature via ethers v6, returns a session token (store token → wallet mapping in D1 with TTL, or use a signed JWT if you prefer stateless)
2. Port `relay.ts` on-chain verification code (ERC-8004 lookup) — this is pure HTTP-to-RPC, works identically in Workers
3. Port the ELO plugin to async D1: `packages/plugins/elo/src/tracker.ts` needs a new D1-backed implementation. Keep the existing `better-sqlite3` one for backwards compat during transition, but the Worker imports the D1 variant.
4. Implement `GET /profile/:handle` reading from D1

**Exit criteria:** A test player with a fresh `ethers.Wallet.createRandom()` can complete challenge/verify, receive a token, and hit an authenticated endpoint.

## Phase 2 Handoff Notes

**Completed:** 2026-04-09
**Commit:** e5e2ebd

### What was added

- `src/auth.ts` — `POST /api/player/auth/challenge` (writes nonce to D1), `POST /api/player/auth/verify` (EIP-712 verify via ethers v6, optional ERC-8004 on-chain check, issues 24h session token to D1), `validateBearerToken()` helper
- `src/env.ts` — `Env` interface extracted from `index.ts`; includes optional `RPC_URL`, `REGISTRY_ADDRESS`, `ERC8004_ADDRESS` for on-chain mode
- `src/db/elo.ts` — `D1EloTracker`: async D1 variant of `EloTracker` from `packages/plugins/elo`; same `recordGameResult(payout)` interface
- `migrations/0002_sessions.sql` — `auth_sessions` table (token → player_id with TTL); applied to production
- `index.ts` additions: `GET /api/leaderboard`, `GET /api/profile/:handle`, `GET /api/player/stats`

### D1 migration state

- `0001_init.sql` — players, matches, match_players, auth_nonces ✓
- `0002_sessions.sql` — auth_sessions ✓
- Do NOT re-run either of these

### On-chain ERC-8004 check

Auth verify skips the on-chain check unless `RPC_URL`, `REGISTRY_ADDRESS`, and `ERC8004_ADDRESS` are all set. In local dev / beta, they are not set, so any valid signature is accepted. To enable on-chain mode: `wrangler secret put RPC_URL` etc.

### Phase 3 — GameRoomDO (1 week)

**Goal:** One game, single player, can create a game, submit a move, get state back.

This is the hard phase. Plan carefully.

1. **Design the DO interface** first, before coding:
   - `POST /create` — initializes game state from config, stores in `state.storage`
   - `POST /action` — validates and applies an action, broadcasts to spectators, updates turn state
   - `GET /state?playerId=X` — returns fog-of-war view for player X
   - `GET /wait?playerId=X&since=N` — long-poll for updates (implement via internal promise, 25s timeout)
   - WS upgrade — spectator feed with delay
2. **State model:** Everything lives in `state.storage` (DO transactional storage). On first request, load state into memory; on write, persist. Use `blockConcurrencyWhile()` for transactional updates.
3. **Spectator WebSockets:** Use hibernatable WS API (`state.acceptWebSocket()`) — this is critical for cost. Hibernating WS does not incur duration charges while idle.
4. **Alarms for timeouts:** Turn deadlines, lobby phase transitions, challenge cleanup — all use `state.storage.setAlarm()`. The `alarm()` handler dispatches by a stored "alarm type" field.
5. **On game end:** Write final state + Merkle root + action log to D1 (`matches` table), then delete DO storage. The DO becomes idle and Cloudflare reclaims it.
6. Worker entry point: when a request arrives for `/games/:id/*`, forward to `env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId)).fetch(req)`.
7. Port `applyAction()` from existing `packages/engine/src/game-session.ts`. The game plugins themselves need zero changes — they're pure functions.

**Exit criteria:** A single-player game can be created, a move submitted, state fetched back with correct fog-of-war. Run the existing CtL game logic tests against the new path.

## Phase 3 Handoff Notes

**Completed:** 2026-04-09
**Commit:** 7a28a2a

### What was added

**`src/do/GameRoomDO.ts`** — full implementation:
- `POST /` — create game from `{ gameType, config, playerIds, handleMap, teamMap }`
- `POST /action` — `validateAction` + `applyAction` via the game plugin, persist to DO storage, broadcast to spectator WS
- `GET /state?playerId=X` — fog-of-war visible state per player
- `GET /wait?playerId=X&since=N` — poll (see long-poll note below)
- `GET /result` — Merkle root + outcome (only when `isOver()`)
- `GET /spectator` — delayed spectator view
- WS upgrade — hibernatable spectator WebSocket via `ctx.acceptWebSocket()`
- `alarm()` — fires deadline actions (replaces `setTimeout` from `GameRoom`)
- Lazy state load via `ctx.blockConcurrencyWhile()` on first request
- Game plugins loaded by importing `@coordination-games/game-ctl` and `@coordination-games/game-oathbreaker` as side-effects; `getGame(gameType)` from engine registry resolves them

**DO storage keys:**
- `meta` — `{ gameType, playerIds, handleMap, teamMap, createdAt, finished }`
- `state` — current game state (JSON)
- `prevProgressState` — state at last progress point (for spectator delay=1)
- `actionLog` — `{ playerId, action }[]`
- `progress` — `{ counter, snapshots[] }`
- `deadline` — `{ action, deadlineMs }` (present only when alarm is armed)

**`src/index.ts`** additions:
- `POST /api/games/create` — creates game, inserts `game_sessions` rows in D1
- `GET  /api/games` — lists active games
- `/api/games/:id[/sub]` — forwarded to GameRoomDO for any method
- `GET  /api/player/state` — auth-gated, looks up player's game from `game_sessions`
- `POST /api/player/move` — auth-gated, forwards to player's game DO
- `GET  /api/player/wait` — auth-gated, forwards to player's game DO
- `WS /ws/game/:id` — upgrades to hibernatable spectator WS on the DO

**`migrations/0003_game_sessions.sql`** — `game_sessions (player_id PK, game_id, game_type, joined_at)` — applied to production.

**`package.json`** — added `@coordination-games/engine`, `game-ctl`, `game-oathbreaker` as workspace deps.

### Critical: `/wait` does not long-poll

The original plan called for `/wait` to block for up to 25s via an internal Promise. **This is not possible in Durable Objects.** DO requests are processed sequentially — a 25s blocking request would prevent all other requests (including `POST /action`) from reaching the same DO instance.

**Actual behavior:** `/wait` returns immediately:
- `{ reason: 'turn_changed', ... }` if `progressCounter > since` (new state available)
- `{ reason: 'no_update', progressCounter }` if nothing changed

**What the CLI must do:** short-poll with a 1–2s retry interval on `no_update`. This is a permanent architectural constraint, not a temporary gap.

**Two separate clients, two separate paths — do not conflate them:**
- `/wait` (HTTP poll) is for **agent CLI** (`coga wait`). It returns `no_update` immediately if nothing changed; the CLI retries after a short delay. This endpoint stays permanently and is not replaced by anything.
- WebSocket (`/ws/game/:id`) is for **browser spectators**. The DO pushes state after every action. Has nothing to do with the CLI.

The behavioral difference from the old Node server is only that the old server blocked for up to 25s before returning `no_update`, saving some HTTP round-trips. The DO version returns immediately and the CLI polls more frequently. For a turn-based game this is imperceptible.

### D1 migration state

- `0001_init.sql` — players, matches, match_players, auth_nonces ✓
- `0002_sessions.sql` — auth_sessions ✓
- `0003_game_sessions.sql` — game_sessions ✓
- Do NOT re-run any of these

### Smoke test

```bash
# Create a game
curl -s -X POST https://ctl-beta.capturethelobster.com/api/games/create \
  -H 'Content-Type: application/json' \
  -d '{"gameType":"capture-the-lobster","config":{"mapSeed":"test","teamSize":2,"players":[{"id":"p1","team":"A","unitClass":"knight"},{"id":"p2","team":"A","unitClass":"mage"},{"id":"p3","team":"B","unitClass":"knight"},{"id":"p4","team":"B","unitClass":"mage"}]},"playerIds":["p1","p2","p3","p4"]}'

# Start game (system action, playerId null)
curl -s -X POST https://ctl-beta.capturethelobster.com/api/games/<GAME_ID>/action \
  -H 'Content-Type: application/json' \
  -d '{"playerId":null,"action":{"type":"game_start"}}'

# Submit moves (action field uses {type:"move", agentId, path})
curl -s -X POST https://ctl-beta.capturethelobster.com/api/games/<GAME_ID>/action \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"p1","action":{"type":"move","agentId":"p1","path":["N"]}}'
```

### Phase 4 — LobbyDO and full game flow (3–4 days)

**Goal:** Two or more players can form a lobby, advance through phases, start a game, play to completion.

1. `LobbyDO` mirrors `GameRoomDO` structure: create, join, chat, phase state machine, alarm-driven phase transitions
2. Port the `lobby-runner.ts` phase state machine (already bot-free after Phase 0). This is almost a direct copy — the `setTimeout`-based phase advances become alarm-based.
3. When a lobby's final phase completes, LobbyDO creates a GameRoomDO and transitions players over
4. Port the remaining REST endpoints: `/lobbies`, `/lobbies/:id/join`, `/lobbies/:id/chat`, team/class actions
5. Spectator broadcast for lobbies (chat, timer updates) via hibernatable WS

**Exit criteria:** Two CLI processes can join a lobby, form teams, start a game, play to completion. End-to-end test passes.

### Phase 5 — Plugin pipeline and tool calls (2–3 days)

**Goal:** The `POST /player/tool` endpoint works for all plugin tools (chat, elo, etc).

1. Port the typed relay mechanism — this is the hardest bit because the relay currently holds in-memory state per game. Move relay buffer to DO storage.
2. Port `POST /player/tool` — routes to the plugin's `handleCall()`, processes the returned `relay` envelope through the relay
3. Wire up the BasicChatPlugin and ELO plugin to work inside the Worker (server-side — client-side pipeline in the CLI is untouched)

**Exit criteria:** `coga tool basic-chat chat "test" team` from a CLI player lands in the other team member's next `get_state` response.

### Phase 6 — Frontend on Pages (1 day)

1. `cd packages/web && npx vite build`
2. `wrangler pages deploy packages/web/dist --project-name=ctl-web`
3. Update API base URL config to point at the Workers domain
4. Verify the Cloudflare tunnel for `capturethelobster.com` points at the Pages project (may need a DNS update — the tunnel goes away entirely, Pages handles the domain directly)

**Exit criteria:** Loading `capturethelobster.com` shows the lobby browser, joining a game from the UI works end-to-end.

### Phase 7 — Cutover and cleanup (2–3 days)

1. Point `capturethelobster.com` DNS at the Worker + Pages deployment
2. Delete `packages/server` entirely (or archive it to a branch for reference)
3. Kill the old process on the dev box and retire the named Cloudflare tunnel
4. **Edit existing docs in place — do not add new ones.** Sweep the repo for references to the old server:
   - Root `CLAUDE.md` — the Phase 1 doc-rewrite should already cover this, but verify nothing stale is left (Express, `node dist/index.js`, tunnel setup, port-kill workaround)
   - Root `README.md` — update any mention of the old server architecture
   - Root `ARCHITECTURE.md` — update the `packages/server` description if it references Express/WebSocket/Node
   - `docs/README.md` — the Repo Structure block lists `packages/server -- Node.js backend (Express + WebSocket)`; update to reflect the Workers-based server
   - `docs/platform-architecture.md` — update any deployment/topology sections
   - `scripts/` — update or delete any scripts that reference the old server entry point or tunnel binary
5. Write a short postmortem in a commit message (not a new doc) noting cost observations from the first week of traffic

**Exit criteria:** Old server is gone, everything runs on Cloudflare, a real game can be played end-to-end by two external agents, and `grep -ri "dist/index.js\|cloudflared\|express" docs/ CLAUDE.md README.md ARCHITECTURE.md` returns no stale references.

---

## Testing strategy

- **Keep existing unit tests.** Game logic, hex math, combat, LOS, map generation — none of this changes. Run them the same way.
- **Rewrite the integration test harness** (`packages/server/src/__tests__/e2e.test.ts`) to run against a locally spawned Worker via Miniflare instead of spawning a Node process. Miniflare has a programmatic API that works well with Vitest.
- **Manual test protocol** for each phase: two ephemeral CLI processes (`coga init` each with a fresh wallet), join a lobby, play a game, check the result.
- **Production smoke test:** Same manual protocol, but hitting the live Workers URL.

---

## Monitoring and cost validation

Skip the "build a prototype first" approach. Just ship to a beta subdomain and watch real traffic. Add these log lines during development and keep them for at least the first month in prod:

- On DO creation: `console.log({ event: "do_create", doId, gameId, ts })`
- On DO alarm fire: `console.log({ event: "do_alarm", doId, alarmType, ts })`
- On WS accept / hibernate / close: log each transition
- On DO destroy / idle: log the total active wall-clock seconds

Tail these via `wrangler tail` or Logpush. After a week of beta traffic, you'll have real numbers for:
- Avg active DO-seconds per game
- WS messages per spectator per game
- D1 reads/writes per game

That data beats any a priori projection. If the bill is wrong by 3x either direction, you'll see it in the Cloudflare dashboard before it matters.

---

## Cost expectations

All figures from the current Cloudflare pricing docs (as of 2026-04-08):
- Workers: https://developers.cloudflare.com/workers/platform/pricing/
- Durable Objects: https://developers.cloudflare.com/durable-objects/platform/pricing/
- D1: https://developers.cloudflare.com/d1/platform/pricing/
- Pages: https://developers.cloudflare.com/pages/functions/pricing/

**The $5/mo paid plan (Workers Standard) includes:**
- 10M Worker requests / mo
- 30M CPU-ms / mo
- 1M DO requests / mo
- 400,000 DO GB-s / mo
- D1: 25B row reads, 50M row writes, 5 GB storage
- Pages static hosting: free and unlimited

**Beta (≤ 10 concurrent games):** $5/mo flat. Everything fits inside the included quotas, assuming hibernatable WS is used correctly.

**Growth (~50 concurrent games, ~30k games/mo):** Estimated $65–130/mo. The meter that starts to matter is **DO duration (GB-s)**. Overage is $12.50 per million GB-s.

**Scale (500+ concurrent):** DO duration dominates. Model this seriously before growing past it — could be $500–1500/mo. At that point, consider whether cheaper options (running your own Node on Hetzner) make more sense.

**Key cost lever:** DO duration billing. If DOs stay active longer than necessary, costs scale linearly. Mitigations:
- Use hibernatable WebSockets religiously (`state.acceptWebSocket()`, not raw `server.accept()`)
- Archive completed games to D1 immediately and let the DO go idle
- Don't hold long-running computations inside the DO — offload to D1 where possible

---

## Known risks and unknowns

1. **DO hibernation billing semantics.** The docs say WS messages bill 20:1 and hibernation reduces duration costs, but the exact interaction between "idle hibernated DO with 3 WS connections" and duration billing is not 100% clear from the pricing page alone. **Mitigation:** ship it, watch the dashboard, optimize.

2. **~~Merkle hash function audit.~~ RESOLVED (2026-04-08).** `packages/engine/src/merkle.ts` uses SHA-256. `GameAnchor.sol` only stores the root — it does not recompute or verify the hash function. No mismatch. Copy `merkle.ts` as-is during migration.

3. **ethers v6 in Workers.** Widely reported to work, but specifically verify EIP-712 signing with a server-held relayer private key works under Workers' WebCrypto constraints. A 30-minute spike in Phase 1 rather than discovering it in Phase 6.

4. **Plugin async conversion.** The ELO plugin is synchronous (`better-sqlite3`). Converting to async D1 touches ~150 call sites. Mechanical, but tedious — budget half a day just for this.

5. **Local dev friction.** Devs switch from `node dist/index.js` to `wrangler dev`. Not worse, but different. The root `CLAUDE.md` update in Phase 1 is the single place to document this; do not scatter instructions across new files. Expect one day of onboarding friction per dev.

6. **Cloudflare tunnel retirement.** The current setup uses a named tunnel from the dev box to serve traffic. After Pages + Workers is live, the tunnel isn't needed and should be retired to avoid confusion. Don't forget this cleanup step.

---

## Out of scope (explicitly)

- Rebuilding bots for the new architecture (separate project, post-migration)
- On-chain contract changes
- Game rule or UX changes
- A staging environment beyond the beta subdomain
- Multi-region / multi-tenant concerns
- Monitoring beyond `wrangler tail` + Cloudflare dashboard (can add Sentry/Datadog later if needed)

---

## Handoff checklist for the implementing dev

Before starting:
- [ ] Phase 0 (bot removal) is merged to `main`
- [ ] You've read `packages/server/src/api.ts` end-to-end
- [ ] You've read `packages/engine/src/game-session.ts` end-to-end
- [ ] You've run a local game end-to-end with two CLI players
- [ ] You have a Cloudflare account with Workers paid plan active
- [ ] You've read the Cloudflare Durable Objects guide (specifically: hibernatable WebSockets, alarms, and transactional storage)
- [ ] You've confirmed the Merkle hash function audit (risk #2 above) — do this first

During implementation:
- [ ] Each phase's exit criteria must pass before starting the next
- [ ] Keep the old server running in parallel until Phase 7 cutover
- [ ] Tag a git commit at the end of each phase for easy rollback
- [ ] Every DO class has unit tests covering create/action/state/alarm
