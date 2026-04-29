# Deploy

`games.coop` (formerly `capturethelobster.com`) ships as **two independent Cloudflare deploys** — neither auto-deploys from git.

## Topology

| Surface | Cloudflare product | Project name | Custom domain |
| --- | --- | --- | --- |
| Web (spectator UI, register, lobbies) | Pages | `ctl-web` | `games.coop` |
| API (Workers + Durable Objects) | Workers | `ctl-server` | `api.games.coop` |

## Deploy commands

```bash
# Workers (server)
cd packages/workers-server && npx wrangler deploy

# Pages (web)
cd packages/web && npm run build && cd ../workers-server && \
  npx wrangler pages deploy ../web/dist --project-name=ctl-web --branch=main
```

Running `wrangler deploy` ships **only the Worker**. The Pages bundle stays stale until you also run `pages deploy`. A typical full prod cut is both commands.

## Auth in non-interactive shells

Wrangler in a non-interactive shell (Borg, CI, scripts) needs `CLOUDFLARE_API_TOKEN` exported — there is no cached OAuth. Provide the token at session start; never commit it.

## Smoke checks after deploy

```bash
curl https://api.games.coop/api/health    # worker
curl -I https://games.coop/                # pages
```

See also: [admin endpoints](admin-endpoints.md), [contracts](../architecture/contracts.md).
