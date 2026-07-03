# Campaign Console

Local research dashboard over the Unified Model Harness: configure and launch campaigns, watch runs live, browse judge results, compare models. The synthesis of two efforts:

- **Engine:** `packages/model-harness` (`coga-harness`) — spec-driven batches, real coga client, transcripts + judge analysis (PRs #49–51).
- **UX concept:** Djimo's Harness Console (`DjimoSerodio/coordination-games-model-harness`, branch `djimo/agent-harness-reliability-artifacts`) — local Node server + single-page console: per-bot persona/model editor, SSE live logs, local secrets, one-click game-server lifecycle.

## Decisions

- **The console wraps the CLI, exactly like MCP does (The One Rule).** It spawns `coga-harness run <spec.yaml>` / `analyze <runDir>` as child processes. No orchestration logic is forked into the console; anything the console needs that the harness lacks gets added to the harness CLI first.
- **Disk is the source of truth.** Run history = `runs/out/**` (`campaign.json`, `manifest.json`, `bots/*.jsonl`, `relay.jsonl`, `analysis.json`). The console holds only in-flight job state in memory; restart loses nothing (fixes the run-list amnesia in Djimo's console).
- **Local-first.** `packages/harness-console`: plain `node:http` API server on `127.0.0.1:4310` + React/Vite front end. Not deployed; `packages/web` / games.coop untouched.
- **Secrets follow Djimo's model wholesale:** `~/.coordination/console-secrets.json` (dir-scoped, `0600`), keys enter runs only as child env (`OPENROUTER_API_KEY`, `INSPECTOR_TOKEN`), never in specs/artifacts/responses, `redact()` on every streamed log line.
- **Live view = SSE** (`/api/jobs/:id/events`) streaming redacted harness stdout; structured live events come from tailing `bots/*.jsonl` (written incrementally by the harness). `manifest.json` appearing is the "run finished" signal.
- **Comparable metric is `consequentialTurns`, never `modelCalls`** (backend call-granularity differs Claude vs OpenRouter — see wiki/development/model-harness.md gotchas). The stale `examples/sample-run-totc` shapes are ignored; code targets `buildOutcome` (orchestrate.ts) and `AnalysisReport` (analyze.ts).

## Server API (`src/server.ts`)

```
GET  /api/meta                        games, persona bundles, model suggestions, output dir
GET  /api/campaigns                   scan output dir → campaign.json summaries + live job overlay
GET  /api/runs/:c/:r                  manifest + hasAnalysis/hasRelay + bot list
GET  /api/runs/:c/:r/analysis         analysis.json
GET  /api/runs/:c/:r/relay            relay.jsonl (parsed)
GET  /api/runs/:c/:r/transcript/:bot  bots/<bot>.jsonl (parsed, ?offset= for tail)
POST /api/campaigns                   {spec} → write YAML under runs/specs/, spawn coga-harness → job
GET  /api/jobs                        in-flight + recent jobs
GET  /api/jobs/:id/events             SSE: status + redacted log lines (replays buffer on connect)
POST /api/jobs/:id/stop               SIGTERM
POST /api/analyze                     {campaign, run, model?} → spawn coga-harness analyze
GET/POST/DELETE /api/secrets          openrouter + inspector token; values never echoed back
GET  /api/server/status               is the game server up (GET /api/games on target)
POST /api/server/start|stop           spawn/kill `npm run dev` in packages/workers-server, detect "Ready on"
```

## Front end (`web/`)

React 18 + Vite + Tailwind, visual language borrowed from `packages/web` (mono labels, dark terminal). Pages:

- **Campaigns** — campaign cards (from `campaign.json`) + running jobs with status pills.
- **New Campaign** — spec builder: globals (server, identities, limits, analysis) + games[] entries (game dropdown, rounds, repeats, params, disablePlugins) + **seats editor** (Djimo's bot-card concept: persona picker over bundled + custom inline persona, model input with per-backend datalist suggestions, count). Launch → live job view.
- **Run detail** — tabs, InspectorPage-style: Overview (seats, outcome, per-bot table) · Analysis (betrayals / broken pledges / deceptions / coordination / notable moments, `relayRefs` resolved inline against relay.jsonl) · Transcripts (per bot, event-kind filter) · Relay.
- **Compare** — per-model aggregation across selected runs: wins, consequentialTurns, judge trustworthiness. The v1 of the model-A/B benchmark view.

## Deferred (follow-ups, mostly in the harness itself)

- Cost/usage tracking + `HARNESS_MAX_COST_USD`-style budget (port from Djimo's runners into `packages/model-harness`).
- Direct MiniMax / OpenCode-Go providers (OpenRouter covers hosted MiniMax today).
- Per-seat sampling overrides (temperature/topP) — needs a spec extension.
- Central ingest server (opt-out upload of run dirs) — the research-data angle; console read-API shapes are designed to be reusable by it.
- Custom persona bundles saved to disk (v1: inline persona text written into a temp bundle per launch).
