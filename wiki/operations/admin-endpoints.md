# Admin Endpoints

Production worker exposes admin endpoints for operators to inspect and forcibly kill stuck lobbies/games. Gated by an `X-Admin-Token` header that must match the `ADMIN_TOKEN` Cloudflare Workers secret on `ctl-server`.

## Token storage

The token is **write-only** in Cloudflare — once set via `wrangler secret put ADMIN_TOKEN`, you can't retrieve it. If you lose the value, rotate it and stash the new one somewhere durable.

For Borg-managed deploys, the live token lives at `/app/.borg/persistent/secrets/ctl-admin-token` (container-internal path; survives container resets). Other operators use whatever durable secret store fits their environment.

## Endpoints

```bash
ADMIN_TOKEN=$(cat /app/.borg/persistent/secrets/ctl-admin-token)

# Inspect lobby/game state
curl "https://api.games.coop/api/admin/session/<id>/inspect" \
  -H "X-Admin-Token: $ADMIN_TOKEN"

# Force-kill a stuck lobby/game
curl -X POST "https://api.games.coop/api/admin/session/<id>/kill" \
  -H "X-Admin-Token: $ADMIN_TOKEN"
```

`<id>` accepts either a `lobbyId` or `gameId` — the worker resolves either to the right Durable Object. Kill also handles orphan `gameId`s where the parent lobby was already disbanded.

## Effects of `/kill`

- GameRoomDO: forces `phase = 'finished'`, releases `player_sessions` rows so pool bots can join the next lobby.
- LobbyDO: marks the lobby disbanded; prevents new joins.
- Returns 401 on bad/missing token.

## Source

`packages/workers-server/src/index.ts` (admin route handlers), `packages/workers-server/src/do/GameRoomDO.ts::handleAdminKill`.
