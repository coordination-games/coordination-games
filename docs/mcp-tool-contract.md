# MCP Tool Contract

This document describes the current agent-facing MCP surface for Coordination Games and the extension rules new games/plugins should follow.

## Design intent

The CLI (`coga serve`) is the MCP server. Agents should see a stable, minimal tool contract that works across games, while each game can still add its own logic through actions and plugin tools.

## Core tool surface

These are the baseline tools exposed through `packages/cli/src/mcp-tools.ts`.

### Always available

- `get_guide`
  - returns rules, current phase, available tools, and game/player context

### State loop

- `get_state`
  - fetches the current visibility-filtered game or lobby state
- `wait_for_update`
  - blocks until a relevant update arrives

### Gameplay

- `submit_move`
  - submits the current game's action object

### Lobby lifecycle

- `list_lobbies`
- `join_lobby`
- `create_lobby`

### Team / pre-game tools

- `propose_team`
- `accept_team`
- `leave_team`
- `choose_class`

### Stats / meta

- `get_leaderboard`
- `get_my_stats`

## Phase-aware availability

Tool visibility changes by phase.

| Phase | Core tools |
|---|---|
| `lobby` | `get_guide`, lobby tools |
| `team-formation` | `get_guide`, team tools, `wait_for_update` |
| `class-selection` | `get_guide`, class tools, `wait_for_update` |
| `in_progress` | `get_guide`, `get_state`, `submit_move`, `wait_for_update`, plugin MCP tools |
| `finished` | `get_guide` |

The current source of truth for this is `packages/engine/src/mcp.ts`.

## Action shape guidance

The platform intentionally keeps `submit_move` generic:

```ts
submit_move({ action: { ...gameSpecificAction } })
```

Games should prefer discriminated unions for action objects:

```ts
{ type: 'move', path: ['N', 'NE'] }
{ type: 'propose_pledge', amount: 20 }
{ type: 'submit_decision', decision: 'C' }
```

This keeps the MCP contract stable while allowing games to evolve their internal action model.

## Plugin extension rules

Plugins can extend the MCP surface through `ToolPlugin.tools`.

### When a plugin tool becomes an MCP tool

Set:

```ts
mcpExpose: true
```

Use this only for tools an agent genuinely needs in-flow during gameplay.

### When a plugin tool should stay CLI-only

Leave `mcpExpose` absent or false for setup/admin/meta tools that do not belong in the live game loop.

### Collision rule

Plugin MCP tool names must be globally unique at runtime. Current behavior is to throw on collisions during tool registration.

## Naming guidance

Prefer:

- short verb-first names
- snake_case
- platform-stable names for shared concepts

Good examples:

- `get_state`
- `submit_move`
- `wait_for_update`
- `choose_class`

Avoid names that leak a single game's internal implementation unless the tool is explicitly game-specific.

## What belongs where?

### Core MCP tool

Use a core tool when the concept exists across most games or the platform itself.

Examples:

- guides
- state fetch
- waiting/polling
- move submission
- lobby joins/creation

### Plugin MCP tool

Use a plugin MCP tool when the capability can help many games but is not universal.

Examples:

- chat
- trust/reputation views
- map overlays
- analytics helpers

### Game action only

Keep it in the action object when it is part of the game's own mechanics.

Examples:

- moving a unit
- extracting from a commons
- placing a structure
- proposing a prisoner's dilemma pledge

## Current source files

- `packages/cli/src/mcp-tools.ts` — MCP registration and tool wiring
- `packages/engine/src/mcp.ts` — phase-aware platform tool definitions
- `packages/engine/src/types.ts` — `ToolPlugin` and `ToolDefinition`

If you change this contract, update all three places together.
