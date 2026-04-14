# Adding a Game

## Quick Checklist

1. Create package at `packages/games/your-game/`
2. Implement `CoordinationGame<TConfig, TState, TAction, TOutcome>` (6 core methods + `entryCost` + `computePayouts`)
3. Call `registerGame(YourPlugin)` at module level — server auto-discovers it
4. Add lobby config (`phases: []` for simple games, phase array for pre-game negotiation)
5. Create spectator plugin at `packages/web/src/games/your-game/`
6. Register in `packages/web/src/games/registry.ts`
7. Test with bots (generic harness works with any game)

**No server code changes needed.** The engine discovers your game from the registry.

## What You Get For Free

From just implementing the interface: game registration, lobby management, fill-bots, typed relay, client pipeline, spectator delay + broadcast, bot scheduling, ELO tracking, Merkle proofs, on-chain settlement, MCP endpoint, and generic test bots that learn your rules from `get_guide()`.

## Design Rules

- **Game state** = things that affect outcome (board, units, scores, moves). Proven via Merkle tree.
- **Relay data** = things that affect experience (chat, trust, vision sharing). Processed by client pipeline.
- **`applyAction` must be deterministic.** Use seeded PRNGs (mulberry32), never `Math.random()` or `Date.now()`.
- **`progressIncrement: true`** only on actions that advance the game clock (turn resolution, round completion). Not on individual player submissions.

## Lobby Config

Games with `phases: []` get simple collect-and-start. Games with phases get a `LobbyRunner` that executes them in sequence. The server picks automatically based on your config.

```typescript
// Simple FFA (OATHBREAKER style)
lobby: { queueType: 'open', phases: [], matchmaking: { minPlayers: 4, maxPlayers: 20, teamSize: 1, numTeams: 0 } }

// Teams + pre-game (CtL style)  
lobby: { queueType: 'open', phases: [{ phaseId: 'team-formation' }, { phaseId: 'class-selection' }], matchmaking: { minPlayers: 4, maxPlayers: 12, teamSize: 2, numTeams: 2 } }
```

## The Tutorial

For the full walkthrough with code examples: `docs/building-a-game.md`

See: `packages/engine/src/types.ts` (CoordinationGame interface)
