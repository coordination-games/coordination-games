# Engine Philosophy

The engine is a turn clock + typed data relay. Everything else is a plugin.

## Core Principle

The framework never interprets game state. `applyAction()` is a black box — action in, state out. The framework manages the timer, mutex, action log, and broadcast. Games own all logic.

## Why Action-Based (Not Batch)

The original engine used `resolveTurn()` — collect all moves, resolve simultaneously. This broke for games like OATHBREAKER where actions resolve immediately (no simultaneous turns). The action-based engine handles both patterns:

- **Simultaneous turns** (CtL): players submit moves individually, a `resolve_turn` system action fires on deadline
- **Immediate resolution** (OATHBREAKER): each action resolves instantly, no batching needed

One engine, both patterns. The deadline timer is the unifying mechanism.

## Deadline Alarm Pattern

`GameRoomDO` uses a single Cloudflare DO alarm correlated to a persisted `deadline` record in DO storage. `applyAction()` returns `{ deadline }`; the DO writes `{ action, deadlineMs }` and calls `setAlarm(deadlineMs)`. Clearing an active deadline (`deadline: null`) calls `delete('deadline')` and `deleteAlarm()`.

When `alarm()` fires it re-reads the storage record and self-corrects:

- No `deadline` record → no-op. The action that would have cleared it already ran (either an earlier action returned `deadline: null`, or the game finished and the `deleteAlarm`/`delete('deadline')` pair already executed). Stale fires are silently absorbed.
- `Date.now() < deadlineMs - 500` → fired early due to clock drift. Re-arm with `setAlarm(deadlineMs)` and return.
- Otherwise → apply the stored deadline action as a system action (`playerId = null`).

There is no `_timerId` counter. Persisted-deadline + `deleteAlarm()` is enough — a fresh `setAlarm()` overwrites the previous one, and a stale fire that survives is no-op'd by the missing storage record. On apply failure the deadline record is deleted before re-throwing, so a broken plugin can't trap the DO in an infinite alarm-retry loop.

## The Lobby Unification Rule

> One `games` map. One room type. One set of endpoints. If adding a new game requires new server endpoints, new storage structures, or new UI pages — the abstraction is wrong.

OATHBREAKER initially violated this by baking `phase: 'waiting'` into game state and requiring separate endpoints. This broke every generic feature. The fix: all games use the same lobby pipeline. Games with `phases: []` get simple collect-and-start behavior automatically.

See: `docs/BUILDER_NOTES.md` for the full anti-pattern story.
