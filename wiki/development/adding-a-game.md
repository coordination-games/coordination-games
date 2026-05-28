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

From just implementing the interface: game registration, lobby management, fill-bots, typed relay, client pipeline, spectator delay + broadcast, bot scheduling, ELO tracking, Merkle proofs, on-chain settlement, MCP endpoint, and generic test bots that learn your rules from `guide()`.

## Design Rules

- **Game state** = things that affect outcome (board, units, scores, moves). Proven via Merkle tree.
- **Relay data** = things that affect experience (chat, trust, vision sharing). Processed by client pipeline.
- **`applyAction` must be deterministic.** Use seeded PRNGs (mulberry32), never `Math.random()` or `Date.now()`.
- **`getProgressCounter(state)`** returns a deterministic, monotonic non-decreasing counter that bumps when the game clock advances (turn resolution, round completion). Not on individual player submissions.

## Lobby Config

Every game declares at least one `LobbyPhase` instance. The server iterates them in sequence: each phase's `init/handleAction/handleJoin/handleTimeout/getView` runs against opaque `state`, with the result of one phase feeding `accumulatedMetadata` into the next.

```typescript
// Simple FFA (OATHBREAKER style)
lobby: { phases: [new OpenQueuePhase(4)] }

// Teams + pre-game (CtL style)
lobby: {
  phases: [
    new TeamFormationPhase({ teamSize: 2, numTeams: 2 }),
    new ClassSelectionPhase({ validClasses: ['rogue', 'knight', 'mage'] }),
  ],
}
```

The Worker calls `phases[0].capacity(probeState)` at lobby-create time and stores the result on the discovery row (`lobbies.capacity`), so the CLI list, web cards, and `fill-bots.ts` all render the same canonical number. Wire `teamSize` from the create body flows into `phases[0].init([], { teamSize })`, giving phases the final say over their own sizing.

## The Tutorial

For the full walkthrough with code examples: `docs/building-a-game.md`

See: `packages/engine/src/types.ts` (CoordinationGame interface)
