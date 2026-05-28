# Lobby & Matchmaking Architecture Audit

**Status:** audit, not a fix plan. Captures repo state on `under-construction` branch (2026-05-26). Companion to `docs/plans/sizing-bugs.md` — sizing is the surface symptom, this doc is the underlying topology.

The pre-game lifecycle is **two coherent systems and four vestigial/duplicated ones glued together**. The two real ones (D1 routing + `LobbyDO` + `LobbyPhase` pipeline) are well-factored and do most of the work. The vestigial ones (`MatchmakingConfig`, `queueType`, per-surface capacity math, the `_meta.phase` enum, the `team_size` D1 column) accumulated because the refactor that introduced `LobbyPhase` instances did not delete the prior `{phaseId, config}` shape's neighbors.

## TL;DR

- **`MatchmakingConfig` is dead.** Declared on every plugin, referenced only by tests, never read at runtime. It is a placeholder from the original v2 plugin refactor (`94a938b`, Apr 2026) that was never wired and never deleted.
- **`queueType: 'open' | 'stake-tiered' | 'invite'` is also dead.** Same provenance, same fate, plus two never-implemented sentinels.
- **One real lobby state machine exists.** It lives across LobbyDO `_meta.phase` + `LobbyDO.currentPhaseIndex` + `LobbyPhase[index]`. D1 `lobbies.phase` is a downstream mirror, written via `UPDATE`.
- **`_meta.phase` is too coarse.** Only `lobby | in_progress | finished`. Cannot represent "lobby exists, joins closed because we're in `ClassSelection`". The per-phase `acceptsJoins` flag carries that signal but is consulted *after* the join is appended to `_agents` — the ghost-player bug from `sizing-bugs.md`.
- **Capacity is computed in four places**, with three formulas, and none match the phase's actual completion rule. (`fill-bots.ts:35`, `web/src/games/*/webPlugin.tsx`, `cli/src/commands/game.ts:303,313`, `tool-dispatcher.ts` does not compute it.) The server has no `capacity` field on `/api/lobbies`.
- **`OpenQueuePhase` is a min-trigger, not a target.** OATH and TotC games *always* start at exactly 4 players. `maxPlayers: 20` and `maxPlayers: 6` advertised in matchmaking are unreachable in code.
- **CtL is the only multi-phase game.** Every architecture decision around phase iteration (`advancePhase`, `accumulatedMetadata`, `currentPhaseIndex`) exists for CtL alone. OATH and TotC each have `phases: [new OpenQueuePhase(4)]` — a one-element array.
- **Test fixtures use the old `{phaseId, config}` shape.** `packages/engine/src/__tests__/types.test.ts:99` constructs a `GameLobbyConfig` whose `phases` array contains POJOs that no longer conform to the `LobbyPhase` interface. The test passes because vitest does not typecheck and the engine `tsconfig.json:9` excludes `src/__tests__`. The matchmaking field on the same fixture is the only "reader" of `MatchmakingConfig` in the entire repo.
- **There is exactly one `LobbyPhase` implementation in the engine** (`OpenQueuePhase`). The other two (`TeamFormationPhase`, `ClassSelectionPhase`) live in the CtL package. There is no `MatchmakingPhase` and no evidence one ever existed in git history.

The architectural verdict (full version in §7): this is **not** several overlapping systems claiming to do the same job. It is one coherent system with three peripheral surfaces (matchmaking config, capacity math, phase enum) that were leftover scaffolding from the v2 refactor and got copied forward instead of pruned. Lucian's instinct is right that something feels off — but the fix is `delete`, not `unify`.

## 1. System inventory

### 1.1 The `lobbies` D1 table — discovery / routing root

`packages/workers-server/migrations/0009_phase_enum_unify.sql:22-30`

```sql
CREATE TABLE lobbies (
  id          TEXT NOT NULL PRIMARY KEY,
  game_type   TEXT NOT NULL,
  team_size   INTEGER NOT NULL,
  phase       TEXT NOT NULL DEFAULT 'lobby'
              CHECK (phase IN ('lobby', 'in_progress', 'finished')),
  created_at  TEXT NOT NULL,
  game_id     TEXT
);
```

Five columns. **`team_size`** is the requested CLI `--size`, used only for display (per `sizing-bugs.md`). **`phase`** mirrors `LobbyDO._meta.phase` after each transition via `LobbyDO.updateLobbyPhaseInD1` (`LobbyDO.ts:1034-1043`). **`game_id`** is null until handoff, then carries the spawned `GameRoomDO` id.

Readers (`packages/workers-server/src/index.ts`):
- `handleListLobbies` (`:569-601`) — `/api/lobbies` listing. Filters `WHERE l.phase = 'lobby'`.
- `getPlayerLocation` (`:1170-1187`) — joins through `player_sessions` to resolve current lobby/game.
- `handlePlayerLobbyJoin` (`:861-895`) — checks if the player is already in a different unfinished lobby/game.
- Admin inspect/kill (`:1087, 1012`) — operator visibility.

Writers:
- `handleCreateLobby` (`:629`) — initial `INSERT`.
- `LobbyDO.updateLobbyPhaseInD1` (`:1037`) — `UPDATE phase, game_id` on every phase change.

### 1.2 `player_sessions` D1 table — "where am I right now?"

`packages/workers-server/migrations/0008_player_sessions.sql:10-16`

```sql
CREATE TABLE player_sessions (
  player_id TEXT NOT NULL PRIMARY KEY,
  lobby_id  TEXT NOT NULL,
  joined_at TEXT NOT NULL
);
```

Single-row-per-player invariant (PRIMARY KEY on `player_id`) is what keeps the "one active session" rule honest. A player's location is always `player_sessions.lobby_id` → `lobbies.game_id` (null = lobby phase, non-null = game phase). The `0008` migration explicitly collapsed an older two-table design (`lobby_sessions` + `game_sessions`) into this one. Written by `handlePlayerLobbyJoin` (`:925`) at join time and by the dev-only synthetic-lobby path (`:796`).

### 1.3 `LobbyDO` — phase runner, single instance per lobby

`packages/workers-server/src/do/LobbyDO.ts`

Stateful Durable Object. Owns:
- `_meta: LobbyMeta` (`:81-99`) — the live lobby state machine.
- `_agents: AgentEntry[]` (`:101-106`) — the roster.
- `_phaseState: unknown` — opaque, owned by the current `LobbyPhase`.
- `_stateVersion: number` — bumped in `saveState` (`:1049-1057`), used for the HTTP ETag short-circuit.

HTTP surface (`:181-192`):
- `POST /` → `handleCreate` (`:236-306`)
- `GET /state` → `handleGetState`
- `POST /join` → `handleJoin` (`:327-400`)
- `POST /action` → `handleAction` (delegates to current phase's `handleAction`)
- `POST /tool` → `handleTool` (relay publish only; does not touch `_phaseState`)
- `DELETE /` → `handleDisband`
- `GET /` upgrade → spectator WS

State machine (the `_meta.phase` enum at `:93`):
```
created → 'lobby' → 'in_progress' → terminal
                  ↘ 'finished' (disband / fail / game over)
```

The whole pre-game phase pipeline lives **inside** `_meta.phase = 'lobby'`. `currentPhaseIndex` discriminates *which* `LobbyPhase` is active.

### 1.4 `LobbyPhase` interface — game-declared pre-game stages

`packages/engine/src/types.ts:643-704`. The full surface:

```
init(players, config)                      — required, builds initial _phaseState
handleAction(state, action, players)       — required, returns { state, completed?, relay?, error? }
handleJoin?(state, player, allPlayers)     — only called when acceptsJoins=true
handleTimeout(state, players)              — required, returns PhaseResult or null (null fails the lobby)
getView(state, playerId?)                  — required, returns the per-viewer phase view
getTeamForPlayer?(state, playerId)         — optional, used by relay routing
```

Plus declarative metadata:
- `id`, `name`, `tools?`, `timeout? (seconds | null)`, `acceptsJoins? (default false)`.

Three implementations in the repo:

| File | Class | `acceptsJoins` | `timeout` | Tools |
|------|-------|----------------|-----------|-------|
| `packages/engine/src/phases/open-queue.ts:7` | `OpenQueuePhase` | `true` | `null` | none |
| `packages/games/capture-the-lobster/src/phases/team-formation.ts:94` | `TeamFormationPhase` | `true` | `600` | propose_team, accept_team, leave_team |
| `packages/games/capture-the-lobster/src/phases/class-selection.ts:31` | `ClassSelectionPhase` | `false` | `600` | choose_class |

**No `MatchmakingPhase`. No `WaitingRoomPhase`. No `StakeTierPhase`.** The interface anticipates more, none exist.

`PhaseResult` (`types.ts:719-734`) is how a completed phase hands data forward:
```ts
interface PhaseResult {
  groups: AgentInfo[][];     // teams (CtL) or single flat group (FFA)
  metadata: Record<string, unknown>;
  removed?: AgentInfo[];     // players the phase ejected
}
```

The `metadata` from every completed phase is merged into `_meta.accumulatedMetadata` at `LobbyDO.ts:598`. This bag is the only channel by which phase-emitted decisions flow into `plugin.createConfig(players, seed, options)` at game-start (`LobbyDO.ts:692`). `TeamFormationPhase` emits `{ teams: [{id, members}] }`; `ClassSelectionPhase` emits `{ classPicks }`; `OpenQueuePhase` emits `{}`.

### 1.5 `MatchmakingConfig` — declared, never read

`packages/engine/src/types.ts:741-755`:

```ts
interface GameLobbyConfig {
  queueType: 'open' | 'stake-tiered' | 'invite';
  phases: LobbyPhase[];
  matchmaking: MatchmakingConfig;
}
interface MatchmakingConfig {
  minPlayers: number; maxPlayers: number;
  teamSize: number; numTeams: number;
  queueTimeoutMs: number;
}
```

Declared by every plugin:
- `packages/games/capture-the-lobster/src/plugin.ts:787-793`
- `packages/games/oathbreaker/src/plugin.ts:333-339`
- `packages/games/tragedy-of-the-commons/src/plugin.ts:209-215` (V1), `:552-558` (V2)

**Read by zero runtime code paths.** Verified by `grep -nE 'lobby\.matchmaking|plugin\.lobby\.matchmaking|\.matchmaking\.' packages/`. The only references in `packages/` outside the plugin declarations themselves are:
- `packages/engine/src/__tests__/types.test.ts:102, 111, 134` — compile-time shape assertion in a fixture.
- `packages/engine/src/__tests__/tool-collision.test.ts:96` — same.
- `packages/cli/src/__tests__/tool-collision.test.ts:96` — same.
- `packages/workers-server/src/index.ts:621` — **a code comment** that lies: `// Broad bounds — LobbyDO enforces per-game limits via plugin.lobby.matchmaking`. LobbyDO does no such thing.

Same story for `queueType`. Declared with one of three string sentinels; read nowhere. The two non-`'open'` values (`'stake-tiered'`, `'invite'`) have never had implementation code.

### 1.6 CLI lobby commands

`packages/cli/src/commands/game.ts`:

- `lobbies` (`:240-264`) — `GET /api/lobbies`, prints `${playerCount}/${teamSize}` denominator (the broken display, B7 in sizing-bugs).
- `create-lobby -s -g` (`:267-326`) — `POST /api/lobbies/create`, then prints either "Players: N" (OATH/TotC) or "Team size: NvN" (CtL) using locally-clamped values.
- `join` (`:328+`) — wraps `POST /api/player/lobby/join`.

### 1.7 Worker HTTP surface for lobbies

`packages/workers-server/src/index.ts`:

| Route | Handler | Notes |
|-------|---------|-------|
| `GET /api/lobbies` | `handleListLobbies:569` | filters `phase='lobby'`; returns `{lobbyId, gameType, teamSize, phase, createdAt, gameId, playerCount}`. **No `capacity`.** |
| `POST /api/lobbies/create` | `handleCreateLobby:603` | Bearer-free (intentional). INSERT into D1, then POST to LobbyDO. |
| `GET /api/lobbies/:id/...` | forward to LobbyDO | Unauthenticated GET allowed. |
| `POST /api/lobbies/:id/...` | forward with `X-Player-Id` | Worker decorates the header from the Bearer ticket. |
| `WS /ws/lobby/:id` | forward to LobbyDO | Spectator WebSocket. Hibernatable. |
| `POST /api/player/lobby/join` | `handlePlayerLobbyJoin:831` | Per-player single-session gate (D1 query at `:861`), then forwards to LobbyDO `/join`. |
| `POST /api/player/tool` | `dispatchToolCall` (`tool-dispatcher.ts`) | Resolves declarer (game / lobby phase) by `player_sessions` join + LobbyDO `/state` to read `currentPhase.id`. |
| `WS /ws/player` | forward to LobbyDO or GameRoomDO | Routes on `lobbies.game_id` (`:480-482`). |

### 1.8 Spectator / broadcast

LobbyDO uses Cloudflare's hibernatable WebSocket pattern. Connections tagged `TAG_SPECTATOR` (`:60`). `broadcastUpdate` (`:894-911`) sends the same unified spectator payload that HTTP `/state` returns. Delta semantics via `sinceIdx` + `_lastBroadcastRelayIdx`. State block elided on the wire when `knownStateVersion` matches `_stateVersion`.

There is **one** broadcast path; no second event stream. Disband / game-handoff close the WS with code 1000 (`:539, 769-773`) so reconnecting clients re-route via `/api/player/state` → `getPlayerLocation`.

### 1.9 Bot-fill path

`scripts/fill-bots.ts`. Reads `/api/lobbies`, picks bots from `~/.coordination/bot-pool.json`, calls `/api/player/lobby/join` for each. Computes capacity locally:

```ts
function deriveCapacity(gameType: string, teamSize: number): number {
  return gameType === 'oathbreaker' ? teamSize : teamSize * 2;  // :35
}
```

CtL with `teamSize=2`: capacity = 4 (correct by coincidence). OATH with `teamSize=20` (the wire field): capacity = 20 (intent honored — but OpenQueuePhase completes at 4 anyway). TotC FFA with `teamSize=6`: capacity = 12 (**wrong** — TotC is FFA, real capacity is 6 if it were even reachable, which it isn't).

### 1.10 Web lobby surfaces

`packages/web/src/pages/LobbiesPage.tsx`, plus per-game cards in `packages/web/src/games/*/webPlugin.tsx`. Each game's webPlugin computes its *own* capacity formula:

| Game | File:line | Formula |
|------|-----------|---------|
| CtL | `web/src/games/capture-the-lobster/webPlugin.tsx:76` | `teamSize * 2` |
| OATH | `web/src/games/oathbreaker/webPlugin.tsx:73` | `teamSize` (treats it as player count target) |
| TotC | `web/src/games/tragedy-of-the-commons/webPlugin.tsx:46` | `Math.min(6, Math.max(4, teamSize ?? 4))` |

So there are **three places** that compute lobby capacity (fill-bots, CLI list, web per-game card), with **three different formulas** for FFA games. The server has none.

### 1.11 Join flow — credit check, idempotency, race handling

`LobbyDO.handleJoin` (`:327-400`) is the only non-trivial pre-game flow. Order of operations:

1. Outer guard: `_meta.phase === 'lobby'` (else 409). `:329`
2. Body parse, validate `X-Player-Id` + `handle`. `:336-346`
3. **First idempotency check** — already in `_agents`? Return success. `:349-351`
4. Pre-game credit balance check via `ChainRelay.getBalance` (`:358-362`).
5. **Second idempotency check** after the await, comment at `:364-369` explains the DO request-interleaving race.
6. Push to `_agents`. `:374-375`
7. If `phase.acceptsJoins && phase.handleJoin` → call it. `:383`
8. `saveState` + `broadcastUpdate`.

The credit check has a thorough doc comment about the single-session invariant (`:354-357, 917-939`).

## 2. Where the systems collide

This is the heart of the audit. Concrete seams, file:line evidence.

### 2.1 Two answers to "is this lobby joinable?"

- **D1 `lobbies.phase`** — filtered in `handleListLobbies:577` (`WHERE l.phase = 'lobby'`). This is the *public* answer ("show this lobby in the list").
- **DO `_meta.phase`** — checked in `LobbyDO.handleJoin:329`. This is the *operational* answer ("will the join succeed").

These can drift transiently: `LobbyDO.advancePhase` (`:594-659`) calls `saveState` then `updateLobbyPhaseInD1` (`:650`). On a phase change *within* `'lobby'` the D1 row doesn't change (still `phase='lobby'`), so no drift. On handoff to game, `_meta.phase` flips to `'in_progress'` at `:753` and D1 updates at `:755`. There's a sub-millisecond window but D1 is the single source for the listing.

The real divergence is conceptual: neither answer captures `phase.acceptsJoins === false`. A lobby in `ClassSelectionPhase` is listed as `phase='lobby'`, accepts the `POST /join` (passes the outer guard), pushes the agent to `_agents`, but the phase silently doesn't track them — the ghost-player bug.

**Three layers all claim to gate joins** but none of them gate at the right level:
- D1 `phase='lobby'` (listing filter)
- `_meta.phase === 'lobby'` (`LobbyDO.ts:329` outer guard)
- `phase.acceptsJoins` (`LobbyDO.ts:383` — *after* the push)

### 2.2 Capacity is computed nowhere authoritative and somewhere wrong

The server has no canonical capacity field. Each surface invents one:

| Surface | File:line | Formula | Wrong for |
|---------|-----------|---------|-----------|
| CLI lobby list | `cli/src/commands/game.ts:253` | `${playerCount}/${teamSize ?? '?'}` | CtL (would show 4/2), all FFA after first joiner |
| CLI create-lobby print | `cli/src/commands/game.ts:303, 313-315` | echoes the input | always, since `--size` is dropped anyway |
| Web CtL card | `web/src/games/capture-the-lobster/webPlugin.tsx:76` | `teamSize * 2` | only correct when teamSize wasn't overridden (it never is) |
| Web OATH card | `web/src/games/oathbreaker/webPlugin.tsx:73` | `teamSize` (treated as player count) | none, but unreachable since OpenQueuePhase completes at 4 |
| Web TotC card | `web/src/games/tragedy-of-the-commons/webPlugin.tsx:46` | `clamp(teamSize, 4, 6)` | claims max 6 but always starts at 4 |
| fill-bots.ts | `scripts/fill-bots.ts:35` | `gameType==='oathbreaker' ? teamSize : teamSize * 2` | TotC (computes 8-12 for 4-6 player game) |

The actual capacity is determined by the phase's completion rule, which differs per game:
- `OpenQueuePhase`: completes at `>= minPlayers` (constructor arg, hardcoded `4`).
- `TeamFormationPhase`: completes at `numTeams` full teams of `teamSize` (constructor args, hardcoded `{teamSize:2, numTeams:2}` → 4).

No surface asks the phase. Even `tool-dispatcher.ts:248-256`, which iterates `plugin.lobby?.phases ?? []` to build the tool surface, doesn't extract sizing.

### 2.3 `matchmaking.teamSize` vs phase constructor `teamSize`

Both exist for CtL. Both say `2`. Nothing keeps them in sync. The plugin declaration (`packages/games/capture-the-lobster/src/plugin.ts:783-793`) literally hard-codes the same value twice in adjacent fields. For OATH and TotC the duplication is worse: `matchmaking.minPlayers` declared, then `new OpenQueuePhase(4)` next line, both reading as "min 4" — but `matchmaking.maxPlayers: 20` (OATH) / `6` (TotC) has no equivalent in the constructor and is silently violated.

### 2.4 Phase pipeline iteration assumes CtL's shape

`LobbyDO.advancePhase` (`:594-659`) treats `phases` as a generic sequence:

```ts
const nextIndex = this._meta.currentPhaseIndex + 1;
if (nextIndex < phases.length) {
  // init next phase, set alarm, ...
} else {
  await this.doCreateGame();
}
```

This is correct for the only game with `phases.length > 1` (CtL: 2). For OATH and TotC (`phases.length === 1`), the iteration is degenerate — `currentPhaseIndex` is always 0, `advancePhase` always falls to the `else`. The `accumulatedMetadata` accumulation (`:598`) is doing nothing useful for FFA games, because `OpenQueuePhase` returns `metadata: {}` (`engine/src/phases/open-queue.ts:38, 46`).

This is not a bug — the design is fine — but it means **every architectural decision around phase iteration is justified by exactly one game**. If CtL went away, the whole phase pipeline could collapse to a single `LobbyPhase` per game and `_meta` would shed three fields.

### 2.5 `accumulatedMetadata` shape is implicit and convention-based

There is no schema for `accumulatedMetadata`. Phases pile keys in (`teams`, `classPicks`), `createConfig` reads them out (`packages/games/capture-the-lobster/src/plugin.ts:831-832`). The contract is documented in a doc comment on `PhaseResult.metadata` (`types.ts:728-731`):

> E.g. TeamFormation: `{ teams: [{ id, members }] }`
> E.g. ClassSelection: `{ classPicks: { [playerId]: 'rogue' | 'knight' | 'mage' } }`

This isn't *wrong* — it works — but a phase author has no way to discover the convention without grepping. There is also a documented-but-never-written `teamSize` key (per `sizing-bugs.md` §1): `createConfig` reads `options?.teamSize` at `plugin.ts:879` but no phase writes it.

### 2.6 Phase `handleJoin` / `handleLeave` semantics are inconsistent

| Phase | `acceptsJoins` | `handleJoin` behavior | `handleLeave` semantics |
|-------|----------------|------------------------|--------------------------|
| `OpenQueuePhase` | `true` | Appends to `playerIds`, auto-completes at `minPlayers` | None (no `leave_team`-equivalent). Phase has no way to handle a leave. |
| `TeamFormationPhase` | `true` | Appends to `unassigned`, does NOT trigger completion check | `leave_team` tool removes player from current team, returns them to `unassigned` |
| `ClassSelectionPhase` | `false` | N/A | None. Player leaving mid-class-pick is unrepresentable. |

There is no `phase.handleLeave` in the `LobbyPhase` interface (`types.ts:644-704`) — only `handleJoin`. Player leaving a lobby is not a first-class concept anywhere. Players can be `removed` by a phase as part of a `PhaseResult` (`types.ts:733`), but there's no explicit "I want to leave" path. The `LobbyDO` has no `DELETE /agents/:id` route.

This is fine for OATH/TotC (joins immediately complete the phase) and works for CtL (`leave_team` only restructures within the phase, doesn't remove from `_agents`). But the interface has an asymmetry that no game currently feels.

### 2.7 `handleTimeout` semantics are inconsistent too

| Phase | Returns `null` when... | Returns `PhaseResult` when... |
|-------|------------------------|-------------------------------|
| `OpenQueuePhase` | `playerIds.length < minPlayers` (lobby dies) | enough players queued |
| `TeamFormationPhase` | Can't form `numTeams` complete teams (lobby dies) | Greedy auto-merge succeeded |
| `ClassSelectionPhase` | **never** — always auto-assigns | round-robin fills missing picks |

OATH/TotC have `timeout: null` so this is moot for them in practice — they sit on the alarm-less lobby forever. CtL has `timeout: 600` for both phases. The asymmetry where `ClassSelection` can never fail-on-timeout vs `TeamFormation` can is by design but undocumented at the interface level.

### 2.8 The `_meta.phase` enum is one bit short

Per `sizing-bugs.md` §B14: `'lobby' | 'in_progress' | 'finished'` cannot represent "lobby exists but joins are closed". `phase.acceptsJoins` carries that signal, but consulting it requires loading the plugin, finding the current phase, etc. — work that the listing query (`handleListLobbies`) doesn't do. Consequence: closed-to-joins lobbies (CtL mid-ClassSelection) still appear in `/api/lobbies` as joinable.

Fix space: refine the enum to `'lobby-open' | 'lobby-closed' | 'in_progress' | 'finished'`, OR add a derived `acceptsJoins` column to the listing query, OR push the `acceptsJoins` check into the outer guard at `LobbyDO.ts:329` (cheapest).

### 2.9 D1 `team_size` semantics drift across games

The column is `team_size INTEGER NOT NULL` (`0009_phase_enum_unify.sql:25`). The Worker stores whatever was on the wire (`index.ts:631`). What it *means* depends on game type:
- CtL: members per team (`teamSize * 2 = capacity`)
- OATH: total player target (`teamSize = capacity`)
- TotC: total player target (clamped 4-6 in the web)

The same INTEGER column means three different things depending on the sibling `game_type` column. SQL-side queries that aggregate across game types are nonsensical by construction.

## 3. History of "matchmaking"

`MatchmakingConfig` was introduced in commit `94a938b` (Apr 5 2026, "feat: execute full plugin architecture refactor (phases 1-10)"). At that point:
- `LobbyPhase` was `{phaseId: string, config: Record<string, any>, run(ctx): PhaseResult}` — a config-pointer shape, not a live instance.
- `GameLobbyConfig.phases` was `LobbyPhaseConfig[]` (objects, not instances).
- `matchmaking: MatchmakingConfig` was added alongside, sized to look authoritative.

The intent was clearly forward-looking: separate "matchmaking parameters" (size, queue type, timeout) from "what stages the lobby walks through". A future MatchmakingDO or queue manager would read these to assemble lobbies from a global queue.

Five days later, commit `9e82489` ("feat: generic lobby phase runner — zero game-specific code in platform layer") rewrote `LobbyPhase` to be a class instance with the current interface (init/handleAction/handleJoin/handleTimeout/getView). The phase config shape went from `{phaseId, config}` POJOs to constructor args on real classes. **`matchmaking` was left untouched.**

That refactor's commit message:
> Delete engine's LobbyPipeline and CtL's LobbyManager (replaced by phase runner)
> LobbyPhase interface gains tools[], guide(), getView(), handleAction(), onTimeout()
> LobbyDO iterates phases generically, drives alarms, exposes phase tools via MCP

No mention of matchmaking. The field was orphaned silently — the new `OpenQueuePhase(minPlayers)` and `TeamFormationPhase({teamSize, numTeams})` constructor args ate every value `MatchmakingConfig` used to convey, but the type stayed required.

No git evidence of a `MatchmakingPhase` ever existing. No `docs/plans/matchmaking*` file. No wiki page on matchmaking. `wiki/architecture/engine-philosophy.md:45` mentions matchmaking once, in a parenthetical about why the v2 push-into-one-DO design was needed:
> OATHBREAKER's pre-v2 design baked `phase: 'waiting'` into game state and required separate endpoints; that broke every generic feature (lobby UI, matchmaking, settlement). The v2 fix was to push all of that under one DO and one phase pipeline.

So "matchmaking" was always meant as "the lobby UI + queue concept" — never a separate subsystem. The `MatchmakingConfig` field is residue from when the *shape* of phases was being designed and someone wanted a place to put min/max bounds. The OpenQueuePhase constructor absorbed that responsibility.

**Verdict:** Pre-launch placeholder. Delete the field, delete `queueType`, the only readers are test fixtures and a misleading comment.

## 4. Per-plugin pre-game flow traces

### 4.1 Capture the Lobster (the only multi-phase game)

```
POST /api/lobbies/create { gameType: 'capture-the-lobster', teamSize: 4 }
  → handleCreateLobby (workers-server/index.ts:603)
  → INSERT INTO lobbies (id, game_type='capture-the-lobster', team_size=4, phase='lobby')
  → POST LobbyDO/  { lobbyId, gameType, teamSize, noTimeout }
    → LobbyDO.handleCreate (LobbyDO.ts:236)
    → teamSize DROPPED at destructure (:244) — see sizing-bugs B1
    → firstPhase = new TeamFormationPhase({ teamSize: 2, numTeams: 2 })   // module-load constants
    → _phaseState = firstPhase.init([], {})
    → _meta.phase = 'lobby', currentPhaseIndex = 0
    → setAlarm(now + 600s)

POST /api/player/lobby/join × 4
  → handlePlayerLobbyJoin (workers-server/index.ts:831)
  → single-session check (existing player_sessions row?)
  → POST LobbyDO/join  { handle, elo }   header X-Player-Id
    → LobbyDO.handleJoin (LobbyDO.ts:327)
    → outer guard _meta.phase==='lobby' ✓
    → idempotency check 1, balance check, idempotency check 2
    → _agents.push(agent)
    → phase.acceptsJoins=true, phase.handleJoin → unassigned.push(playerId)
    → saveState, broadcastUpdate

[Players use propose_team / accept_team via /api/player/tool]
  → tool-dispatcher.ts resolves declarer='lobby', phaseId='team-formation'
  → POST LobbyDO/action  { type: 'propose_team', payload: { targetHandle } }
    → handleAction (LobbyDO.ts:402) → phase.handleAction
    → TeamFormationPhase.handlePropose → maybeComplete
    → If 2 teams of 2 are full → result.completed = { groups, metadata: { teams } }
    → processActionResult → advancePhase

advancePhase (LobbyDO.ts:594)
  → Object.assign(accumulatedMetadata, { teams: [...] })
  → currentPhaseIndex = 1
  → nextPhase = new ClassSelectionPhase({ validClasses: ['rogue','knight','mage'] })  // module-load
  → _phaseState = nextPhase.init(players, accumulatedMetadata)
  → setAlarm(now + 600s)
  → updateLobbyPhaseInD1  (phase still 'lobby' on the wire)

[Players use choose_class via /api/player/tool]
  → ClassSelectionPhase.handleAction → record pick
  → When all picked → completed = { groups: [allPlayers], metadata: { classPicks } }
  → advancePhase → no more phases → doCreateGame

doCreateGame (LobbyDO.ts:665)
  → plugin.createConfig(_agents, seed, accumulatedMetadata)
    → reads accumulatedMetadata.teams + .classPicks
    → returns { config: CtlConfig, players: [{id, team}] }
  → POST GameRoomDO/ { gameType, config, playerIds, handleMap, teamMap }
  → POST GameRoomDO/action { action: { type: 'game_start' } }
  → INSERT INTO games (game_id, ..., finished=0)
  → _meta.gameId = gameId; _meta.phase = 'in_progress'
  → updateLobbyPhaseInD1
  → close spectator WSes (force re-route to GameRoomDO)
```

**Notes:**
- `acceptsJoins` matters during ClassSelectionPhase. Per sizing-bugs B2, a 5th joiner here passes the outer guard, is appended to `_agents`, and becomes a ghost. The phase silently can't see them because `init()` froze `playerIds` at the previous phase's completion.
- The phase can complete mid-action (`processActionResult:589 → advancePhase`) or on timer (`alarm:199`). Both call `advancePhase` with a `PhaseResult`; control flow merges.

### 4.2 Oathbreaker (single-phase FFA)

```
POST /api/lobbies/create { gameType: 'oathbreaker', teamSize: 20 }
  → INSERT INTO lobbies (..., team_size=20, phase='lobby')
  → LobbyDO.handleCreate
  → firstPhase = new OpenQueuePhase(4)   // constructor arg hardcoded
  → timeout = null → NO alarm set
  → _meta.phase = 'lobby', currentPhaseIndex = 0

POST /api/player/lobby/join × 4
  → 4th join lands
  → OpenQueuePhase.handleJoin:
      updated.playerIds.length === 4 >= minPlayers(4)
      return { state: updated, completed: { groups: [allPlayers], metadata: {} } }
  → processActionResult → advancePhase
  → no more phases → doCreateGame
  → game starts at exactly 4 players regardless of teamSize=20 (sizing-bugs B3)
```

**Why does it complete at min, not max?** No principled reason. `OpenQueuePhase` was sized as "minimum to play", not "target". The class was written without a `maxPlayers`/`target` parameter (`open-queue.ts:13`). The plugin's `matchmaking.maxPlayers: 20` field was meant to be the target, but nothing reads it.

5th /join in OATH after the game already started lands on `LobbyDO.handleJoin`, hits `_meta.phase === 'in_progress'`, returns 409. No ghost-player here — the auto-completion of OpenQueuePhase saves us. The bug shape is different from CtL.

### 4.3 Tragedy of the Commons V2

Identical to OATH. `phases: [new OpenQueuePhase(4)]` at `packages/games/tragedy-of-the-commons/src/plugin.ts:551`. Always starts at exactly 4. Static 19-hex board (`game.ts:1432-1457`) so sizing wouldn't even matter.

### 4.4 Are there other multi-phase games?

`grep -nE 'phases: \[' packages/games`:

```
packages/games/capture-the-lobster/src/plugin.ts:783  phases: [new TeamFormationPhase({...}), new ClassSelectionPhase({...})]
packages/games/oathbreaker/src/plugin.ts:332          phases: [new OpenQueuePhase(4)]
packages/games/tragedy-of-the-commons/src/plugin.ts:208 phases: [new OpenQueuePhase(4)]   (V1, dead)
packages/games/tragedy-of-the-commons/src/plugin.ts:551 phases: [new OpenQueuePhase(4)]   (V2)
```

**CtL is the only game with `phases.length > 1`.** Every line of `advancePhase` (`LobbyDO.ts:594-659`), `accumulatedMetadata` (`:288, 598, 686`), `currentPhaseIndex` (`:84, 619, 623`), and the phase-tools registry in `tool-dispatcher.ts:248-256` exists for CtL alone.

## 5. Phase interface contract

Full surface (`packages/engine/src/types.ts:644-704`):

```ts
interface LobbyPhase<TPhaseState = unknown> {
  readonly id: string;
  readonly name: string;
  readonly tools?: ToolDefinition[];
  readonly timeout?: number | null;       // seconds; null = no timeout
  readonly acceptsJoins?: boolean;        // default false

  init(players: AgentInfo[], config: Record<string, unknown>): TPhaseState;
  handleAction(state, action, players): PhaseActionResult<TPhaseState>;
  handleJoin?(state, player, allPlayers): PhaseActionResult<TPhaseState>;
  handleTimeout(state, players): PhaseResult | null;
  getView(state, playerId?): unknown;
  getTeamForPlayer?(state, playerId): string | null;
}
```

`PhaseActionResult` (`:707-716`):
```ts
{
  state: TPhaseState;
  completed?: PhaseResult;        // signal: phase done
  relay?: Array<{type, data, scope, pluginId}>;
  error?: { message: string; status?: number };   // -> HTTP error
}
```

`PhaseResult` (`:719-734`):
```ts
{
  groups: AgentInfo[][];          // teams or [allPlayers] for FFA
  metadata: Record<string, unknown>;  // merged into accumulatedMetadata
  removed?: AgentInfo[];          // players ejected by this phase
}
```

What controls what:
- `id` — surfaced in the unified spectator payload as `currentPhase.id`. Web `LobbyPage.tsx:305-307` uses it to branch UI (`isTeamPhase`, `isClassSelection`, `_isOpenQueue`).
- `name` — display only.
- `tools` — added to the tool dispatcher's surface for this phase (`tool-dispatcher.ts:248-256`). Routed to `POST LobbyDO/action` with `{type: tool.name, payload: args}`.
- `timeout` — seconds until `LobbyDO.alarm()` fires; `null` means no alarm. Set at create (`LobbyDO.ts:276-282`) and after advancePhase (`:640-644`).
- `acceptsJoins` — gates whether `handleJoin` is *called*. Does NOT gate whether the agent is appended to `_agents` (that's the bug).

**What's missing from the interface:**
- No `handleLeave`. A player can be `removed` by a `PhaseResult` but cannot voluntarily exit.
- No `acceptsJoins` precondition surfaced to the LobbyDO outer guard — it's a private flag the DO reads after deciding to push.
- No declared schema for `metadata` keys. Phase A and Phase B's metadata are merged blindly into the same flat object (`Object.assign` at `:598`), so a later phase can clobber an earlier phase's key.
- No way for a phase to declare "I need this from `accumulatedMetadata` to init". `init(players, config)` accepts `config: Record<string, unknown>` but no phase reads it — see `team-formation.ts:113` and `class-selection.ts:65` (both ignore the second arg).

## 6. Test coverage gaps

### 6.1 The matchmaking-reading tests don't read matchmaking

`packages/engine/src/__tests__/types.test.ts:95-112`:

```ts
const config: GameLobbyConfig = {
  queueType: 'open',
  phases: [
    { phaseId: 'team-formation', config: { rounds: 3 } },     // <-- not a LobbyPhase
    { phaseId: 'class-selection', config: {} },
  ],
  matchmaking: { minPlayers: 4, maxPlayers: 12, teamSize: 2, numTeams: 2, queueTimeoutMs: 120000 },
};
expect(config.phases).toHaveLength(2);
expect(config.matchmaking.teamSize).toBe(2);
```

**Two problems:**
1. The `phases` array contains `{phaseId, config}` POJOs that don't conform to `LobbyPhase` (which requires `init`, `handleAction`, etc.). Vitest passes because esbuild transforms TS without typechecking. The engine's own `tsconfig.json:9` excludes `src/__tests__`, so `tsc --noEmit` won't catch it either.
2. The `matchmaking.teamSize` assertion is a compile-time-only smoke check. There is no runtime that consumes `MatchmakingConfig`, so the test is asserting that the test fixture is shaped like the test fixture.

Same problems in `__tests__/tool-collision.test.ts:76-102` (engine) and the CLI mirror at `packages/cli/src/__tests__/tool-collision.test.ts:96-102`.

The tests **look** like they cover `MatchmakingConfig`. They cover nothing — they just keep the type alive in tsc's view.

### 6.2 `OpenQueuePhase` has no direct test

`grep -rn 'OpenQueuePhase' packages/*/src/__tests__` returns zero hits. Behavior is verified only indirectly via OATH/TotC integration tests in `packages/games/oathbreaker/src/__tests__/` and via the `tool-collision` fixtures. The class is one of the most-impactful pieces of pre-game code (it decides when games actually start for 2 of 3 plugins) and has no unit tests.

### 6.3 `TeamFormationPhase` and `ClassSelectionPhase` have tests

`packages/games/capture-the-lobster/src/__tests__/team-formation.test.ts` (16 `it`/`describe` lines) and `class-selection.test.ts` (11 lines). These cover the in-phase logic but not the LobbyDO integration (ghost-player path).

### 6.4 LobbyDO tests cover the credit gate and spectator leak

`packages/workers-server/src/__tests__/lobby-balance-check.test.ts` — 402 on insufficient credits, success on exact balance. Locks in `B1`-adjacent behavior but doesn't touch sizing/phase iteration.

`lobby-spectator-leak.test.ts` — name suggests visibility filter coverage. Worth a deeper look in a follow-up but not in scope here.

`single-game-exclusivity.test.ts` — the single-session invariant.

**No test exercises** `_meta.phase` state machine across phase transitions, `accumulatedMetadata` accumulation, `advancePhase` boundaries, or the join-during-non-joinable-phase ghost path.

## 7. Architectural verdict

**Lucian's suspicion of "several overlapping systems that don't fit together" is half right.**

What's actually there:

- **One real lobby state machine.** `LobbyDO._meta.phase` + `LobbyDO.currentPhaseIndex` + the active `LobbyPhase` instance. Clean, complete, covered by the unified spectator payload, mirrored to D1 for routing.
- **One real lobby pipeline contract.** `LobbyPhase` is a well-thought-through interface with consistent semantics for `init / handleAction / handleJoin / handleTimeout / getView`. The CtL multi-phase flow exercises it; the FFA single-phase flow degrades to the trivial case correctly.
- **One real player routing system.** `player_sessions` → `lobbies.game_id` resolves location with a single D1 query. The Worker's per-route forwarding (`/api/player/...` and `/ws/player`) consistently uses it.

What's *layered on top* and **vestigial**:

- **`MatchmakingConfig`** — a placeholder from the original v2 refactor; never wired; absorbed by `OpenQueuePhase` and `TeamFormationPhase` constructor args. Read by 0 runtime callers.
- **`queueType`** — same provenance; the two non-`'open'` enum values have never had implementation code.
- **`team_size` D1 column** — display-only, semantics depend on `game_type` sibling. Could be removed if `capacity` were derived server-side.
- **`_meta.phase` coarse enum** — 1 bit shy of expressing the only state distinction users care about ("joinable yet?"). Per-phase `acceptsJoins` carries the bit but isn't consulted by the listing or the outer join guard.
- **Per-surface capacity math** — three formulas across CLI, web, fill-bots, none authoritative. Server has no `capacity` field.

What's **collisions**, not overlaps:

- `_agents.push` happens before `phase.acceptsJoins` is checked. Three layers gate joins (D1 listing, `_meta.phase`, `acceptsJoins`) but none gate at the right level. Result: ghost-player bug.
- `OpenQueuePhase`-completes-at-min vs `matchmaking.maxPlayers`-says-larger. Two declared sources of truth, only the constructor arg is read, the matchmaking field lies.

**Concrete recommendation (delete-not-unify):**

1. **Delete `MatchmakingConfig` and `queueType` from `GameLobbyConfig`** (`packages/engine/src/types.ts:741-755`). Remove the fields from all three plugins. Update `types.test.ts` and the two `tool-collision.test.ts` fixtures. This removes ~25 lines of dead config without touching any runtime path.
2. **Add a `capacity()` method to `LobbyPhase`** (or to the plugin). Each phase knows its own completion rule; let it tell the server. `OpenQueuePhase.capacity()` returns `this.minPlayers`; `TeamFormationPhase.capacity()` returns `this.teamSize * this.numTeams`. Then `handleListLobbies` exposes `capacity`, fill-bots and the web use it, the three per-surface formulas go away.
3. **Refine `_meta.phase` to include the `acceptsJoins` bit** OR (cheaper) **check `currentPhase.acceptsJoins` in the outer guard at `LobbyDO.ts:329`**. The second is one line and stops the ghost-player bug.
4. **Wire `OpenQueuePhase` to a target, not a minimum** — separately from steps 1-3, so OATH/TotC can actually use their advertised maxes once. Requires a target field, sourced from `accumulatedMetadata` populated at `handleCreate` from the wire `teamSize`/`playerCount`. This is the work tracked in `sizing-bugs.md` B1+B3.

None of this is an architectural rewrite. The bones are right. The surfaces around the bones grew organically and a few have rotted. Cut them off, expose one canonical `capacity`, push `acceptsJoins` up one level, and the system collapses to a single coherent pipeline.

Per the pre-launch policy: delete, don't shim.
