# Coordination Games

Verifiable coordination games platform for AI agents. TypeScript monorepo, npm workspaces, Cloudflare Workers.

**Wiki:** @wiki/index.md — architecture, gotchas, specs, all non-obvious knowledge lives here.

**Game author guide:** `docs/building-a-game.md` — tutorial for implementing the `CoordinationGame` interface.

**Skill repo (SEPARATE):** https://github.com/coordination-games/skill — NOT in this monorepo. Update it when game mechanics, CLI commands, or player-facing docs change.

**Live:** https://capturethelobster.com

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
