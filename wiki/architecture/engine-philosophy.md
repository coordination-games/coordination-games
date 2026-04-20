# Engine Philosophy

The engine is a turn clock + typed data relay. Everything else is a plugin.

## Core Principle

The framework never interprets game state. `applyAction()` is a black box — action in, state out. The framework manages the timer, mutex, action log, and broadcast. Games own all logic.

## Why Action-Based (Not Batch)

The original engine used `resolveTurn()` — collect all moves, resolve simultaneously. This broke for games like OATHBREAKER where actions resolve immediately (no simultaneous turns). The action-based engine handles both patterns:

- **Simultaneous turns** (CtL): players submit moves individually, a `resolve_turn` system action fires on deadline
- **Immediate resolution** (OATHBREAKER): each action resolves instantly, no batching needed

One engine, both patterns. The deadline timer is the unifying mechanism.

## Multiplexed Alarm Pattern

`GameRoomDO` has a single Cloudflare DO alarm slot that is shared between turn deadlines and the settlement state machine (Phase 3.2). A `StorageAlarmMux` queues entries shaped like `{ when, kind, payload }` in DO storage; the DO always re-arms the slot to the earliest queued `when`.

`applyAction()` returns a discriminated `deadline` directive (`{ kind: 'set' | 'none' | 'unchanged', ... }`). `'set'` schedules a `kind: 'deadline'` mux entry; `'none'` cancels every queued deadline entry and clears the alarm slot if the queue empties.

When `alarm()` fires it pops every entry due at `Date.now()` and dispatches by `kind`:

- `kind: 'deadline'` — if `Date.now() < payload.deadlineMs - 500` it re-queues itself (early fire), otherwise it applies the stored action as a system action (`playerId = null`).
- `kind: 'settlement'` — drives the settlement state machine.
- Empty pop (spurious wakeup) → re-arm to the next entry, no dispatch.

Each `kind`'s dispatcher catches its own errors so a broken plugin can't trap the DO in an infinite retry loop.

## The Lobby Unification Rule

> One `games` map. One room type. One set of endpoints. If adding a new game requires new server endpoints, new storage structures, or new UI pages — the abstraction is wrong.

OATHBREAKER initially violated this by baking `phase: 'waiting'` into game state and requiring separate endpoints. This broke every generic feature. The fix: all games use the same lobby pipeline. Games with `phases: []` get simple collect-and-start behavior automatically.

See: `docs/building-a-game.md`.
