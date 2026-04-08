# Cloudflare Workers + D1 Migration Plan

**Status:** Phase 0 complete. Phase 1 not started.
**Audience:** Mid-level engineer picking this up cold
**Estimated effort:** 4–5 weeks (after bot removal is done on main)

---

## Goal

Migrate `packages/server` from Node.js + Express + WebSocket + in-memory state to Cloudflare Workers + Durable Objects + D1. The frontend moves to Cloudflare Pages. The on-chain relay code ports as-is.

## Non-goals

- **No in-process bots.** Bot removal is a prerequisite (see "Phase 0" below). External bots will connect as normal players via the CLI later.
- **No feature changes.** This is infrastructure-only. The game rules, plugin API, CLI, and REST contract should be identical to users.
- **No on-chain changes.** The relay contracts stay where they are on OP Sepolia.

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

### Phase 2 — Auth and read-only state (3–4 days)

**Goal:** Players can authenticate and read their profile. No games yet.

1. Port `auth.ts` logic: `POST /auth/challenge` writes a nonce to D1, `POST /auth/verify` reads it, validates EIP-712 signature via ethers v6, returns a session token (store token → wallet mapping in D1 with TTL, or use a signed JWT if you prefer stateless)
2. Port `relay.ts` on-chain verification code (ERC-8004 lookup) — this is pure HTTP-to-RPC, works identically in Workers
3. Port the ELO plugin to async D1: `packages/plugins/elo/src/tracker.ts` needs a new D1-backed implementation. Keep the existing `better-sqlite3` one for backwards compat during transition, but the Worker imports the D1 variant.
4. Implement `GET /profile/:handle` reading from D1

**Exit criteria:** A test player with a fresh `ethers.Wallet.createRandom()` can complete challenge/verify, receive a token, and hit an authenticated endpoint.

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

2. **Merkle hash function audit.** Before the migration, verify `packages/engine/src/merkle.ts` uses the same hash function (keccak256 vs SHA-256) as the on-chain `GameAnchor` contract expects. If it's wrong today, this is the time to fix it — not mid-migration. **Check with:** compare the hash function in `merkle.ts` against `packages/contracts/contracts/GameAnchor.sol`.

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
