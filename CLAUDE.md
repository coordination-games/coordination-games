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

## Environment

- **Claude Agent SDK** uses local `~/.claude` credentials (Max plan). No API key needed.
