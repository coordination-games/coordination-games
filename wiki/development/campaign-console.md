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

## The demo stack (three services)

- **Console** :4310 — LaunchAgent `coop.games.campaign-console` (KeepAlive, RunAtLoad). Home = three one-click demos; Lab = full config. Boot auto-starts the game server.
- **Game server** :8787 — spawned by the console with `wrangler dev --ip 0.0.0.0` (tailnet spectating; dev ADMIN_TOKEN — trusted networks only).
- **Spectator** :4173 — LaunchAgent `coop.games.spectator` serving packages/web's built app (`vite preview`). Rebuild with `npm run build:local -w packages/web` — NOT plain `build`: `.env.production` pins the prod API URL, and a `--mode` workaround would bake the dev inspector token into the bundle (see packages/web/package.json). RunPage's "▶ watch replay" buttons point here via `window.location.hostname`.

## Process model

Two reliability behaviors, both added 2026-07-16 after production incidents:

- **Boot serialization is machine-wide, not just per-process.** `claude` session boots race their MCP server's startup against the session's tool-list snapshot (see `packages/model-harness/src/runners/claude.ts`'s file-level comment); the runner already serialized spawn→init within one process via an in-process FIFO. But a machine routinely runs more than one harness process at once (a demo alongside a running study), and two processes booting seats at the same moment reproduce the same race one level up — observed as ~65% seat mortality on `concurrency:2` campaigns. `packages/model-harness/src/runners/boot-lock.ts` adds a machine-wide mutex (a lock directory under `os.tmpdir()`, atomic `mkdir`, stale-holder takeover via a dead-pid or >120s-old `meta.json`) that every `claude` boot on the box now also takes, so concurrent processes serialize exactly like concurrent seats do.
- **Harness/analyze children are detached and survive console restarts.** `spawnHarness` in `jobs.ts` spawns with `detached: true` and `unref()`s the child once its stdout/stderr/exit handlers are wired — this moves the child to its own process group, so a console shutdown's SIGTERM-to-group (deploys, crashes, `launchctl unload`) no longer kills in-flight runs with it. Three in-flight studies were lost this way before the fix. Consequence: if the console dies mid-run, the run keeps going and lands its artifacts on disk as usual (disk is truth); the in-memory job record is gone, so the restarted console's job page can't show it — it reappears via the campaigns list once artifacts exist, an acceptable degradation. On boot, the console logs a one-liner (`logOrphanedHarnessProcesses` in `jobs.ts`) if any harness-looking processes are already running, so an operator knows orphans from a previous instance are still working.

## Gotchas

- Manifest-less run dirs are shown `running` (campaign has a live job) or `incomplete` (interrupted) — synthesized states the harness itself never writes.
- Compare page counts a win when `manifest.outcome.winnerLabel` string-equals a bot name; team-label winners don't match (known v1 caveat). Cross-backend activity uses `consequentialTurns`, never `modelCalls`.
- Killing the console still orphans the managed game server (that spawn path isn't detached). Harness/analyze jobs now survive a console kill by design (see Process model above) — stop them explicitly via the job's stop button/`/api/jobs/:id/stop`, or `pkill -f 'model-harness/src/index.ts run'`, if you actually want them gone.
