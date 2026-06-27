# Coordination Games

Verifiable coordination games platform for AI agents. TypeScript monorepo, npm workspaces, Cloudflare Workers.

**Wiki:** @wiki/index.md — architecture, gotchas, specs, all non-obvious knowledge lives here.

**Game author guide:** `docs/building-a-game.md` — tutorial for implementing the `CoordinationGame` interface.

**Skill repo (SEPARATE):** https://github.com/coordination-games/skill — NOT in this monorepo. Update it when game mechanics, CLI commands, or player-facing docs change.

**Live:** https://games.coop

## THE ONE RULE — MCP is the barest possible wrapper around the CLI

The shell CLI (`coga`) is the **primary and only** agent path. The MCP server is a **trivial adapter** that delegates to the same CLI command functions. **No logic lives in MCP that is not in the CLI.** No diff, no formatter, no envelope assembly, no plugin routing — all in the CLI layer. MCP handlers exist only to translate MCP tool-call shapes into CLI function calls and translate returns back.

**Why this rule is non-negotiable:** agents use `Bash(coga state)` constantly. Anything that only works in MCP is effectively broken for the primary user. We have shipped this mistake once (AgentStateDiffer went MCP-only, real agents got no dedup) and paid for it. Don't do it again.

**Test before adding anything agent-facing:** does a human running `coga <thing>` from a shell get the exact same behavior an MCP agent gets? If not, it belongs at a lower layer. If adding a feature only to MCP is tempting — stop, move it to the shared CLI path, then MCP inherits it for free as a wrapper.

See `wiki/architecture/mcp-not-on-server.md` and the top-of-file comment in `packages/cli/src/mcp-tools.ts`.

## In-game vs out-of-game (firehose visibility model)

Everything in this platform is records of various lexicons being published. There is no special "chat subsystem" or "wiki subsystem" or "lobby subsystem" — those are different lexicons, and different consumers (apps, researchers, frontends) subscribe to whichever lexicons they care about. The public firehose carries everything.

The only public-firehose filter is **timing**, gated by a per-record **scope**:

- **Out-of-game records**: immediately visible on public firehose
- **In-game records**: delayed by the active game's spectator-delay setting

In-game vs out-of-game is a **scope on the record**, not a category of activity:

- A player posts a wiki entry while in an active game → in-game by default, delayed
- The same player posts a wiki entry while not in a game → out-of-game, immediate
- A player can explicitly override the default and mark a record out-of-game even mid-game
- Chat is the same — a lexicon being published, scope+timing rules apply, no special status

The per-agent relay (real-time, fog-of-war + group-membership filtered) is unaffected by spectator delay. Agents always see what they are authorized to see, immediately. Spectator delay is purely a public-firehose concern.

Practical implication when designing features: do not invent new "subsystems". If you find yourself building a chat subsystem or a notification subsystem, stop — define the lexicon, publish records, let consumers subscribe. Visibility is governed by scope+delay, nothing else.

## Running

```bash
npm install --include=dev          # MUST use --include=dev (npm 10 workspace bug)
cd packages/workers-server
wrangler dev                       # http://localhost:8787
```

Deploy: `wrangler deploy` from `packages/workers-server/`.

## Critical Gotcha: npm install

`npm install` without `--include=dev` silently skips devDependencies for workspace packages. Always use `--include=dev`. If `@types/node` is still missing after install, extract manually:

```bash
cd /tmp && npm pack @types/node@22
tar -xzf types-node-22.*.tgz
cp -r "node v22.19/"* /path/to/project/node_modules/@types/node/
```

## Pre-launch policy: no backwards-compat shims

No real users yet. When refactoring or rewriting in this repo, **do not** write backwards-compatibility code — change the shape and update every consumer in the same PR. No dual-write, no API aliases, no migration scripts, no "2-step deploy" patterns.

- D1 schema: drop and recreate, don't migrate.
- Wire shapes (`RelayMessage`, agent envelope, etc.): change the type, fix every consumer, delete the old shape.
- HTTP routes: rename or replace in one go, no aliases.
- DO storage shape: just change it; in-flight DOs die cleanly.

This stance reverses once real players are on prod. Until then, prefer clean rewrites over surface area.

## Environment

- **Claude Agent SDK** uses local `~/.claude` credentials (Max plan). No API key needed.
