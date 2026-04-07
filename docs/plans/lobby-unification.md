# Lobby & Game Room Unification Plan

**Status: COMPLETED** (2026-04-07)

## What Was Actually Built vs The Plan

The plan was executed in four commits (not three as originally planned):

1. **Commit 1 (merged storage + spectator delay + waiting rooms + callbacks):** Shipped as planned but as a single commit rather than separate ones. `progressIncrement` added to `ActionResult`, `GameRoom` tracks progress counter and snapshots, `getSpectatorView(delay)` method on `GameRoom`. One `GameRoomData` type, one `this.games` map. OATHBREAKER uses server-side `WaitingRoom` (not baked into game state). Unified `wireCallbacks()` for spectator broadcast and bot scheduling via `getPlayersNeedingAction()`.
2. **Commit 2 (unified endpoints + CLI):** Shipped as planned. Removed `/lobby/join-oath`, removed `/games/:id/fill-bots`. CLI simplified to single `joinLobby` call. CLI bumped to v0.4.0.
3. **Commit 3 (lobby UI components):** Componentized into `PlayerList`, `ChatPanel`, `TimerBar`, `FillBotsPanel`, `JoinInstructions`, `TeamPanel`. `LobbyPage` auto-detects game type and renders appropriate components. `PreGamePanel` was not needed yet (deferred until a game needs it).
4. **Commit 4 (documentation):** Updated BUILDER_NOTES.md, CLAUDE.md, and this file.

**Phase 2 follow-up (5 commits, 2026-04-07):** Made the server fully game-agnostic with a plugin registry:

5. **Commit 5 (plugin registry + action passthrough):** Games self-register via `registerGame()` at module level. Server discovers games from registry (`getRegisteredGames()`). Generic `resolveGameRoom()`. Action passthrough for typed actions. `GET /framework` uses `getRegisteredGames()`. New file: `packages/engine/src/registry.ts`.
6. **Commit 6 (buildSpectatorView as required plugin method):** Each game implements `buildSpectatorView(state, prevState, context)` to build its own spectator presentation. Engine calls it with delayed state + `SpectatorContext` (handles + relay messages filtered by `progressCounter`). Server no longer maintains `stateHistory` cache — `buildSpectatorState()` killed.
7. **Commit 7 (playerIds on GameRoom):** `GameRoom.create(plugin, config, gameId, playerIds)`. Generic settlement uses `game.playerIds`. Merkle tree and payouts are game-agnostic.
8. **Commit 8 (guide + summary on plugins + cleanup):** `plugin.guide` for rules text, `plugin.getPlayerStatus()` for player-specific status, `plugin.getSummary()` for game listings. Generic lobby creation reads from `plugin.lobby.matchmaking` config. `OathGameRoom` type alias killed. All stale comments removed.
9. **Commit 9 (generic ELO, kill typed resolvers, kill legacy action parsing):** ELO recording now uses `computePayouts()` output via `recordGameResult()` — works for any game, no game-specific ELO code. Typed resolvers (`resolveGame`/`resolveOathGame`) replaced by single `resolveGameRoom()`. Legacy action parsing removed — server does typed passthrough only, agents send full typed actions. Server has near-zero game-specific type imports.

10. **Commit 10 (lobby unification — WaitingRoom merged into Lobby):** Killed `WaitingRoom` type, merged into unified `Lobby` type with optional `LobbyRunner`. One `this.lobbies` map, one set of endpoints. Simple lobbies (no phases) collect players and auto-promote when full. Frontend uses one lobby view for all game types.

**Deviations from Phase 1 plan (now resolved by Phase 2):**
- `buildSpectatorState()` was fully replaced by `buildSpectatorView()` as a required method on `CoordinationGame`.
- `OathGameRoom` type alias was killed in Phase 2 cleanup.
- `PreGamePanel` component was deferred -- not needed until a game has pre-game phases that need custom UI beyond the existing CtL lobby runner flow.

---

## Problem

Adding OATHBREAKER revealed that the server hardcodes CtL's lobby/game management instead of using the engine's generic abstractions. OATHBREAKER was bolted on with:
- Separate storage (`this.oathGames` vs `this.games`)
- Separate room type (`OathRoomData` vs `GameRoomData`)
- Separate endpoints (`/lobby/join-oath`, `/games/:id/fill-bots`)
- A `phase: 'waiting'` baked into OATHBREAKER's game state (game manages its own matchmaking)
- ~29 references to `this.oathGames` scattered through api.ts
- Spectator delay only works for CtL (custom `stateHistory` array + `buildSpectatorState`), OATHBREAKER has no delay

This means every new game requires forking every endpoint, which defeats the plugin architecture.

## Goal

One `games` map. One room type. One set of endpoints. Generic spectator delay. Any `CoordinationGame` plugin works through the same server infrastructure without game-specific code paths.

---

## Current State

### What's already generic (engine layer — no changes needed)
- `CoordinationGame` interface with `lobby: GameLobbyConfig`
- `GameRoom<TConfig, TState, TAction, TOutcome>` — game-agnostic state machine, **already stores state history** via `getStateHistory()`
- `LobbyPhase` interface — plugins define pre-game phases
- `LobbyPipeline` — runs phases in sequence
- `GameRelay` — typed relay for agent communication

### What's NOT generic (server layer — needs work)

**1. GameServer storage** (`packages/server/src/api.ts`)
- `this.games: Map<string, GameRoomData>` — CtL rooms with CtL-specific fields
- `this.oathGames: Map<string, OathRoomData>` — OATHBREAKER rooms, different type
- `agentGameType` map — tracks which storage to look up per agent (unnecessary with one map)
- `GameRoomData` has CtL-specific fields: `botHandles`, `botMeta` (unitClass, team), `lobbyChat`, `preGameChatA/B`, `stateHistory`, `spectatorDelay`

**2. Spectator delay is CtL-only and redundant**
- Server maintains a `stateHistory: SpectatorState[]` on `GameRoomData` — built by `buildSpectatorState()` (CtL-specific, produces hex grid spectator data)
- `getDelayedState()` returns `stateHistory[currentTurn - spectatorDelay]`
- But the engine's `GameRoom` **already stores state history** via `_stateHistory` and `getStateHistory()`
- And `GameRoom.getVisibleState(null)` already produces spectator views for any game
- So the server is maintaining a **parallel, CtL-specific history** when the engine already has a generic one
- OATHBREAKER has no delay at all — spectators see everything live

**3. Endpoints** — duplicated for each game type
- `/lobby/join` vs `/lobby/join-oath`
- `/lobbies/:id/fill-bots` vs `/games/:id/fill-bots`
- Multiple `if (gameType === 'oathbreaker')` branches

**4. OATHBREAKER game state** — has `phase: 'waiting'` that should be a server concern
- `createOathbreakerGame()` stores target player count on the room object
- `joinOathbreakerGame()` recreates the entire GameRoom when a player joins
- Game starts itself when enough players join — lobby behavior in game logic

**5. Callback wiring** — game-specific
- `wireGameRoomCallbacks()` — CtL-specific, calls `buildSpectatorState`
- `wireOathGameRoomCallbacks()` — OATHBREAKER-specific
- `runBots()` — CtL-specific, checks `state.units` and `hasSubmitted()`

**6. LobbyRunner** (`packages/server/src/lobby-runner.ts`)
- Imports directly from `@coordination-games/game-ctl` (LobbyManager, UnitClass)
- Hardcodes team structure (A vs B), pre-game class selection flow
- **NOT in scope for this refactor** — see "Deferred" section

---

## Implementation Plan — Three Incremental Commits

### Commit 1: Merge Storage, Fix Spectator Delay, Move OATHBREAKER Waiting to Server

**The biggest win with the least risk.** Merge the two maps, make spectator delay generic, give OATHBREAKER a simple server-side waiting room.

**Files:** `packages/server/src/api.ts`, `packages/games/oathbreaker/src/game.ts`, `packages/games/oathbreaker/src/plugin.ts`, `packages/web/src/games/oathbreaker/SpectatorView.tsx`

#### Room Type (just `GameRoom`, not `UnifiedGameRoom`)

```typescript
interface GameRoomData {
  gameType: string;                              // 'capture-the-lobster' | 'oathbreaker' | ...
  plugin: CoordinationGame<any, any, any, any>;  // The game plugin (for getVisibleState, etc.)
  game: GameRoom<any, any, any, any>;            // The engine's game room (has state history built in)
  spectators: Set<WebSocket>;
  finished: boolean;
  externalSlots: Map<string, ExternalSlot>;
  handleMap: Record<string, string>;
  relay: GameRelay;
  botSessions: BotSession[];
  // Lobby chat preserved for spectators (set by lobby runner before game creation)
  lobbyChat?: { from: string; message: string; timestamp: number }[];
  preGameChatA?: { from: string; message: string; timestamp: number }[];
  preGameChatB?: { from: string; message: string; timestamp: number }[];
}
```

**One map:** `this.games: Map<string, GameRoomData>` — same name, new type. Both CtL and OATHBREAKER rooms stored here.

**Kill:** `this.oathGames`, `OathRoomData`, `OathGameRoom` type alias, `agentGameType` map + all ~15 call sites.

#### Generic Spectator Delay

The engine's `GameRoom` already stores full state history via `getStateHistory()`. Use it.

**Kill:** `stateHistory: SpectatorState[]` field on room, `buildSpectatorState()`, server-side `getDelayedState()`.

**Replace with:**
```typescript
function getSpectatorView(room: GameRoomData): unknown {
  const delay = room.plugin.spectatorDelay ?? 0;
  const history = room.game.getStateHistory();
  const delayedIndex = Math.max(0, history.length - 1 - delay);
  const delayedState = history[delayedIndex];
  // Use the game plugin's own getVisibleState with null (spectator)
  return room.plugin.getVisibleState(delayedState, null);
}
```

Every game gets spectator delay for free. CtL sets `spectatorDelay: 2`, OATHBREAKER sets `spectatorDelay: 0`. The engine already has the history, the plugin already has `getVisibleState`. No game-specific spectator building code needed.

**Note:** `spectatorDelay` needs to be added to `CoordinationGame` interface in the engine types. Simple field addition.

#### OATHBREAKER: Remove 'waiting' Phase

- Remove `phase: 'waiting'` from OathState — game starts in `'playing'`
- Remove `game_start` action type
- Remove `joinOathbreakerGame()` (recreates GameRoom on each join — a hack)
- `createInitialState` receives full player list, creates pairings immediately
- Server handles pre-start player collection via a simple waiting room map: `waitingRooms: Map<string, { targetPlayers, currentPlayers[], gameType, config }>`

#### OATHBREAKER SpectatorView Update (coupled — must ship together)

- Remove `phase: 'waiting'` handling from `SpectatorView.tsx`
- SpectatorView only handles `'playing'` and `'finished'`
- Remove "WAITING" badge, idle player grid for pre-start state

#### Generic Spectator Broadcast

One `wireCallbacks()` function for all games:
```typescript
game.onStateChange = () => {
  notifyTurnResolved(gameId);
  // Spectator broadcast uses generic getSpectatorView()
  const view = getSpectatorView(room);
  const msg = JSON.stringify({ type: 'state_update', data: { gameType: room.gameType, ...view } });
  for (const ws of room.spectators) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
  // Notify agents generically
  for (const [agentId] of room.externalSlots) {
    notifyAgent(agentId);
  }
};
```

**Kill:** `wireGameRoomCallbacks()`, `wireOathGameRoomCallbacks()`, `buildSpectatorState()`.

#### Bot Scheduling

- Add optional `getPlayersNeedingAction(state): string[]` to `CoordinationGame`
  - CtL: returns alive units that haven't submitted this turn
  - OATHBREAKER: returns players in active pairings that haven't decided
- Generic `runBots()` calls this instead of checking `state.units`
- **Kill:** CtL-specific `runBots()` that imports from game package

### Commit 2: Unify Endpoints + CLI

**Once storage is merged, collapse duplicate endpoints.** Mostly mechanical deletion.

**Files:** `packages/server/src/api.ts`, `packages/cli/src/game-client.ts`, `packages/cli/package.json`

| Current | After |
|---------|-------|
| `POST /lobby/create` (branches on gameType) | `POST /lobby/create` — creates lobby or waiting room based on game plugin config |
| `POST /lobby/join` + `POST /lobby/join-oath` | `POST /lobby/join` — joins any lobby/waiting room |
| `POST /lobbies/:id/fill-bots` + `POST /games/:id/fill-bots` | `POST /lobbies/:id/fill-bots` — works for any lobby |
| `GET /games` (merges two maps) | `GET /games` — one map |
| `GET /games/:id` (checks both maps) | `GET /games/:id` — one map |
| `GET /games/:id/state` (checks both maps) | `GET /games/:id/state` — one map |

**Kill:**
- `createOathbreakerGame()` — replaced by generic game creation from waiting room
- `wireOathGameRoomCallbacks()` — already killed in Commit 1
- `/lobby/join-oath` endpoint
- All `if (gameType === 'oathbreaker')` branches in endpoint handlers

**CLI ships in this commit:**
- Remove try/catch fallback to `/lobby/join-oath`
- Single `joinLobby` call works for all game types
- Version bump CLI

### Commit 3: Lobby UI Components + OATHBREAKER Lobby Page

**Componentize the lobby UI so any game gets a proper lobby experience.**

**Files:** `packages/web/src/pages/LobbyPage.tsx`, new component files in `packages/web/src/components/lobby/`

Extract building-block components from the current CtL-specific LobbyPage:

```
packages/web/src/components/lobby/
  PlayerList.tsx      — Agent list (works for FFA or teams)
  ChatPanel.tsx       — Lobby chat
  TimerBar.tsx        — Countdown + pause/extend
  FillBotsPanel.tsx   — Admin password + fill button
  JoinInstructions.tsx — Install + join copy-paste
  TeamPanel.tsx       — Team display (only rendered when numTeams > 1)
  PreGamePanel.tsx    — Class selection etc. (only rendered during pre-game phases)
```

LobbyPage renders based on lobby config:
```typescript
// Always:
<PlayerList agents={state.agents} />
<ChatPanel messages={state.chat} />
<TimerBar ... />
<FillBotsPanel ... />
<JoinInstructions lobbyId={id} />

// Conditional:
{lobbyConfig.numTeams > 1 && <TeamPanel teams={state.teams} />}
{state.phase === 'pre_game' && <PreGamePanel ... />}
```

**OATHBREAKER lobby** = PlayerList + ChatPanel + TimerBar + FillBotsPanel. No teams, no class selection. Same page, fewer blocks.

**CtL lobby** = everything. Same as today but using shared components.

**New game lobby** = automatically gets the basics (player list, chat, fill-bots, timer), adds game-specific blocks if it has phases.

---

## What Does NOT Change

- **Engine core** — `GameRoom`, `LobbyPhase`, `LobbyPipeline`, `GameRelay` (only adding `spectatorDelay` field to `CoordinationGame`)
- **Game plugin logic** — `applyAction`, `validateAction`, `isOver`, `getOutcome`, `computePayouts` all unchanged
- **Plugin pipeline** — client-side relay processing unchanged
- **On-chain contracts** — settlement, attestations, balance unchanged
- **Spectator plugin architecture** — each game still has its own SpectatorView component (they just won't need to handle pre-game states)
- **Bot harness** — `claude-bot.ts` is already game-agnostic

---

## Deferred (Do When a Third Game Exists)

### Genericize LobbyRunner
The LobbyRunner is 494 lines of deeply CtL-specific logic (team proposals, invite rounds, negotiation chat with Agent SDK sessions, class selection with discuss-then-pick rounds). OATHBREAKER doesn't need a LobbyRunner — it needs a 30-line waiting room. Extract a common interface when a third game actually needs complex lobby logic.

### Bot Lobby Behavior via get_guide()
Currently bots have hardcoded CtL lobby prompts. Keep hardcoded prompts per game — Haiku with 20s timeouts can't reliably learn lobby behavior from a text guide. Revisit when the pattern is clearer.

### `buildConfigFromLobby` Formal Interface
Two games, two different lobby flows. Just pass metadata through and let each game's `createInitialState` handle it.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Big-bang rewrite breaks live site | **Avoided** — three incremental commits, each independently revertible |
| CtL lobby experience degrades | Low — LobbyRunner stays as-is, CtL game creation path unchanged |
| Old CLI versions break on endpoint removal | Medium — CLI fix ships in same commit as endpoint changes |
| Bot scheduling breaks | Medium — `getPlayersNeedingAction()` is simple and testable |
| Spectator delay regression | Low — using engine's built-in history + plugin's `getVisibleState`, same data, simpler path |
| WebSocket spectator feed breaks | Low — unified to `getSpectatorView()`, same data shape per game |

## Critique Log

This plan was reviewed by two sub-agents and revised twice:

**Architecture critique (v1):** Missing `agentGameType` removal, bot scheduling gap, spectator broadcast divergence, no cumulative lobby phase metadata, coupled phases (4+6), CLI must ship with endpoint changes.

**Practicality critique (v1):** Original plan was a big-bang rewrite, LobbyRunner genericization premature (YAGNI), bot behavior via `get_guide()` unrealistic, frontend componentization has no second consumer. → Restructured into three incremental commits, deferred premature abstractions.

**Lucian feedback (v2):** Frontend componentization IS needed (the whole point of game #2 is to prepare for N games — not YAGNI). Room type should just be called `GameRoomData`, not `UnifiedGameRoom`. Spectator delay is broken — CtL has a custom parallel state history when the engine already has one. Need to investigate and fix.
