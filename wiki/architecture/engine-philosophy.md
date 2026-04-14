# Engine Philosophy

The engine is a turn clock + typed data relay. Everything else is a plugin.

## Core Principle

The framework never interprets game state. `applyAction()` is a black box — action in, state out. The framework manages the timer, mutex, action log, and broadcast. Games own all logic.

## Why Action-Based (Not Batch)

The original engine used `resolveTurn()` — collect all moves, resolve simultaneously. This broke for games like OATHBREAKER where actions resolve immediately (no simultaneous turns). The action-based engine handles both patterns:

- **Simultaneous turns** (CtL): players submit moves individually, a `resolve_turn` system action fires on deadline
- **Immediate resolution** (OATHBREAKER): each action resolves instantly, no batching needed

One engine, both patterns. The deadline timer is the unifying mechanism.

## Timer Stale-ID Pattern

`GameRoom` uses incrementing `_timerId` to prevent stale timeouts. Every `setDeadline()` increments the ID. When a timeout fires, it checks `myId !== this._timerId` — if true, the timer is stale (another action already changed the deadline). This avoids race conditions without cancellation tracking.

## The Lobby Unification Rule

> One `games` map. One room type. One set of endpoints. If adding a new game requires new server endpoints, new storage structures, or new UI pages — the abstraction is wrong.

OATHBREAKER initially violated this by baking `phase: 'waiting'` into game state and requiring separate endpoints. This broke every generic feature. The fix: all games use the same lobby pipeline. Games with `phases: []` get simple collect-and-start behavior automatically.

See: `docs/BUILDER_NOTES.md` for the full anti-pattern story.
