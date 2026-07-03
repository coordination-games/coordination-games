# Campaign Console

Local research dashboard over the model harness: build/launch campaign specs, watch runs live, browse judge results, compare models. `packages/harness-console`. Design history: `docs/plans/campaign-console.md`.

## Run it

```bash
npm run console          # API + built UI on http://127.0.0.1:4310
npm run console:web      # OR: Vite dev server on :5175 (proxies /api → :4310)
npm run build -w packages/harness-console   # build web/dist for the served UI
CONSOLE_HOST=0.0.0.0 npm run console        # expose beyond loopback (e.g. tailnet access)
```

`CONSOLE_HOST`/`CONSOLE_PORT` control the bind. Default is loopback-only on purpose — the console spawns processes and holds secrets, and has no auth; open it up only on networks you trust (tailnet).

Needs the game server up — the console can start it itself (Settings → start local server, spawns `npm run dev` in packages/workers-server and parses wrangler's `Ready on` URL). First-time local D1 needs `npx wrangler d1 migrations apply ctl-db --local` from packages/workers-server or `/api/games` 500s.

## Shape

- **Wrapper, not fork (The One Rule).** The console spawns `coga-harness run <spec.yaml>` / `analyze <runDir>` child processes; zero orchestration logic of its own. Specs it authors land in `runs/specs/`, custom personas in `runs/personas/<slug>/persona.md`.
- **Disk is the source of truth.** History = `runs/out/**` (campaign.json → run cards; manifest.json → overview; analysis.json → judge tabs; bots/*.jsonl → transcripts; relay.jsonl → evidence for `relayRefs`). Job records (live processes, SSE log buffers) are in-memory only — console restart loses nothing durable.
- **Local CLI for bots.** Jobs get `COGA_SERVE_CMD=node packages/cli/dist/index.cjs` (falls back to tsx source if dist is missing — run `npm run build:cli`). The harness default (`npx -y coordination-games@latest`) cold-downloads and both slows MCP attach and version-skews from the repo.
- **Blind-bot protection lives in the harness runner** (`packages/model-harness/src/runners/claude.ts`): hermetic sessions, per-seat private cwd, serialized boots, a boot-verify first call, and a behavioral toolless-session guard. If a seat still dies with `coga MCP server failed to attach`, read that file's comments before touching anything — every layer encodes a measured failure mode (2026-07-03 debugging arc).
- **Secrets:** `~/.coordination/console-secrets.json` (0600), presence-only over the API, enter runs solely as child env (`OPENROUTER_API_KEY`, `INSPECTOR_TOKEN` — defaults to the `.dev.vars` `local-inspector-token`). Every streamed log line passes `redact()`.
- **SSE** (`GET /api/jobs/:id/events`): `status` + `log` events, buffer replayed on connect.

## Gotchas

- Manifest-less run dirs are shown `running` (campaign has a live job) or `incomplete` (interrupted) — synthesized states the harness itself never writes.
- Compare page counts a win when `manifest.outcome.winnerLabel` string-equals a bot name; team-label winners don't match (known v1 caveat). Cross-backend activity uses `consequentialTurns`, never `modelCalls`.
- Killing the console orphans its children (managed game server, harness runs). Stop the managed server + jobs first, or `pkill -f 'model-harness/src/index.ts run'`.
