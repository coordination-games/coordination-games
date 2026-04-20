# Coordination Games Wiki

Non-obvious knowledge, design decisions, specs, and gotchas. For the game author tutorial see `docs/building-a-game.md`.

## Architecture

- [Engine Philosophy](architecture/engine-philosophy.md) — action-based design, multiplexed alarm pattern, lobby unification rule
- [Data Flow](architecture/data-flow.md) — game state vs relay data, client-side pipeline, spectator delay
- [Plugin Pipeline](architecture/plugin-pipeline.md) — type-based topological sort, ToolPlugin interface, current + planned plugins
- [MCP Not On Server](architecture/mcp-not-on-server.md) — why CLI is the MCP server, tool visibility rules
- [Spectator System](architecture/spectator-system.md) — progress-based delay, SpectatorPlugin frontend, buildSpectatorView
- [Identity and Auth](architecture/identity-and-auth.md) — ERC-8004, wallet auth, registration flow, bot auth bypass
- [Credit Economics](architecture/credit-economics.md) — entry fees, payout models (CtL vs OATHBREAKER), burn cooldown
- [Contracts](architecture/contracts.md) — 5 contracts on OP Sepolia, settlement flow, relay endpoints
- [Dual-Mode Infrastructure](architecture/dual-mode-infra.md) — in-memory vs on-chain mode, env var branching

## Development

- [npm Workspace Bugs](development/npm-workspace-bugs.md) — devDependencies not installed, @types ghost installs
- [Adding a Game](development/adding-a-game.md) — checklist, what you get for free, lobby config patterns
- [Adding a Plugin](development/adding-a-plugin.md) — server + web halves, capability subsetting, where to register, real abstraction gaps
- [Bot System](development/bot-system.md) — Haiku bots via Agent SDK, auth bypass, generic harness
- [Hex Grid Rendering](development/hex-grid-rendering.md) — flat-top coords, Wesnoth assets, forest layering, map scaling
- [Biome](development/biome.md) — workspace lint + format config, npm scripts, editor integration

## Plans & Specs

Design docs and not-yet-built proposals live in `docs/plans/`, not in the wiki. The wiki describes current repo state; plans describe intended future state. See `docs/plans/` for:

- `unified-tool-surface.md`, `spectator-colocation.md`, `trust-plugins.md`, `oathbreaker-arcade-visual.md`, `oathbreaker-animations.md`, `onchain-reintegration.md`, `create-coordination-game.md`, `generic-bots.md`
