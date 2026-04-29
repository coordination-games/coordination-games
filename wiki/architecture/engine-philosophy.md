# Engine Philosophy
> The framework is a turn clock + typed data relay; games own all logic. Anything else means we've put rules in the engine that some game will eventually break.

## Why

The v1 engine was turn-batched: the framework collected `submitMove` calls until everyone had moved, then called the game's `resolveTurn(state, moves)` to advance simultaneously. That shape was modeled on Capture the Lobster (hex CTF, simultaneous turns) and looked clean — until OATHBREAKER landed. OB is iterated prisoner's dilemma with immediate resolution: each pledge resolves the moment it hits the room, there is no batch, there is no "everyone's-in" event. The v1 engine had nowhere to put that. We tried bolting `phase: 'waiting'` and game-specific endpoints around the side; every generic feature broke (lobby UI, spectator delay, settlement). The repair (`feat: v2 action-based engine + OATHBREAKER integration`, commit `150e80d`) was to delete the batch model entirely:

> Replace the v1 turn-based engine (submitMove/resolveTurn/GameSession) with v2 action-based model. Games now own turns, phases, resolution, and visibility. Framework is a dumb pipe: action → state → broadcast → maybe set timer.

Two consequences fall out and pin the rest of this doc: (1) the engine never reads game state to make framework decisions — `applyAction` is a black box, action in / state out; (2) one runtime, one DO pair, one set of endpoints handles every game we ship, because no game-specific behavior lives above `applyAction`.

If `wiki/architecture/overview.md` is the map, this is the why-doesn't-the-engine-just-do-X answer.

## How

**The interface.** `CoordinationGame<TConfig, TState, TAction, TOutcome>` (`packages/engine/src/types.ts:137`) is the only contract the framework knows. The load-bearing methods are `validateAction` (`packages/engine/src/types.ts:148`), `applyAction` (`packages/engine/src/types.ts:151`), `getVisibleState` (per-player fog), `getProgressCounter` (monotonic counter for snapshots, `packages/engine/src/types.ts:188`), `isOver`, and `getOutcome`. Notice what is *not* there: no `resolveTurn`, no batch, no phase enum tied to game-specific strings — `getCurrentPhaseKind` returns one of three framework-level kinds (`lobby | in_progress | finished`). Games define their own internal phases; the engine doesn't know about them.

**One engine, two patterns.** `applyAction` returns `ActionResult<TState, TAction>` (`packages/engine/src/types.ts:117`) — a new state plus an optional `deadline` directive. The deadline is the unifying mechanism that lets one engine handle both resolution styles:

- **Simultaneous turns** (CtL): players submit moves individually; CtL's `applyAction` collects them, returning `deadline: { kind: 'absolute', at, action: { type: 'turn_timeout' } }` (`packages/games/capture-the-lobster/src/plugin.ts:113`). When the timer fires, the engine re-enters `applyAction` with the queued system action and the game runs `resolveTurn` internally (`packages/games/capture-the-lobster/src/game.ts:348`).
- **Immediate resolution** (OATHBREAKER): each `applyAction` call mutates state directly and returns `deadline: { kind: 'none' }` (`packages/games/oathbreaker/src/game.ts:262`) — no batching, no timer.

Same code path, two semantics. `GameDeadline` is a discriminated union (`packages/engine/src/types.ts:106`):

- `{ kind: 'none' }` → cancel any current timer.
- `{ kind: 'absolute', at, action }` → set timer to fire at this absolute ms-epoch and re-apply `action` as a system action (`playerId === null`).
- `deadline` field omitted → leave the timer alone.

**The multiplexed alarm.** A Cloudflare Durable Object exposes a *single* alarm slot — `storage.setAlarm(when)` overwrites whatever was scheduled before. `GameRoomDO` has two consumers competing for that slot: turn deadlines (above) and the settlement state machine introduced in Phase 3.2. The fix is `StorageAlarmMux` (`packages/workers-server/src/chain/alarm-multiplexer.ts:51`) — a sorted queue of `{ when, kind, payload }` entries persisted at the single key `alarm:queue`. The DO always re-arms the slot to the earliest queued `when`.

`applyActionInternal` (`packages/workers-server/src/do/GameRoomDO.ts:1069`) routes deadline directives through the mux: `'none'` calls `cancelAlarmKind('deadline')` (line 1098); `'absolute'` cancels any queued deadline entry then schedules a fresh one (lines 1105–1110). The settlement plugin schedules its own entries via the `alarms` capability injected at `packages/workers-server/src/do/GameRoomDO.ts:193`.

When `alarm()` fires (`packages/workers-server/src/do/GameRoomDO.ts:452`) it pops every entry due at `Date.now()` and dispatches by `kind`:

- `kind: 'deadline'` (`packages/workers-server/src/do/GameRoomDO.ts:506`) — if `Date.now() < payload.deadlineMs - 500` it re-queues itself for clock-drift safety, otherwise it applies the stored action as a system action.
- `kind: SETTLEMENT_ALARM_KIND` (`packages/workers-server/src/do/GameRoomDO.ts:494`) — drives the settlement state machine via the plugin runtime.
- Empty `popDue` (spurious wakeup, lines 457–465) — re-arm to the next entry, no dispatch.

Each dispatcher catches its own errors (`packages/workers-server/src/do/GameRoomDO.ts:467-475`), so a broken settlement plugin can't trap the DO in an infinite retry loop and starve turn deadlines.

**The lobby unification rule.**

> One `games` map. One room type. One set of endpoints. If adding a new game requires new server endpoints, new storage structures, or new UI pages — the abstraction is wrong.

The single `games` Map lives at `packages/engine/src/registry.ts:16`; the single `LobbyDO` at `packages/workers-server/src/do/LobbyDO.ts:1` is "zero game-specific code, delegates all game logic to LobbyPhase instances declared by the game plugin via `plugin.lobby.phases[]`". Games with `phases: []` get simple collect-and-start behavior automatically; games with non-empty phases get a `LobbyRunner` over the same DO. OATHBREAKER's pre-v2 design baked `phase: 'waiting'` into game state and required separate endpoints; that broke every generic feature (lobby UI, matchmaking, settlement). The v2 fix was to push all of that under one DO and one phase pipeline.

## Edge cases & gotchas

- **Omitting `deadline` is not the same as `{ kind: 'none' }`.** Omitted = "leave the alarm alone." `{ kind: 'none' }` = "cancel it." Returning `{ kind: 'none' }` from every move when you meant "I haven't changed the timer" will silently drop your turn deadlines.
- **The `at` in `{ kind: 'absolute' }` is ms-since-epoch, not a duration.** Deadline math is the game's responsibility, not the engine's (`packages/engine/src/types.ts:99-103`).
- **Clock drift re-queue.** `dispatchDeadlineAlarm` (`packages/workers-server/src/do/GameRoomDO.ts:511`) checks `Date.now() < payload.deadlineMs - 500` and re-schedules if early. If your action is heavy and you assume the alarm fires exactly at `at`, you can skew snapshots — read the counter, don't read the wall clock.
- **A deadline is a single per-game timer, not a queue.** `applyActionInternal` cancels any queued `'deadline'` entry before scheduling a new one (`packages/workers-server/src/do/GameRoomDO.ts:1105`). Two simultaneously-scheduled deadlines in the mux is a bug.
- **System actions are just `applyAction` with `playerId: null`.** `validateAction(state, null, action)` must accept system actions or the framework will reject its own timer. Easy to forget when adding a new system action type.
- **Progress is derived, not declared.** The engine snapshots whenever `getProgressCounter(newState) > getProgressCounter(prevState)` (`packages/workers-server/src/do/GameRoomDO.ts:1117`). A non-monotonic counter (rewinds, resets-on-phase-change) breaks spectator delay and replay; the `>` guard is defensive but you'll just see no snapshots.
- **`getCurrentPhaseKind` is the only phase enum the engine reads.** Game-internal phase strings (`'waiting' | 'playing' | 'finished'` in OB, `'pre_game' | 'in_progress'` in CtL) are invisible to the framework. Don't try to make the engine route on them.
- **`registerGame` enforces tool-name uniqueness across `gameTools ∪ lobby.phases[*].tools`** (`packages/engine/src/registry.ts:89`, calls `findToolCollisions` defined at `:29`). A duplicate is a hard load-time error; if you fork a phase's tools you'll trip this immediately.

## Pointers

- `packages/engine/src/types.ts` — `CoordinationGame`, `ActionResult`, `GameDeadline`, `GamePhaseKind`.
- `packages/workers-server/src/do/GameRoomDO.ts` — `applyActionInternal` (line 1069), `alarm()` dispatcher (line 452), `dispatchDeadlineAlarm` (line 506).
- `packages/workers-server/src/chain/alarm-multiplexer.ts` — `StorageAlarmMux`, the queue invariants.
- `packages/workers-server/src/do/LobbyDO.ts` — generic phase runner, no game-specific code.
- `packages/engine/src/registry.ts` — the single `games` Map and tool-collision check.
- `wiki/architecture/data-flow.md` — state vs relay, what `getVisibleState` is allowed to filter.
- `wiki/architecture/spectator-system.md` — how `getProgressCounter` drives snapshots and delay.
- `docs/building-a-game.md` — tutorial for implementing `CoordinationGame` end-to-end.
