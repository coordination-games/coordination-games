# Model Harness

`packages/model-harness` — one game-agnostic agent runner that drives **any** Coordination Game with **any** model (Claude via local creds, or anything on OpenRouter via native function-calling) through a single MCP integration point (`coga serve --stdio`), then writes a uniform, analyzable transcript and runs an automated judge pass over it.

CLI: `coga-harness run|analyze`. Design blueprint: `docs/plans/unified-model-harness.md`.

Both backends are **validated end-to-end** (2026-06-22): a mixed table of 2 Claude-haiku + 2 `openrouter/minimax/minimax-m2` played Tragedy of the Commons to `phase:"finished"` — full pipeline clean (per-bot transcripts, relay ground truth, manifest, judge `analysis.json`), and a MiniMax seat actually won.

## Why this is the default loop

This is the way we test, research, and develop on the platform. It is not a one-off script — it is the inner loop.

- **For development — the big unlock.** Change engine/plugin/game code, run a *whole game* of real agents against it, and read the outcome — in one command. Because every run writes a structured `manifest.json` + relay log + transcripts, you can diff this run against a previous one and see what your change actually did to play, not just whether tests pass. Tests check invariants; the harness shows you behavior. Reach for it whenever a change could plausibly alter how games *play out*.
- **For research.** Spec-driven batches: pick a game, a set of personas, and a set of models, fan them out concurrently, and let the judge surface betrayals / broken pledges / deception / emergent coordination. Run the *same persona* on Claude and on MiniMax to compare models; run *different personas* on the same model to compare strategies. The interesting findings fall out of `analysis.json`.
- **It rides the real client, not a god-view.** Both backends are real `coga` MCP clients, so every run inherits the relay cursor, the `wait`/WebSocket doorbell, and `AgentStateDiffer` dedup for free — the same path humans take. No polling, no re-shipping full state, no re-implemented turn logic. (See [Relay and Cursor](../architecture/relay-and-cursor.md), [Agent Envelope](../architecture/agent-envelope.md).)

This is the spine of the design: the "cool stuff" lives in the `coga` client, not the server, so anything that wants it must *be* a coga client. Both brains are.

## Relationship to the other bot paths

This **supersedes** `scripts/run-model-harness.ts` (TotC-specific, sidestepped the client, hardcoded schemas, single-JSON-blob, polled god-view). It **folds in** the `fill-bots.ts` / `run-game.ts` Claude-CLI path as its `claude` backend. See [Bot System](bot-system.md) for the older fill-bots flow and the web "Fill Bots" button, which stay as the interactive/spectator path. The harness is the scripted/batch path.

## Quickstart

```bash
# 1. Server up (separate terminal). Pre-builds deps once, then watches only the
#    worker — see the wrangler.toml note; never re-add a [build] command there.
cd packages/workers-server && npm run dev          # http://localhost:8787

# 2. Resolve the seat plan without touching the network (no wallets, no calls):
npx tsx packages/model-harness/src/index.ts run --dry-run runs/treachery-study.yaml

# 3. Run a batch (+ judge if analysis.enabled). OpenRouter seats need the key:
OPENROUTER_API_KEY=sk-or-... INSPECTOR_TOKEN=local-inspector-token \
  npx tsx packages/model-harness/src/index.ts run runs/treachery-study.yaml

# 4. Re-judge an existing run dir without re-playing the game:
npx tsx packages/model-harness/src/index.ts analyze runs/out/run-<id> [--model anthropic/claude-haiku]
```

## Run-spec shape

A single YAML (`runs/*.yaml`) drives a whole batch. The load-bearing fields:

```yaml
game: tragedy-of-the-commons   # any game implementing the CoordinationGame contract
rounds: 4                      # plumbed end-to-end → game maxRounds (see gotcha below)
params: { teamSize: 4 }        # game sizing, forwarded to lobby create
identities: ephemeral          # fresh wallets per run, or 'pool' for ~/.coordination/bot-pool.json
output: ./runs/out             # a run-<id> subdir is created per run
seats:
  - persona: ./personas/peaceful-mediator       # bundle dir: persona.md (+ context/*.md, persona.yaml)
    model: anthropic/claude-haiku               # model string drives backend selection
    count: 2                                    # expands to N seats (personas cycle)
  - persona: ./personas/win-focused-opportunist
    model: openrouter/minimax/minimax-m2
    count: 2
limits:
  maxModelCallsPerBot: 200     # backstop against a stalled bot, not a target
  wallClockMsPerRun: 1200000   # ditto; run ends as soon as phase:finished
analysis:
  enabled: true
  model: anthropic/claude-haiku  # judge model (any backend)
  lenses: [betrayals, brokenPledges, deceptions, coordination, perBot, notableMoments, summary]
```

A **persona is a directory bundle**, not a string: `persona.md` (required, behavior/voice/strategy), optional `context/*.md` (concatenated, sorted), optional `persona.yaml` (`defaultModel`, `extraMcpServers`). Personas are model-agnostic on purpose — that's what lets you benchmark one persona across models. Refs resolve as absolute paths, package-relative (`./personas/...`), or bare bundled names.

Bundled personas (`packages/model-harness/personas/`): `peaceful-mediator`, `anti-overextractor`, `win-focused-builder`, `win-focused-opportunist`. Games: `tragedy-of-the-commons`, `capture-the-lobster`, `oathbreaker`.

## Sample run blueprints

Two committed, ready-to-run specs — start from these, don't write one from scratch:

| Spec | What it demonstrates | Key needed? |
|---|---|---|
| `runs/claude-totc.yaml` | **The dev smoke loop.** 4 Haiku bots play TotC to finish. Fastest feedback; the one to re-run after a code change. | No — local `~/.claude` creds |
| `runs/treachery-study.yaml` | **Mixed-backend research.** 2 Claude-haiku + 2 `openrouter/minimax/minimax-m2`, judge enabled. | Yes — `OPENROUTER_API_KEY` |

To see real output *without running anything*, read `packages/model-harness/examples/sample-run-totc/` — a committed, unedited `manifest.json` + `analysis.json` from a finished TotC run (transcripts/relay omitted to keep it small).

Research is "hold everything constant, vary one axis." Two canonical recipes:

**Model A/B — same persona, two brains** (which model plays the strategy better?):

```yaml
game: tragedy-of-the-commons
rounds: 4
params: { teamSize: 4 }
server: http://localhost:8787
identities: ephemeral
output: ./runs/out
seats:
  - { persona: ./personas/win-focused-opportunist, model: haiku, count: 2 }
  - { persona: ./personas/win-focused-opportunist, model: openrouter/minimax/minimax-m2, count: 2 }
limits: { maxModelCallsPerBot: 200, wallClockMsPerRun: 1200000 }
analysis: { enabled: true, model: haiku }
```

**Persona showdown — same model, four strategies** (no key; which strategy wins on one brain?):

```yaml
game: tragedy-of-the-commons
rounds: 4
params: { teamSize: 4 }
server: http://localhost:8787
identities: ephemeral
output: ./runs/out
seats:
  - { persona: ./personas/peaceful-mediator, model: haiku, count: 1 }
  - { persona: ./personas/anti-overextractor, model: haiku, count: 1 }
  - { persona: ./personas/win-focused-builder, model: haiku, count: 1 }
  - { persona: ./personas/win-focused-opportunist, model: haiku, count: 1 }
limits: { maxModelCallsPerBot: 200, wallClockMsPerRun: 1200000 }
analysis: { enabled: true, model: haiku }
```

To **vary the game** instead, change `game:` to `capture-the-lobster` or `oathbreaker` and adjust `params`/`teamSize` — the harness is game-agnostic, so nothing else moves.

## Backend selection (no per-seat backend field)

`backendForModel(model)` in `src/types.ts` decides purely from the model string:

- `openrouter/...` → **openrouter** (always — even `openrouter/anthropic/...`, to A/B local-creds vs billing)
- `anthropic/...`, `claude/...`, bare `claude|haiku|sonnet|opus`, any `claude-*` → **claude** (local `~/.claude` creds)
- everything else (e.g. `openai/gpt-4o`, `minimax/minimax-m2`, `google/gemini-...`) → **openrouter**

`claudeCliModel(model)` normalizes a claude-backend string into a CLI-valid `--model` (strip `anthropic/`|`claude/` prefix; map `claude-haiku`→`haiku`, etc.). Shared by the gameplay runner **and** the judge so both resolve aliases identically. The OpenRouter runner strips the `openrouter/` prefix before sending the rest verbatim.

## Output anatomy (`runs/out/run-<id>/`)

- `bots/<botName>.jsonl` — one event per line: `session` (start/finished/cap/error), `model_request`, `model_response`, `tool_call`, `tool_result`. The append-only ground truth for what each agent thought and did. (MiniMax transcripts run large — reasoning + every tool turn.)
- `relay.jsonl` — the **relay ground truth** (messaging, attestations, per-game action records), pulled from the admin inspect's `gameInspect.relayMessages`. This is the canonical "what happened," independent of any bot's view. The judge cites it by index (`relayRefs`).
- `manifest.json` — `runId, spec, lobbyId, gameId, seats, outcome, perBot`. `outcome` is the distilled final state (winner, finalScores, round, phase). Diff two manifests to compare runs.
- `analysis.json` — the judge pass: per-lens findings + `perBot` (style, consequentialTurns, trustworthiness, notable) + `summary`.

Run artifacts are gitignored (`runs/.gitignore`, `packages/model-harness/.gitignore`). A curated sample (e.g. `packages/model-harness/examples/sample-run-totc/`) belongs under `examples/`, not in `runs/out/`.

## Gotchas (hard-won — don't re-discover)

- **The harness does NOT load dotenv.** `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`) must be in the actual environment / shell profile, not just `.env`. A `.env` entry alone does nothing.
- **`INSPECTOR_TOKEN` must equal the server's `ADMIN_TOKEN`.** The orchestrator's `waitForFinished` + relay snapshot poll `/api/admin/session/:id/inspect` with the `X-Admin-Token` header (not Bearer). Locally the harness default is `local-inspector-token`, which matches `packages/workers-server/.dev.vars`. Mismatch → every poll fails → empty snapshot, no relay, no outcome.
- **`rounds` is plumbed end-to-end now.** Run-spec `rounds` → lobby-create `maxRounds` → `LobbyDO` metadata → the plugin's `createConfig(_, _, metadata)`. Before this it was silently ignored and games ran the engine default (12). Games that don't read `maxRounds` are unaffected.
- **Snapshot waits for `phase:"finished"`.** A bot can exhaust its model-call budget a beat *before* the final round resolves, so the orchestrator polls (bounded) for `phase:"finished"` rather than snapshotting a mid-game frame. A run killed mid-flight (e.g. the box OOMs) leaves transcripts but no `manifest.json` — that's the signature of an interrupted run, not a code bug.
- **`modelCalls` means different things per backend.** Claude = number of `claude --print` CLI sessions (typically **1** per game — the agentic loop runs *inside* that one process). OpenRouter = explicit `/chat/completions` POSTs (~20/game — the runner drives the loop itself). Don't compare the two numbers directly.
- **`VALIDATION_FAILED` tool results are usually fine.** An agent attempting an illegal move (e.g. `build_road` when it can't) gets `VALIDATION_FAILED: Invalid action`, surfaced as a `tool_result` with `isError:true`. The agent self-corrects and continues — this is the dispatcher's error taxonomy working as designed (see [Bot System](bot-system.md#tool-surface)), not a harness failure. Distinguish from `OpenRouter HTTP`/non-JSON errors, which *are* wire problems.
- **Lobby phase is `in_progress`, not `game`**; the real game id is `state.gameId` (`meta.gameId` confusingly echoes the lobbyId).
- **Don't put a `[build]` command in `wrangler.toml`.** It re-runs on every dev reload and rebuilds into `dist/` dirs the watcher sees → infinite rebuild loop. Deps are pre-built once by the `build:deps` npm script. See the comment in `wrangler.toml`.

## Adding a third backend

One small class implementing `AgentRunner` (`runSession(opts) → SessionResult`), plus a branch in `getRunner()` and `backendForModel()`. The OpenRouter runner (`src/runners/openrouter.ts`) is the template: MCP `listTools()` → provider tool format (no hardcoded schemas), a native function-calling loop, `phase:"finished"` in a tool result ends the session. Zero game-specific code — that's the invariant.
