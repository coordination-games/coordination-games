# Handoff — Stateless Engine Refactor (April 4, 2026)

This document captures the current architectural decisions and what's being built. Read alongside ARCHITECTURE.md and CLAUDE.md.

---

## Core Principle

**A game is `(state, moves) -> newState`.** That's it.

The engine provides a turn clock, typed relay, and verification layer. Game plugins implement pure functions — state in, state out, deterministic by construction. No mutable classes, no caching tricks, no reconstruction.

---

## Architecture Decision: Stateless Engine

### Why

The game engine is the product. CtL is a proof of concept. We want the engine to be the cleanest possible abstraction so other game devs can implement `CoordinationGame` and get lobbies, signing, Merkle proofs, spectator feeds, and settlement for free.

### What We Did

1. **Pure functions.** `resolveTurn(state, moves) -> newState`. All game logic is stateless — state in, state out. No mutable classes.

2. **The plugin is trivial.** `CaptureTheLobsterPlugin.resolveTurn` just calls the pure function. No wrappers, no caching.

3. **Generic GameSession in the engine.** `GameSession<TState, TMove>` works with any `CoordinationGame`. Holds state, tracks move submissions, records state history. Game-specific helpers (e.g. `submitCtlMove`, `resolveCtlTurn`) live alongside the game code.

4. **Chat is relay-only.** Removed `teamMessages` from game state entirely. Chat flows through the typed relay as `type: "messaging"` data. Game state contains only provable game logic — positions, scores, moves.

### What a Game Dev Implements

```typescript
const MyGame: CoordinationGame<Config, State, Move, Outcome> = {
  gameType: 'my-game',
  version: '1.0.0',
  moveSchema: { ... },  // EIP-712 types for signed moves
  
  createInitialState(config) -> state,
  validateMove(state, playerId, move) -> boolean,
  resolveTurn(state, moves) -> newState,
  isOver(state) -> boolean,
  getOutcome(state) -> outcome,
  computePayouts(outcome, players) -> payouts,
}
```

Register it, and the engine handles everything else.

### What the Server Owns (Not the Game Plugin)

- Turn timing and deadlines
- Bot orchestration
- WebSocket spectator feeds
- Fog-of-war filtering for agent views (calls game's `getStateForAgent` or equivalent)
- Relay message routing
- ELO tracking

These are presentation and orchestration concerns. The game plugin is pure game logic.

---

## What Works Right Now

- **Plugin architecture** — CtL, chat, ELO all as separate packages (`@coordination-games/*`)
- **Typed relay** — routes messages by scope, included in state responses via `relay.receive()`
- **Relay-native chat** — chat removed from game state, flows entirely through relay
- **Generic GameSession** — `GameSession<TState, TMove>` in the engine, works with any game
- **Client-side pipeline** — runs in CLI over relay messages
- **Phase-generic move** — works for both lobby actions and gameplay
- **Dynamic guide** — shows game rules, phase-appropriate tools, required plugins
- **289 tests** pass across all packages
- **Live** at capturethelobster.com

## What Still Needs Work

- Plugin config (`~/.coordination/plugins.yaml`) — hardcoded defaults
- Schema registry — types are informal strings
- Dynamic MCP tool generation from phase declarations
- Third-party plugin install flow
- Generic bot harness — bots connecting via standard MCP endpoint (see docs/GENERIC_BOTS_SPEC.md)
- Linting / strict TypeScript (Biome + typescript-eslint, ban `any`)

---

## File Map

```
ARCHITECTURE.md          — Plugin tiers, typed relay, client-side pipeline (AUTHORITATIVE for data architecture)
GAME_ENGINE_PLAN.md      — Full platform vision: identity, economics, on-chain layer (AUTHORITATIVE for vision)
CLAUDE.md                — Dev guide: build commands, known issues, file map
HANDOFF.md               — This document

packages/engine/       — @coordination-games/engine (types, plugin loader, lobby pipeline, MCP, Merkle)
packages/games/capture-the-lobster/ — @coordination-games/game-ctl (pure game functions + plugin wrapper)
packages/plugins/basic-chat/ — @coordination-games/plugin-chat (Tier 2 client-side chat)
packages/plugins/elo/    — @coordination-games/plugin-elo (Tier 3 server-side ELO)
packages/server/         — Express server, WebSocket, MCP, typed relay, bot harness
packages/web/            — React frontend
packages/cli/            — coga CLI with pipeline runner
packages/contracts/      — Solidity contracts
```
