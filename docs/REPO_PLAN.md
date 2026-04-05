# Coordination Games — Repo & Package Plan

## Organization

**GitHub org:** `coordination-games`
**License:** FSL-1.1-MIT (cutover: April 20, 2029)

---

## Nomenclature

| Term | What it means | Package |
|------|---------------|---------|
| **Engine** | The generic framework — types, game session, plugin loader, MCP tools, Merkle proofs. Games and plugins build against this. | `@coordination-games/engine` |
| **Server** | The runnable Node.js server — Express, WebSocket, API routes, bot harness. Wires engine + games + plugins into a deployable thing. | `@coordination-games/server` |
| **Platform** | The whole deployed product. "Coordination Games platform" = server running the engine with games loaded. Not a package name. | (not a package) |
| **Game plugin** | A `CoordinationGame` implementation (e.g. Capture the Lobster). Plugs into the engine. | `@coordination-games/game-ctl` |
| **Tool plugin** | A `ToolPlugin` implementation (e.g. chat, ELO). Composable, pipeline-friendly. | `@coordination-games/plugin-*` |
| **CLI** | The player-facing CLI and MCP server. What gets `npm install -g`. | `coordination-games` |

---

## Repositories

### 1. `coordination-games/coordination-games` (monorepo)

The core platform. Everything that ships together lives here.

**Packages:**

| Directory | npm package | What |
|-----------|-------------|------|
| `packages/engine` | `@coordination-games/engine` | Generic game framework |
| `packages/server` | `@coordination-games/server` | Node.js server |
| `packages/web` | `@coordination-games/web` | React spectator frontend |
| `packages/cli` | `coordination-games` | Player CLI + MCP server |
| `packages/contracts` | `@coordination-games/contracts` | Solidity contracts |
| `packages/games/capture-the-lobster` | `@coordination-games/game-ctl` | CtL game plugin |
| `packages/plugins/basic-chat` | `@coordination-games/plugin-chat` | Chat tool plugin |
| `packages/plugins/elo` | `@coordination-games/plugin-elo` | ELO tool plugin |

**Why monorepo:** Engine API is actively iterating. Cross-cutting changes (rename a type in engine, update everywhere) are one PR instead of 8. Split repos add friction that isn't justified yet.

**Official plugins stay here** but publish as separate npm packages. Third-party plugins live in their own repos. The interface is identical — both import from `@coordination-games/engine`.

### 2. `coordination-games/skill` (tiny repo)

Just the SKILL.md file for agent installation:

```bash
npx skills add -g coordination-games/skill
```

One file, no build, no npm. Exists so the skills CLI install is clean.

### 3. (Future) `coordination-games/create-coordination-game`

Scaffolder CLI like `create-next-app`:

```bash
npx create-coordination-game my-cool-game
```

Generates a standalone repo with:
- Skeleton `CoordinationGame` implementation
- `package.json` depending on `@coordination-games/engine` (from npm)
- Dev script that spins up a local server with the game loaded
- Working tests against the engine
- Example moves, example guide output

Strictly better than "fork my repo" — no monorepo cruft, always latest engine, can include setup prompts.

**Build this when the engine API stabilizes**, not before.

---

## Player Install UX

Two steps:

```bash
# 1. Install the skill (teaches Claude how to play)
npx skills add -g coordination-games/skill

# 2. Install the CLI/MCP server
npm i -g coordination-games
```

Then tell Claude: "Play Capture the Lobster"

---

## Game Builder Install UX

```bash
# Scaffold a new game
npx create-coordination-game my-game

# Or manually:
npm init
npm install @coordination-games/engine
# Implement CoordinationGame interface
# Register with a running server
```

---

## Why Not Split Repos Now?

1. **Engine API isn't stable** — every type change would require publish → update → test across repos
2. **Small team** — 12 repos = 12x the maintenance overhead (CI, releases, version pinning)
3. **Cross-cutting changes are common** — renaming a field in engine affects server, game, plugins
4. **npm workspaces are already painful** — adding cross-repo versioning on top would be worse

Split when: engine API is stable, there are 3+ external game builders, and the monorepo is genuinely slowing people down.

---

## License

FSL-1.1-MIT with a 3-year change date (April 20, 2029 instead of the default 2-year).

This means:
- Source-available immediately
- Non-compete restriction for 3 years (can't use it to build a competing platform)
- Converts to full MIT license on April 20, 2029
- Standard FSL-1.1-MIT otherwise — permits internal use, modification, non-competing products
