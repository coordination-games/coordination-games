# create-coordination-game Scaffolder Spec

## Status: Future — Build After Engine API Stabilizes

CLI scaffolder like `create-next-app`. Generates standalone game plugin project.

```bash
npx create-coordination-game my-cool-game
```

## What It Generates

```
my-cool-game/
  package.json         # depends on @coordination-games/engine
  src/
    plugin.ts          # Skeleton CoordinationGame implementation
    types.ts           # Config, state, action, outcome types
    game.ts            # Core game logic
    phases/            # Optional lobby phases
  test/game.test.ts
  dev/
    server.ts          # Local server with just this game
    bot-test.ts        # Heuristic bot runner
```

## Key Feature: Local Dev Server

`npm run dev` starts a Coordination Games server with only the dev game loaded. Game designers iterate without cloning the monorepo.

## When to Build

Wait until:
- `CoordinationGame` interface stable (no breaking changes 2+ weeks)
- At least 2 external game builders onboarding
- Engine published to npm as `@coordination-games/engine`
