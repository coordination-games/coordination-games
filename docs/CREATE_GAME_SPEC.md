# create-coordination-game — Game Scaffolder Spec

A CLI scaffolder like `create-next-app` that generates a standalone game plugin project.

## Install UX

```bash
npx create-coordination-game my-cool-game
```

Generates a ready-to-develop repo at `./my-cool-game/`.

## What It Generates

```
my-cool-game/
  package.json              # depends on @coordination-games/engine
  tsconfig.json
  src/
    plugin.ts               # Skeleton CoordinationGame implementation
    types.ts                # Game config, state, move, outcome types
    game.ts                 # createInitialState, resolveTurn, validateMove
    phases/                 # Optional lobby phases (team formation, etc.)
  test/
    game.test.ts            # Basic tests against the engine
  dev/
    server.ts               # Spins up a local server with the game loaded
    bot-test.ts             # Runs heuristic bots against the game
  README.md
  LICENSE.md                # FSL-1.1-MIT
```

## Key Features

### Local Dev Server

`npm run dev` starts a local Coordination Games server with just their game loaded:

```bash
cd my-cool-game
npm install
npm run dev
# Server running at http://localhost:3000
# MCP endpoint at http://localhost:3000/mcp
# Spectator UI at http://localhost:3000
```

This uses `@coordination-games/server` as a dependency, configured to load only their game plugin. Game designers can iterate on their game without cloning the monorepo.

### Bot Testing

`npm run test:bots` runs heuristic bots (random moves) against the game to verify the game loop works:

```bash
npm run test:bots
# Creating 2v2 game...
# Running 50 turns with random moves...
# Game completed: Team A wins (turn 23)
# All moves validated, no crashes
```

This catches issues like: invalid state transitions, missing edge cases in validateMove, resolveTurn crashes on unusual inputs.

### Interactive Prompts (Future)

Could include setup prompts:

```
? Game name: space-pirates
? Grid type: hex / square / none
? Team sizes: 2-4
? Turn-based or real-time: turn-based
? Include combat: yes
? Include fog of war: yes
```

Each choice templates different starter code. But v1 can just generate a generic skeleton.

## Why Not "Fork the Repo"

1. **No monorepo cruft** — just the game plugin, clean and focused
2. **Always latest engine version** — scaffolder pulls latest `@coordination-games/engine` from npm
3. **Working dev environment out of the box** — `npm run dev` just works
4. **Teaches the interface** — the skeleton shows exactly what to implement
5. **Tests included** — game designers start with passing tests, modify from there

## When to Build

After the engine API stabilizes. If we build it now, we'd be constantly updating the scaffolder templates every time we change the engine interface. Wait until:

- The `CoordinationGame` interface is stable (no breaking changes for 2+ weeks)
- At least 2 external game builders are onboarding
- The engine is published to npm as `@coordination-games/engine`

## Implementation Notes

- Publish as `create-coordination-game` on npm (follows `create-*` convention)
- Use `degit` or similar for template cloning, or just generate files programmatically
- Template lives in `coordination-games/create-coordination-game` repo
- Keep it simple — under 200 lines of scaffolder code, most of the value is in the template
