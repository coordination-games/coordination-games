# Coordination Games — Before/After Report for Lucian

**From:** Djimo Serodio (Comedy of the Commons / Agent-Games)  
**Date:** 2026-04-08  
**Upstream repo:** `coordination-games/coordination-games` (clone at `/Users/djimoserodio/Documents/coordination-games`)

---

## Executive Summary

We spent a sprint investigating your `coordination-games` repo from the perspective of integrating Comedy of the Commons, improving upstream builder ergonomics, and validating the engine's fit for complex negotiation games. Here's what we found.

---

## BEFORE: State of the Repo at Sprint Start

### What worked well
- Clean `CoordinationGame<TConfig, TState, TAction, TOutcome>` interface — 6 methods, well-specified
- Functional streaming action model with deterministic `applyAction`
- Lobby pipeline with typed relay, plugin architecture, and MCP tool surface
- Two live games: Capture the Lobster (hex grid CTF) and Oathbreaker (iterated prisoner's dilemma)
- ERC-8004 integration, on-chain settlement, EigenTrust graph scaffolding
- `generateGuide()` dynamic guide generation per game
- Phase-aware MCP tool visibility (`mcpExpose`)

### Builder pain points (critical gaps)
1. **No getting-started guide** — fresh clone has no public docs on how to build and run locally
2. **`better-sqlite3` native build failure on Node 23/24** — blocks `npm install` on modern machines
3. **No "how to add a game" walkthrough** — the plugin interface is clear but the scaffolding story is absent
4. **No MCP tool contract doc** — no explicit reference for what `get_guide`, `get_state`, `submit_move` do in various phases
5. **Architecture docs buried** — `docs/planning/` exists but `docs/` README has no links to actual dev guides

---

## AFTER: What We Improved

### Upstream docs and ergonomics (3 commits)

**`docs/builder-quickstart.md`** (NEW)  
Fastest-path guide from clone to running local platform. Covers:
- Node 22 runtime requirement with `.nvmrc`
- Dependency-order install/build/run commands
- Core file map (engine, games, plugins, server, web, cli)
- Plugin extension model overview
- Common local-dev pain points and workarounds

**`docs/mcp-tool-contract.md`** (NEW)  
Explicit MCP tool contract documenting:
- Core tools: `get_guide`, `get_state`, `submit_move`, `wait_for_update`
- Phase-aware availability table (lobby vs playing)
- Action shape guidance (discriminated union vs free-form)
- Plugin extension rules and naming conventions
- What belongs in core tools vs game actions vs plugin tools

**`.nvmrc` + CLAUDE.md + README.md updates**  
- Node 22 pinned as expected runtime baseline
- CLAUDE.md Running section rewritten with tested workflow
- `@rollup/rollup-darwin-arm64` workaround documented for Darwin ARM64

### Comedy-of-the-Commons plugin prototype (1 commit)

**`packages/games/comedy-of-the-commons/`** (NEW)  
Minimal first-slice plugin validating the engine can handle a complex negotiation game:
- 4 players, FFA, fixed 19-hex world map, 3 ecosystems
- 3 mechanics: production wheel, structured trade (offer/accept), building + ecosystem extraction
- Win condition: first to 10 VP or highest VP at turn 20
- `requiredPlugins: ['basic-chat']` — uses the existing chat plugin
- Build verified: `tsc --skipLibCheck` exits 0

This proves the streaming action model works for games where negotiation is free-form chat (not a game action), while resolution still flows through `applyAction`.

---

## How Comedy of the Commons Fits

### Current fit
- **Negotiation:** Free-form via `basic-chat` relay (not a game action) — clean fit for the engine's design
- **Production/building/extraction:** Works within `applyAction` + phase loop
- **No armies, no fog of war, no crises** — simpler than CtL in some dimensions
- **MCP surface:** Comedy uses 12 Comedy-specific tools; upstream has 4 core tools. We'll add aliasing at the MCP adapter layer.

### Limitations
- Comedy's 19-hex world map is larger than CtL's typical maps — need to verify spectator view handles larger tile counts
- Ecosystem extraction with health tracking requires custom logic in `applyAction` — works but needs careful state management
- Comedy's negotiation is purely chat-based — there's no structured "propose_trade" game action, just free-form messages. The plugin includes a `submit_trade` action but it's optional.

---

## Recommendations for Upstream

### High priority
1. **Fix `better-sqlite3` on Node 23/24** — either pin Node 22 officially and enforce it, or migrate to a pure JS SQLite alternative
2. **Add a `CONTRIBUTING.md`** — how to fork, branch, test, and PR
3. **Add scaffold command** — `coga init-game` that bootstraps a new game package from a template

### Medium priority
4. **Document the lobby phase runner** — `LobbyPhase`, `PhaseContext`, `PhaseResult` are powerful but under-documented
5. **Add `createConfig` examples** — both FFA (Oathbreaker style) and team-based (CtL style) should be shown
6. **Better error messages in `applyAction`** — currently silent state returns make debugging harder

### Nice to have
7. **CI/CD test for Node 22 compatibility** — catch native module regressions early
8. **`getPlayersNeedingAction` refinement** — not all games need this; document when to implement it

---

## What's Next for This Repo

We have:
- Comedy plugin building and registering correctly
- Art direction overhaul committed to Agent-Games (`b2cf8aa`)
- MCP compatibility layer in Agent-Games (`get_guide`, `get_state`, `submit_move` aliases)
- A working local dev environment for both repos

Next steps:
1. Run 4-agent game of Comedy-of-the-Commons through the engine (validate lobby → game → scoring end-to-end)
2. Align Agent-Games MCP surface more closely with upstream `CoordinationGame` interface
3. Write a proper before/after PR description for Lucian with the docs improvements

---

## Files Changed (Upstream Clone)

| Commit | Files | Description |
|--------|-------|-------------|
| `d6672c0` | `.nvmrc`, `docs/builder-quickstart.md`, `docs/mcp-tool-contract.md`, `README.md`, `docs/README.md`, `CLAUDE.md` | Builder docs + Node 22 pin |
| `acae6e2` | `CLAUDE.md`, `package-lock.json`, `packages/web/package.json` | Tested Node 22 workflow + rollup fix |
| `6227099` | `packages/games/comedy-of-the-commons/` (new) | Comedy plugin prototype |
