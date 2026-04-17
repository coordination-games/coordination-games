# Coordination Games Wiki

Non-obvious knowledge, design decisions, specs, and gotchas. For the game author tutorial see `docs/building-a-game.md`.

## Architecture

- [Engine Philosophy](architecture/engine-philosophy.md) — action-based design, timer stale-ID pattern, lobby unification rule
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
- [Bot System](development/bot-system.md) — Haiku bots via Agent SDK, auth bypass, generic harness
- [Comedy Sweep](development/comedy-sweep.md) — thin Comedy-first persona/model sweep lane
- [Hex Grid Rendering](development/hex-grid-rendering.md) — flat-top coords, Wesnoth assets, forest layering, map scaling

## Specs (Designed, Not Yet Built)

- [Trust Plugins](specs/trust-plugins.md) — 5-plugin trust/reputation suite, EAS attestations, migration plan
- [OATHBREAKER Arcade Visual](specs/oathbreaker-arcade-visual.md) — Yie Ar Kung-Fu aesthetic, sprite system, battle animations
- [create-coordination-game](specs/create-coordination-game.md) — game scaffolder CLI (future)
- [Generic Bots](specs/generic-bots.md) — heuristic bot harness (Claude bots done, random bots not built)
