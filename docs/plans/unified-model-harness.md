# Unified Model Harness — Design & Implementation Blueprint

**Status:** Proposed, build-ready. All open questions are answered below as *locked decisions*. An implementer (human or autonomous build agent) should be able to take this doc straight to a running sample batch and a sample analysis with no further design input.

**One-liner:** One game-agnostic agent runner that drives any Coordination Game with any model — Claude (via the Agent SDK, local creds) or anything on OpenRouter (via native function-calling) — through a *single MCP integration point* (`coga serve --stdio`), so every run inherits the real cursor/wake/dedup client for free, emits a uniform analyzable transcript, and feeds an automated analysis ("judge") pass.

---

## 1. Goal & non-goals

### Goals
- **One runner, two model backends, zero custom glue between them.** Swapping Claude ↔ OpenRouter is a config field, not a code path. Adding a third backend is one small class.
- **Game-agnostic.** Zero game-specific code in the harness. Everything (rules, tools, valid args, done-signal) comes from the engine at runtime via `guide()`, `currentPhase.tools`, and tool JSON schemas. If a game implements the `CoordinationGame` contract (see `docs/building-a-game.md`), the harness drives it. (TotC v2 already satisfies this — audited.)
- **Rides the real client.** Both backends talk to the same `coga serve --stdio` MCP server, which *is* the real `GameClient` — so both get the relay cursor, the `wait`/WebSocket doorbell, and the `AgentStateDiffer` dedup automatically (see `wiki/architecture/relay-and-cursor.md`, `wiki/architecture/agent-envelope.md`). No re-implementation, no god-view, no polling.
- **Persona = a bundle of files.** A persona is a directory of markdown + optional tools + metadata, layered on top of a shared game-agnostic protocol prompt. Personas are model-agnostic (run the same persona on Claude and on MiniMax to compare).
- **Spec-driven batches.** A single YAML run-spec says: which game, how many rounds, how many agents, which personas, which models, where to write output.
- **Analyzable output + automated analysis.** Every bot's full transcript + the relay ground-truth log + the outcome are collected in a uniform JSONL format, then an analysis pass (itself model-backend-agnostic) produces a structured report of betrayals, broken pledges, deception, emergent coordination, and consequential-vs-talk behavior.

### Non-goals (v1)
- RL training loops / weight updates. (Output format is training-data-ready, but we only *generate and analyze* transcripts.)
- Heuristic/random bots (tracked separately in `docs/plans/generic-bots.md`).
- New agent-facing platform features. Per **THE ONE RULE**, this harness is a *client* of the platform; it adds nothing to the MCP/CLI surface. It reuses `coga serve` as-is.
- Replacing the spectator/web UI fill-bots button (that stays; this is the scripted/batch path).

### Supersedes
This harness **replaces** `scripts/run-model-harness.ts`, `scripts/run-model-harness-event-driven.ts`, and the standalone `coordination-games-model-harness` repo's role. Per the pre-launch *no-backwards-compat* policy, delete those once this lands — do not maintain both. The Claude-CLI fill path (`fill-bots.ts` / `run-game.ts`) is folded in as the `claude` backend.

---

## 2. Background (why this shape)

Two harnesses exist today, generic on *orthogonal* axes:

- **`fill-bots` / `run-game`** (`scripts/lib/bot-agent.ts`): game-generic, but Claude-only. Each bot is `claude --print` → `coga serve --stdio`. Because it *is* a real coga client, it gets cursor/wake/dedup for free and exercises the real MCP tool-use loop. Game knowledge comes from `guide()`; the harness has none.
- **`run-model-harness.ts`** (and the external `coordination-games-model-harness` fork): model-generic (any OpenAI-compatible API), but TotC-specific and it *sidesteps* the client smarts — hardcodes TotC schemas in the prompt, asks for a single JSON blob (no native tool-calling), polls admin god-view for turn order, re-ships full state every call (no dedup), and re-implements the wake decision in the orchestrator.

The unified harness takes the **good half of each**: game-genericity + real-client fidelity from fill-bots, model-genericity from the model harness — by making both backends speak native tool-calling to the same MCP server, with tool schemas supplied by the engine instead of hardcoded.

**Key realization:** the "cool stuff" (per-recipient WS wake, relay cursor, top-level state dedup) lives in the `coga` client (`ApiClient`/`GameClient`), not the server. Anything that *is* a coga client inherits it; anything that isn't must re-implement it. Therefore: **both backends must be coga MCP clients.** That is the spine of this design.

---

## 3. Core decision: single MCP integration point, pluggable brains

```
                         run-spec.yaml
                              │
                     ┌────────▼─────────┐
                     │   Orchestrator   │  parse spec, mint/load wallets,
                     │  ("the runner")  │  create+join+fill lobby, fan out
                     └────────┬─────────┘
            ┌─────────────────┼──────────────────┐
            ▼                 ▼                  ▼          (one per seat, concurrent)
      AgentRunner        AgentRunner        AgentRunner
      (claude)           (openrouter)       (claude)
            │                 │                  │
            ▼                 ▼                  ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ coga serve   │  │ coga serve   │  │ coga serve   │   ← the SINGLE integration
   │ --stdio      │  │ --stdio      │  │ --stdio      │     point. The real GameClient:
   │ (GameClient) │  │ (GameClient) │  │ (GameClient) │     cursor + wait/WS + differ.
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          └─────────────────┴──────────────────┘
                          REST + WS
                     (same path as humans)
                              │
                     ┌────────▼─────────┐
                     │  Workers server  │
                     └──────────────────┘
```

- **The only backend-specific code is the brain loop.** Auth, MCP server spawn, transcript schema, spec parsing, orchestration, and analysis are shared.
- Both brains call the *same* MCP tools (`guide`, `state`, `wait`, `chat`, and the engine's per-phase named game tools). Tool schemas come from MCP `tools/list` — engine-authoritative, game-generic.
- No god-view. Turn-awareness comes from the player-visible state: `currentPhase.tools` is empty when it isn't your turn (TotC v2 confirmed), and `wait` blocks until the server's per-recipient doorbell fires. The server serializes turns; off-turn bots simply `wait`. **The harness owns no turn logic.**

---

## 4. Component breakdown

### 4.1 `AgentRunner` interface (the abstraction)

```ts
interface AgentRunner {
  /** Drive one bot from "already joined the lobby" to game end, talking to its
   *  own coga MCP server. Emits transcript events via onEvent. Resolves when
   *  the bot observes phase:"finished" or hits a wall-clock/turn cap. */
  runSession(opts: {
    botName: string;
    privateKey: string;
    server: string;            // GAME_SERVER
    systemPrompt: string;      // base protocol prompt + persona, pre-assembled
    model: string;             // backend-specific model id
    limits: { maxModelCalls: number; wallClockMs: number };
    onEvent: (e: TranscriptEvent) => void;   // append-only, see §9
  }): Promise<SessionResult>;
}

interface SessionResult { finished: boolean; modelCalls: number; reason: 'finished' | 'cap' | 'error'; }
```

Two implementations. Both connect to `coga serve --stdio --bot-mode --key <pk> --name <botName> --server-url <server>` (exactly the invocation `runClaudeAgent` uses today). The MCP server is the integration point; neither backend touches REST directly.

### 4.2 `ClaudeAgentRunner` (backend: `claude`)

- Uses **`@anthropic-ai/claude-agent-sdk`** `query()` (the TS Agent SDK). Options: `mcpServers: { coga: {...stdio invocation...} }`, `model` (e.g. `haiku`/`sonnet`/`opus` alias), `systemPrompt` (assembled prompt), `allowedTools` (the coga tools), `permissionMode: 'bypassPermissions'`, `maxTurns`.
- **Credentials: local `~/.claude` (Max plan). No API key.** This is already proven in-repo (CLAUDE.md: *"Claude Agent SDK uses local ~/.claude credentials. No API key needed."*). The runner must NOT set `ANTHROPIC_API_KEY`; it relies on the logged-in session, exactly like `runClaudeAgent` does with `claude --print` today. *(If `query()` option names differ in the installed SDK version, fall back to the proven `claude --print --mcp-config ... --dangerously-skip-permissions` subprocess from `scripts/lib/bot-agent.ts:runClaudeAgent`. Both use local creds.)*
- Capture the SDK's streamed messages as transcript events (`summarizeStreamEvent` in `bot-agent.ts` is the starting point; emit structured events instead of console lines).
- **Termination:** the runner inspects each `state`/`wait` tool *result* for `"phase":"finished"` (it sees the structured result, not just stdout — cleaner than today's regex). If the SDK session ends before finished, re-`query()` with the resume prompt (cap = `maxModelCalls`). This is the existing `MAX_RESUMES` loop, made result-driven.

### 4.3 `OpenRouterAgentRunner` (backend: `openrouter`)

The new piece. A standard MCP stdio client + an OpenAI-style function-calling loop:

1. Spawn `coga serve --stdio ...` and connect via `@modelcontextprotocol/sdk` `Client` over stdio transport.
2. `tools/list` → map each MCP tool to OpenAI tools format: `{ type:'function', function:{ name, description, parameters: inputSchema } }`. **No hardcoded schemas** — this is what makes it game-generic.
3. Seed messages with `{role:'system', content: systemPrompt}` + a first user turn ("You are joined; begin. Call guide, then state.").
4. Loop:
   - POST OpenRouter `/chat/completions` with `{ model, messages, tools, tool_choice:'auto' }`.
   - For each returned `tool_call`: `tools/call({ name, arguments })` on the MCP client → append `{role:'tool', tool_call_id, content: <result JSON>}`.
   - If the result JSON contains `"phase":"finished"` → end (finished).
   - If the assistant returned text but **no** tool_calls → append a system nudge ("Not over until phase:finished. Call state/wait or a game action.") and continue; bounded by `maxModelCalls`.
5. Stop on finished / `maxModelCalls` / `wallClockMs`.

- **Credentials:** `OPENROUTER_API_KEY` exported in shell. Never committed. (Generalizes to any OpenAI-compatible base URL — MiniMax direct, etc. — via `OPENAI_BASE_URL` override, but OpenRouter is the default and the recommended path for mixing models.)
- **Model preflight:** before a batch, query OpenRouter's models endpoint and assert each requested model lists `tools` in `supported_parameters`. Fail fast with a clear message if a model can't do function-calling. (Maintain a short known-good list in the doc/README: e.g. `anthropic/claude-*`, `openai/gpt-*`, `minimax/minimax-m2`, `google/gemini-*`.)
- **Context stays lean for free:** because `state` results come from `GameClient` → `AgentStateDiffer`, each `state` tool result is already a dedup'd delta (`_unchangedKeys` + only-changed keys), and `newMessages` is relay-cursor-filtered. The conversation accumulates small deltas, not full re-renders. This is the payoff of riding the real client.

### 4.4 The coga MCP server (reused, unchanged)

`coga serve --stdio --bot-mode --key --name --server-url`. Already exists. Provides `guide`, `state`, `wait`, `chat`, and the engine's per-phase named tools. **Do not modify it for this harness.**

### 4.5 Orchestrator ("the runner")

Mirrors `run-game.ts` / `fill-bots.ts`, generalized:
1. Parse run-spec (§7).
2. Resolve identities (§8): ephemeral wallets or persistent pool; auth (and on-chain register+faucet in chain mode) via `bot-agent.ts` helpers.
3. Create lobby (`gameType`, sizing from spec), join all seats, wait for auto-start (`OpenQueuePhase` fills → game starts; read `lobby.capacity`).
4. For each seat, assemble `systemPrompt = basePrompt + persona`, pick the backend by the seat's `model`, and call `runner.runSession(...)` — **all concurrent** (`Promise.all`). The server serializes turns; off-turn bots `wait`.
5. On completion, fetch the full relay log + final snapshot (§9), write the run manifest, then optionally invoke the analysis pass (§11).

---

## 5. Persona system

A persona is a **directory bundle** — markdown + optional tools + metadata — *not* a string. This is the "personality is a collection of files and tools" requirement.

```
personas/ruthless-opportunist/
  persona.md        # REQUIRED. Instruction/system-prompt fragment (behavior, strategy, voice).
  context/*.md      # OPTIONAL. Extra reference material concatenated into the prompt.
  persona.yaml      # OPTIONAL. Metadata (below). If absent, defaults apply.
```

```yaml
# persona.yaml (all fields optional)
displayName: "Ruthless Opportunist"
defaultModel: anthropic/claude-haiku   # overridable per-seat in the run-spec
extraMcpServers:                       # OPTIONAL extra tools, added alongside coga
  - name: notes
    command: npx
    args: [some-mcp-tool, --flag]
```

**Prompt assembly (shared by both backends):**
```
systemPrompt = BASE_PROTOCOL_PROMPT            // game-agnostic; see below
             + "\n\n## Your persona\n" + persona.md
             + (context/*.md concatenated)
```

- `BASE_PROTOCOL_PROMPT` is the existing `INITIAL_PROMPT` from `bot-agent.ts` (call `guide` first, read `state.currentPhase.tools`, use named tools, error-code self-correction, finish on `phase:"finished"`). It already contains **zero game knowledge** — keep it that way.
- The persona adds *only* behavior/voice/strategy. It must not encode game-specific tool names or arg values (those come from `guide`/schemas/state).
- **Personas are model-agnostic.** `defaultModel` is a convenience; the run-spec's per-seat `model` wins. This lets the same persona be benchmarked across models.
- `extraMcpServers`: persona-specific tools are just additional MCP servers the runner also connects/exposes. Out-of-the-box personas use none. (v1 may stub `extraMcpServers` as "documented but not wired" if it slows the first milestone — note it explicitly if so. No silent gaps.)

Ship 3–4 starter personas (port the existing ones from `run-model-harness.ts`: anti-overextractor, peaceful-mediator, win-focused-builder, win-focused-opportunist) as bundle dirs, made game-neutral (strip TotC-specific phrasing — they should read as dispositions, not commons rules).

---

## 6. Run-spec file format

YAML (JSON also accepted). Drives a whole batch.

```yaml
# runs/treachery-study.yaml
game: tragedy-of-the-commons
rounds: 24                 # maps to game config / HARNESS_ROUNDS-equivalent cap
params:                    # passed to lobby create (game-specific sizing knobs)
  teamSize: 4
server: http://localhost:8787   # or https://api.games.coop
identities: ephemeral      # ephemeral | pool
output: ./runs/out/treachery-study      # dir; runId subdir created per run

# Seat assignment: each entry expands `count` seats. personas cycle if count > 1.
seats:
  - persona: ./personas/win-focused-opportunist
    model: openrouter/minimax/minimax-m2
    count: 2
  - persona: ./personas/peaceful-mediator
    model: anthropic/claude-haiku        # claude backend, local creds
    count: 2

limits:
  maxModelCallsPerBot: 80
  wallClockMsPerRun: 600000   # 10 min

analysis:
  enabled: true
  model: anthropic/claude-sonnet    # judge model (any backend)
  # lenses default to the full set in §11; override here if desired.
```

**Backend selection rule (locked):** a seat's `model` string of the form `anthropic/<alias>` → `claude` backend (local creds). Anything else → `openrouter` backend (`OPENROUTER_API_KEY`). An explicit `openrouter/...` prefix is allowed and routed to OpenRouter even for Anthropic models (lets you A/B "Claude via local creds" vs "Claude via OpenRouter billing"). This single convention removes any per-seat backend field.

---

## 7. Identity & credentials (locked)

- **Bot wallets:** `identities: ephemeral` mints fresh wallets per run (like `run-game.ts`); `identities: pool` uses `~/.coordination/bot-pool.json` (like `fill-bots.ts`). Reuse `bot-agent.ts` `loadPool` / `authenticate` / `registerBotOnChain` / `faucetBot` verbatim. Chain-mode register+faucet only fires when the server is in chain mode (helpers already no-op on 503/mock).
- **Claude backend:** local `~/.claude` creds. No API key set or read. Just works on this machine because it's already logged in — same as the current scripts.
- **OpenRouter backend:** `OPENROUTER_API_KEY` from the shell. Optional `OPENAI_BASE_URL` to target a different OpenAI-compatible endpoint. No secrets in files or the repo.
- **Server:** `server` from spec (or `GAME_SERVER` env fallback). `PATH` must include the global npm bin so `coga`/`claude` resolve (the documented fill-bots gotcha — keep that note in the README).

---

## 8. Transcript & output format (analyzable)

Per run: a directory `output/<runId>/` containing:

```
manifest.json            # run metadata, see below
relay.jsonl              # GROUND TRUTH: the full relay log (who said what to whom)
bots/<botName>.jsonl     # one transcript per bot, append-only event stream
analysis.json            # written by the analysis pass (§11), if enabled
```

**`TranscriptEvent` (one JSON object per line in `bots/<botName>.jsonl`):**
```ts
type TranscriptEvent =
  | { t: number; bot: string; kind: 'model_request';  model: string; messages: unknown }
  | { t: number; bot: string; kind: 'model_response'; text?: string; toolCalls?: {name:string;args:unknown}[]; usage?: unknown }
  | { t: number; bot: string; kind: 'tool_call';      name: string; args: unknown }
  | { t: number; bot: string; kind: 'tool_result';    name: string; result: unknown; isError?: boolean;
      stateVersion?: number; relayCursor?: number }   // see §10
  | { t: number; bot: string; kind: 'session';        event: 'start'|'finished'|'cap'|'error'; detail?: string };
```

- Timestamps (`t`) are wall-clock ms, stamped by the harness (not the model).
- `relay.jsonl` is fetched once at end from the server's relay history (admin/inspect or the player relay history endpoint) and is the **objective record** the judge trusts over any bot's self-report.
- `manifest.json`:
```json
{
  "runId": "...", "spec": { /* the parsed run-spec */ },
  "lobbyId": "...", "gameId": "...",
  "seats": [{ "bot": "...", "persona": "...", "model": "...", "backend": "claude|openrouter" }],
  "outcome": { "phase": "finished", "winner": "...", "replayChrome": { /* getReplayChrome */ }, "finalSnapshot": { /* ... */ } },
  "perBot": [{ "bot": "...", "modelCalls": N, "consequentialTurns": N, "talkOnlyTurns": N, "finished": true }]
}
```

JSONL is the format because it streams, greps, and loads trivially, and it's training-data-ready.

---

## 9. Consequential-action derivation (locked, no new flag needed)

"Consequential" = *mutates canonical (anchored) game state*. We do **not** add a per-tool flag. The engine already exposes the signal: canonical state has its own version/ETag (`knownStateVersion`) independent of the relay cursor (`sinceIdx`). A consequential action bumps the **state version**; a chat/relay-only or read-only turn bumps **only the relay cursor**. (See `wiki/architecture/relay-and-cursor.md` — the two cursors compose independently.)

Implementation: on each `tool_result` event, the runner records the current `stateVersion` (from the state envelope's ETag/`knownStateVersion`) and `relayCursor` (`meta.sinceIdx`). A turn is **consequential iff the state version advanced across it** (equivalently: the agent-envelope had a changed key other than `newMessages`). `pass` is consequential (it advances turn/round); distinguish "punted" from "substantive" at the tool-name level if the judge cares. These counts roll up into `manifest.perBot`.

This gives the analysis pass a free, objective "did they act or just talk?" signal per turn.

---

## 10. Analysis pass ("the judge")

A standalone step that loads `output/<runId>/` and produces `analysis.json`. **Model-backend-agnostic** — it uses the same `AgentRunner`-style backend abstraction (or a thin one-shot model call), so the judge can be Claude or any OpenRouter model.

**Inputs given to the judge:** `relay.jsonl` (ground truth of all messages + scopes, including DMs), each bot's consequential-vs-talk timeline (from §9), the persona each bot was assigned, and the final outcome. The judge is told to trust the relay log over any bot's claims.

**Output schema (`analysis.json`):**
```ts
{
  betrayals:        { round: number; actor: string; victim: string; evidence: string[]; severity: 1|2|3 }[],
  brokenPledges:    { pledge: string; by: string; round: number; evidence: string[] }[],
  deceptions:       { actor: string; claim: string; reality: string; evidence: string[] }[],
  coordination:     { participants: string[]; description: string; heldUntil?: number }[],
  perBot:           { bot: string; persona: string; model: string;
                      style: string; consequentialTurns: number; talkOnlyTurns: number;
                      trustworthiness: 1|2|3|4|5; notable: string[] }[],
  notableMoments:   { round: number; description: string; relayRefs: number[] }[],
  summary:          string
}
```

This deliberately mirrors the trust direction (`trustCards`, `docs/plans/trust-plugins.md`): the same evidence that would feed trust summaries feeds the judge. A `notableMoments[]` + `betrayals[]` report is exactly the "find interesting things / treachery" pass.

Ship a **sample analysis prompt** and a committed **sample `analysis.json`** from the acceptance run (§13) so the format is concrete.

---

## 11. Reuse map (what to take from the existing code)

| Need | Reuse from | Notes |
|---|---|---|
| Auth (ERC-8004), pool, faucet, on-chain register | `scripts/lib/bot-agent.ts` (`authenticate`, `loadPool`, `savePool`, `faucetBot`, `registerBotOnChain`) | Verbatim. |
| Claude brain (proven path) | `bot-agent.ts:runClaudeAgent` | Refactor into `ClaudeAgentRunner`; swap console logging for `onEvent`; prefer Agent SDK `query()`, keep `claude --print` as fallback. |
| Stream-event → structured | `bot-agent.ts:summarizeStreamEvent` | Convert to emit `TranscriptEvent`s. |
| Lobby create/join/fill + auto-start | `scripts/run-game.ts`, `scripts/fill-bots.ts` | Generalize sizing from spec; read `lobby.capacity`. |
| MCP server | `coga serve --stdio --bot-mode` | Unchanged. |
| Base protocol prompt | `bot-agent.ts:INITIAL_PROMPT` / `RESUME_PROMPT` | Becomes `BASE_PROTOCOL_PROMPT`; persona layered on top. |
| Starter personas | `run-model-harness.ts:BOT_PERSONAS` | Port to bundle dirs; strip TotC-specific phrasing. |
| Finished heuristic | `bot-agent.ts:looksFinished` | Replace regex-on-stdout with structured `"phase":"finished"` check on tool *results* (both backends see structured results). |

New code: `OpenRouterAgentRunner` (MCP client + function-calling loop), spec parser, persona loader, transcript writer, orchestrator, analysis pass. New home: `packages/harness/` (a workspace package) or `scripts/harness/` — **decision: a workspace package `packages/model-harness/`** so it can `import` the MCP SDK and (optionally) the engine's `CoordinationGame` types for the manifest, and so `npm` treats it as first-class. CLI entry: `coga-harness run <spec.yaml>` and `coga-harness analyze <runDir>`.

---

## 12. Locked decisions (every open question, answered)

1. **Integration point?** Both backends are coga MCP clients over `coga serve --stdio`. Single integration point. *(Not in-process `GameClient` imports — keep the MCP boundary so it's the exact path a real agent uses and stays decoupled from CLI internals.)*
2. **Tool schemas?** From MCP `tools/list` (engine-authoritative). Never hardcoded.
3. **Turn detection?** Player-visible state only: empty `currentPhase.tools` off-turn + `wait`. No admin god-view. (TotC v2 audited compliant.)
4. **Backend selection?** By the seat's `model` prefix: `anthropic/*` → claude/local-creds; else → OpenRouter. (`openrouter/anthropic/*` forces OpenRouter billing.)
5. **Claude credentials?** Local `~/.claude`. No API key. Confirmed in-repo.
6. **Concurrency?** All bots concurrent; the server serializes turns. Harness owns no turn logic.
7. **Termination?** Structured `"phase":"finished"` in a tool result; plus `maxModelCallsPerBot` and `wallClockMsPerRun` caps. Engine `turn_timeout` covers a stalled bot so the game still ends.
8. **Consequential signal?** State-version bump vs relay-cursor bump (§9). No new engine flag.
9. **Persona shape?** Directory bundle (markdown + optional tools + yaml), layered on the shared base protocol prompt. Model-agnostic.
10. **Output format?** Per-bot JSONL transcripts + `relay.jsonl` ground truth + `manifest.json` + `analysis.json`. JSONL throughout.
11. **Analysis?** A model-backend-agnostic judge producing the §10 schema, trusting the relay log over self-reports.
12. **Identities?** `ephemeral` (default) or `pool`, reusing `bot-agent.ts`.
13. **Home?** New workspace package `packages/model-harness/`, CLI `coga-harness`.
14. **Old harnesses?** Deleted, not maintained alongside (pre-launch no-compat policy). Folded into this.
15. **Game-specific code in harness?** None, ever. Hard constraint, mirrored from fill-bots.

---

## 13. Build milestones (sequenced for autonomous implementation)

Each milestone is independently verifiable. An autonomous build agent should complete and self-verify each before the next.

- **M0 — Scaffold.** `packages/model-harness/` workspace pkg, `coga-harness` bin, spec parser + persona loader with unit tests against the sample spec. Verify: `coga-harness run --dry-run` prints the resolved seat plan.
- **M1 — Orchestrator + Claude backend.** Port `run-game.ts` flow + `ClaudeAgentRunner`. Verify: against local `wrangler dev`, 4 Claude/Haiku bots play TotC v2 to `phase:"finished"`, emitting valid per-bot JSONL + manifest. (This is the existing capability, re-homed and instrumented.)
- **M2 — OpenRouter backend.** MCP client + function-calling loop. Verify: with `OPENROUTER_API_KEY`, a mixed seat plan (2 Claude + 2 `minimax/minimax-m2`) plays TotC v2 to finished; both backends produce identical-schema transcripts; OpenRouter bot constructs valid `extract_commons`/`build_settlement` args **from state + schemas only** (proves game-genericity without hardcoding).
- **M3 — Consequential signal.** State-version vs relay-cursor capture on every tool result; `manifest.perBot` counts populated. Verify: a bot that only chats shows `talkOnlyTurns > 0, consequentialTurns` matching its real moves.
- **M4 — Analysis pass.** `coga-harness analyze <runDir>` produces §10 `analysis.json`. Verify: on the M2 run, it identifies at least the obvious coordination/defection events and per-bot styles; output validates against the schema.
- **M5 — Sample batch + docs.** Commit the sample run-spec, the 4 starter persona bundles, a committed sample `analysis.json` from a real run, and a README (with the `PATH`/creds/OpenRouter-key gotchas). Update `wiki/index.md` + `wiki/development/bot-system.md` to point here and mark the old harnesses removed.

---

## 14. Acceptance criteria (definition of done)

A single command runs the sample batch end-to-end and a single command analyzes it, fully autonomously:

```bash
# batch (mixed Claude-local-creds + OpenRouter models, TotC, to completion)
OPENROUTER_API_KEY=… coga-harness run runs/treachery-study.yaml

# analysis
coga-harness analyze runs/out/treachery-study/<runId>
```

Done when all hold:
1. The batch reaches `phase:"finished"` with no harness-side turn logic and no game-specific code in the harness.
2. Both backends drive TotC v2 from `guide()` + `currentPhase.tools` + state alone — OpenRouter bots never see a hardcoded ecosystem id, region id, or `level` enum.
3. Each bot has a schema-valid JSONL transcript; `relay.jsonl` + `manifest.json` present; `perBot` consequential/talk counts are populated and plausible.
4. `analyze` emits a schema-valid `analysis.json` with a non-trivial summary, ≥1 `notableMoments`, and per-bot style/trust ratings.
5. Swapping a seat's `model` from `anthropic/claude-haiku` to `openrouter/openai/gpt-4o-mini` (or similar) requires editing only the spec — no code change.
6. The committed sample `analysis.json` and persona bundles let a fresh reader reproduce the run.

---

## 15. Risks & gotchas

- **Agent SDK option drift.** Confirm `query()` option names against the installed `@anthropic-ai/claude-agent-sdk`; the `claude --print --mcp-config` subprocess in `bot-agent.ts` is the proven fallback (local creds, MCP, bypass-permissions).
- **OpenRouter model without tool support.** Preflight `supported_parameters` and fail fast; don't silently degrade to JSON-blob mode (that reintroduces the exact fragility this design removes).
- **Context growth on long games.** Mitigated by riding the differ (deduped state deltas) + relay cursor (`newMessages` only). If a game still blows context, trim oldest tool-result bodies in the OpenRouter loop, keeping the latest `state` + recent `newMessages`; log any trim (no silent caps).
- **`PATH` for `coga`/`claude`.** Same fill-bots gotcha — document the global-npm-bin export.
- **Near-identical bot names confuse small models** (Haiku especially) on the same team — pick distinct persona display names per seat (existing bot-system note).
- **Stalled bot.** Engine `turn_timeout` advances the game so a dead/looping bot doesn't hang the run; the harness still caps per-bot model calls and per-run wall clock.
- **Don't reintroduce god-view.** Turn order must come from player-visible state, never admin inspect — that's the regression that makes a harness game-coupled and infidelitous.

---

## Appendix: relationship to existing docs
- `wiki/architecture/relay-and-cursor.md` — the cursor/wake system both backends inherit.
- `wiki/architecture/agent-envelope.md` — the dedup that keeps model context lean.
- `wiki/development/bot-system.md` — the Claude fill path this folds in.
- `docs/building-a-game.md` — the contract a game must satisfy to be drop-in driveable.
- `docs/plans/generic-bots.md` — heuristic/random bots (separate, complementary).
- `docs/plans/trust-plugins.md` — where the analysis "judge" evidence model converges.
