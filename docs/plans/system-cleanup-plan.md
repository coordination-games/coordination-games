# System Cleanup Plan (April 2026, v2)

Synthesis of the multi-agent code review (`/tmp/ctl-review/1-engine.md` …
`6-surfaces.md`) plus self-critique (`plan-critique-{architecture,
concreteness,sequencing}.md`) into a handoff-ready execution plan.

**Verified against**: `main @ 8fb74cf` (post PR #22 merge). Every file path
and line reference has been spot-checked. If you find drift, fix the plan
in the same PR as the work that revealed it.

## North Stars

1. **Game-agnostic engine** — any new game implements `CoordinationGame`
   and ships, with zero edits outside its package.
2. **Plug-and-play tool plugins** — no consumer references a plugin by
   name; adding a plugin needs zero edits outside its package.
3. **On-chain consistency** — in-memory and on-chain modes are observably
   identical from the game's perspective; settlement is deterministic and
   durable.
4. **No false abstractions** — anything declared as a plugin/contract is
   actually used as a plugin/contract; no parallel hardcoded paths.

## Operating principles

- **No backwards compatibility**. Pre-launch, no real users. Write the
  right code directly. No migration shims, no dual-write, no API aliases.
  In-flight DOs and stored state die cleanly when shapes change.
- **No hidden compat code**. If a phase needs to drop a column, drop it.
  If it changes a type shape, every consumer updates in the same PR.
- **One PR per task**, ≤ ~400 lines diff where possible.
- **Wiki updates ride along**. Any PR that changes public behavior,
  plugin contract, or game interface updates `wiki/` in the same PR.
  Phase 8 wiki sweep is *verify-only*, not a catch-up dump.
- **Observability is part of "done"**. Every state machine, transport
  switch, validator, and migration emits structured logs. "Settlement
  we can't see" ≈ broken settlement.
- **Decision gates**: re-scope after Phase 1 (dead code gone), inside
  Phase 4 (after the runtime exists at 4.3), and after Phase 4 (contracts
  done). Update this doc *before* later phases start.

## How to use this document

Each phase ships independently. Each task is sized to one PR. Every task
has:

- **Goal** — the one-line outcome.
- **Files** — exact paths, with line numbers where the bug is localized.
- **Acceptance** — testable conditions for "done."
- **Tests** — what to add/update.
- **Observability** — what gets logged/metered (where applicable).
- **Risks** — known gotchas to avoid.
- **Verify** — the command/inspection that proves done.

Severity: **CRITICAL** = security/correctness/money. **HIGH** = serious
abstraction violation or visible bug. **MEDIUM** = leak/coupling. **LOW**
items live in the raw review files; they're not in this plan.

## Glossary

- **Engine** — `packages/engine/`. Game-agnostic types + helpers.
- **Workers-server** — `packages/workers-server/`. Cloudflare Worker +
  Durable Objects. The actual production runtime.
- **GameRoomDO / LobbyDO** — `workers-server/src/do/`. Run live game and
  lobby state machines.
- **CoordinationGame** — interface in `engine/src/types.ts`.
- **ToolPlugin** — interface for cross-cutting plugins (chat, ELO,
  settlement). Today loaded only on the CLI side; Phase 4 builds the
  server-side runtime.
- **RelayMessage** — actual envelope shape today. Phase 4.1 promotes to
  `RelayEnvelope` with the same fields.
- **Spectator payload** — non-participant view of game/lobby state,
  produced by `buildSpectatorView` per game.
- **Mode** — "in-memory" (no chain) vs "on-chain" (real settlement).
  See `wiki/architecture/dual-mode-infra.md`.

## Conventions

- **Branch**: `cleanup/<phase>-<task>-<slug>`,
  e.g. `cleanup/0-1-lobby-relay-leak`.
- **Commit prefix**: same. Reference task ID in body.
- **Tests**: every PR adds at least one regression or contract test.
- **Wiki**: updated in the same PR (see operating principles).

## Cross-cutting risks

- **Worker DO concurrency**: keep single-writer invariant in DO state
  machines; no `Promise.all` over mutations.
- **Cloudflare bindings**: `wrangler.toml` changes (D1, KV, DO classes)
  require coordinated deploy. Per no-compat policy, just deploy once and
  accept stale-runtime errors.
- **Settlement determinism**: any change touching `outcomeBytes`,
  `movesRoot`, or payout math must be replayed against historical games
  before merging.
- **OATH cannot complete on-chain settlement today** (Phase 3.1) —
  invariant guards skip the bug, so OATH games settle to nothing on-chain.
- **Phase 3.2 is blocked by Phase 4.1 + 4.3**: `SettlementStateMachine`'s
  deps reuse `Capabilities` from 4.3. Don't start 3.2 before 4.3 lands.
- **Alarm-slot contention** (Phase 3.2): DO has a single alarm slot. The
  alarm multiplexer is net-new state, not a caveat. Budget 4h.
- **Phase 1 before Phase 2**: delete dead code before turning on strict
  mode so 2.3 doesn't triage files you're about to remove.

## Open questions

None — all prior open questions are now locked decisions:

- Phase 0.1 shape → inline patch in LobbyDO (no new engine module).
- Phase 0.3 binding → `ctx.id.name` authoritative; mismatch → 400.
- Phase 3.1 payout remainder → highest-rank player.
- Phase 3.3 number policy → BigInt for money, reject `NaN`/`Infinity`,
  canonical JSON encoding (see 3.3 for the full rule).
- Phase 3 ↔ 4 ordering → 4.1 + 4.3 run before 3.2 (capability types
  feed `SettlementStateMachine`'s deps).
- Phase 1 ↔ 2 ordering → delete dead code (was Phase 2) before turning
  on strict mode (was Phase 1). The old numbers are swapped below.
- Phase 4.5 tooling → Vitest + React Testing Library (Storybook dropped).
- Phase 6.1 asset pipeline → build-step copies `packages/games/*/web/assets/`
  into `packages/web/public/` at Pages build time.
- Hardhat verify config → collapse to one file (Phase 3.6).

---

## Phase 0 — Safety net (~0.5 day, ship now)

### 0.1 — LobbyDO relay leak inline fix (privacy fix)

**Goal**: close the public relay leak in `LobbyDO.buildState`. Keep it
small — ~20 LOC, no new engine module. The shared spectator-filter
helper lands in Phase 4.4 (`RelayClient.visibleTo`) once
`RelayEnvelope`'s discriminated-union scope is final.

**Background**: `LobbyDO.buildState(playerId?)` returns the unfiltered
`_relay` array when `playerId` is undefined, leaking team chat and DMs
to spectators and the public `/state` poll. `GameRoomDO` already filters
correctly via `getVisibleRelay` / `resolveRelayRecipients`.

**Why inline (not a new shared module)**: Phase 4.1 changes
`RelayMessage.scope` from `string` to a discriminated union
(`{ kind: 'all' } | { kind: 'team'; teamId } | { kind: 'dm'; recipientHandle }`).
A helper written against today's string shape has to be rewritten in
4.1. Inline the filter in LobbyDO now; Phase 4.4 introduces
`RelayClient.visibleTo(viewer)` as the canonical shared surface once the
type is stable.

**Files**:
- `packages/workers-server/src/do/LobbyDO.ts:380-388` (handleWebSocket initial payload)
- `packages/workers-server/src/do/LobbyDO.ts:572-609` (buildState)
- `packages/workers-server/src/do/LobbyDO.ts:627-633` (broadcastUpdate)

**Implementation sketch** (inline, matches today's `RelayMessage` shape
where `scope: string`; Phase 4.1 will update the predicate when scope
becomes a union):

```ts
// Private helper inside LobbyDO.ts
private filterRelayForSpectator(relay: RelayMessage[]): RelayMessage[] {
  return relay.filter(m => m.scope === 'all');
}

private filterRelayForPlayer(relay: RelayMessage[], playerId: string): RelayMessage[] {
  return relay.filter(m => this.isVisibleTo(m, playerId));
}
```

Every emission boundary chooses one:
- `handleGetState` without `X-Player-Id` header → spectator filter.
- `handleGetState` with header → player filter.
- `handleWebSocket` initial payload → filter by viewer identity.
- `broadcastUpdate` → filter per-connection by viewer identity.

**Acceptance**:
- HTTP `/state` (no `X-Player-Id`) returns relay containing only
  `scope: 'all'`.
- WS spectator stream contains only `scope: 'all'`.
- Player requests see team-scoped + DM messages as before.
- No new file added under `packages/engine/`.

**Tests**:
- `workers-server/src/__tests__/lobby-spectator-leak.test.ts` —
  integration: hit `/state` with no header, assert every envelope has
  `scope === 'all'`.
- Player-path regression: hit `/state` with header X for player on team
  A, assert team-B envelopes are filtered out.

**Observability**: log a counter when a non-`all` envelope is filtered
out for a spectator (proves the function is doing work; should be > 0
whenever chat is active).

**Verify**:
```bash
npm test -w packages/workers-server -- lobby-spectator-leak
curl -s localhost:8787/api/lobbies/<id>/state | jq '._relay[].scope' | sort -u
# expect only "all"
```

**Phase 4 follow-up**: 4.4's `RelayClient.visibleTo(viewer)` replaces
these inline filters with one canonical implementation used by both
`LobbyDO` and `GameRoomDO`, with `SpectatorViewer` as a first-class type.

### 0.2 — Wiki: drop `createBotToken()` claim

**Goal**: wiki reflects reality. Bot auth = player auth.

**Files**:
- `wiki/development/bot-system.md`

**Acceptance**:
- No `createBotToken` reference in `wiki/`.
- Wiki notes the design intent: bots use the same auth flow so any auth
  hardening covers them.
- `--bot-mode` CLI flag: either remove the unused plumbing or document
  it as reserved.

**Verify**:
```bash
grep -r "createBotToken\|bot.*token" wiki/
```

### 0.3 — Settlement gameId binding (CRITICAL)

**Goal**: prevent pre-claim attack on settlement.

**Background**: `bodyGameId` from request body isn't checked against
`ctx.id.name`. Anyone who knows or guesses a future UUID can pre-settle a
trivial game and brick the real game's settlement (`AlreadySettled`
revert).

**Locked decision**: `ctx.id.name` is the authoritative game identifier.
Clients MAY omit `bodyGameId` (falls back to `ctx.id.name`). If
`bodyGameId` is present AND differs from `ctx.id.name`, 400. There is no
case where client-provided `bodyGameId` is preferred over the DO's own
identity.

**Files**:
- `packages/workers-server/src/do/GameRoomDO.ts:190` — settlement entry
- `packages/workers-server/src/do/GameRoomDO.ts:205` — the buggy fallback
  `(bodyGameId ?? ctx.id.name)` — replace with the check below
- `packages/workers-server/src/do/GameRoomDO.ts:652, 671` — downstream
  consumers (`buildSettlementPayload`, `settleOnChain`); make sure they
  read the authoritative id, not the body value

**Sketch**:
```ts
// near GameRoomDO.ts:205
const gameId = this.ctx.id.name;
if (bodyGameId !== undefined && bodyGameId !== gameId) {
  this.log('settlement.gameid.mismatch', { requestedId: bodyGameId, actualId: gameId });
  return new Response('gameId mismatch', { status: 400 });
}
// use gameId (not bodyGameId) for everything downstream
```

**Acceptance**:
- Line 205 fallback removed; DO uses `ctx.id.name` authoritatively.
- Settlement handler rejects with 400 when `bodyGameId` is present and
  mismatches.
- Settlement handler accepts when `bodyGameId` is absent.
- Settlement handler accepts when `bodyGameId` matches `ctx.id.name`.
- `buildSettlementPayload` and `settleOnChain` (lines 652, 671) both
  receive the authoritative id.

**Tests**:
- Unit test on the settlement handler — 3 cases: absent, matching,
  mismatching.

**Observability**: log every mismatch with `{requestedId, actualId,
remoteIp?}` — high signal for pre-claim probing. Alert if counter > 0
sustained.

---

## Phase 1 — Delete dead engine (~1–2 days)

Do this before Phase 2 so strict-mode triage (2.3) doesn't waste time
fixing errors in files you're about to delete.

### 1.1 — Delete parallel server stack

**Files**:
- `packages/engine/src/server/` — delete directory.
- `packages/engine/src/index.ts` — remove `server/*` exports.

**Verify**:
```bash
grep -r "GameFramework\|AuthManager\|BalanceTracker" packages/
# expect zero hits
npm run build
```

### 1.2 — Delete `engine/src/game-session.ts`

**Files**:
- `packages/engine/src/game-session.ts` — delete.
- `packages/engine/src/index.ts` — remove export.
- Tests for `GameRoom` — delete unless they exercise still-live helpers
  (`merkle.ts`, `chat-scope.ts`); in that case move to test the helpers
  directly.

### 1.3 — Trim `engine/src/mcp.ts`

**Files**:
- `packages/engine/src/mcp.ts` — delete top-level exports
  `getAvailableTools`, `generateGuide`, `PHASE_TOOLS`. Note: there is no
  top-level `submit_action` export; `submit_action` is a tool definition
  inside `GAMEPLAY_TOOLS` and goes away when `GAMEPLAY_TOOLS` / `PHASE_TOOLS`
  are deleted.
- Move surviving types to `engine/src/types.ts`. Delete the file if
  nothing remains.

**Acceptance**:
- CLI build passes; workers-server build passes.

### 1.4 — Wiki refresh

**Files**:
- `wiki/architecture/engine-philosophy.md` — replace dead Timer Stale-ID
  pattern with the live alarm-ID pattern in `GameRoomDO`.
- `wiki/architecture/mcp-not-on-server.md` — verify still accurate.
- `wiki/architecture/plugin-pipeline.md` — fix incorrect "insertion-order
  tiebreaker" claim; document Kahn's: same-type cycle = error.

### Decision gate (after Phase 1)

Re-read Phase 4 with dead code gone. Likely effects:
- `ToolPlugin` interface shrinks (deleted `init`/`requiredPlugins`
  declarations no longer leak into design).
- The "two MCP code paths" critique disappears.

Update Phase 4 task list before Phase 4 starts.

---

## Phase 2 — Tooling foundation (~2 days)

Runs after Phase 1 so lint/strict-mode triage operates on live code only.

### 2.1 — Biome at workspace root

**Goal**: lint + format every package.

**Files**:
- `biome.json` (new, root)
- `package.json` (root) — add `lint` / `format` / `check` scripts.

**`biome.json` skeleton**:

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/<latest>/schema.json",
  "files": {
    "ignore": ["**/dist", "**/node_modules", "**/.wrangler",
               "packages/contracts/artifacts", "packages/contracts/cache"]
  },
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100,
    "quoteStyle": "single",
    "trailingComma": "all"
  },
  "linter": {
    "rules": {
      "recommended": true,
      "suspicious": {
        "noExplicitAny": "error",
        "noConfusingVoidType": "error"
      },
      "style": {
        "useImportType": "error",
        "noNonNullAssertion": "warn"
      },
      "complexity": { "noBannedTypes": "error" },
      "correctness": {
        "noUnusedVariables": "error",
        "useExhaustiveDependencies": "error"
      }
    }
  }
}
```

**Note**: Biome v2 autofix flag is `--write` (not `--apply`).

**Acceptance**:
- `npm run lint`, `npm run format`, `npm run check` (alias for both).
- Editor integration documented in `wiki/development/`.

### 2.2 — Tighten `tsconfig.base.json`

**Goal**: strict mode everywhere; prevent `any` regressions.

**Files**:
- `tsconfig.base.json` (root) — every package extends.

**Add to `compilerOptions`**:
```jsonc
{
  "strict": true,
  "noImplicitAny": true,
  "useUnknownInCatchVariables": true,
  "exactOptionalPropertyTypes": true,
  "noUncheckedIndexedAccess": true,
  "noFallthroughCasesInSwitch": true,
  "verbatimModuleSyntax": true
}
```

**Acceptance**:
- Root `tsc --noEmit` runs across the workspace.
- Per-package `tsconfig.json` overrides only with a `// reason:` comment.

**Risks**:
- `noUncheckedIndexedAccess` produces dozens of errors per package.
  Triage as part of 2.3.
- `verbatimModuleSyntax` requires `import type`; Biome's
  `useImportType` autofixes.

### 2.3 — Initial cleanup pass

**Goal**: every Biome/tsc error fixed or annotated.

**Process**:
1. `npm run lint -- --write` (autofix).
2. `npm run typecheck`. For each error:
   - Fix if mechanical.
   - Annotate `// biome-ignore lint/<rule>: <reason> — TODO(<phase-#>)`
     if it belongs to a later phase.
3. **`any` → `unknown`** at function boundaries; narrow at use sites.
4. Track all TODOs in `docs/plans/cleanup-todos.md`.

**Acceptance**:
- `npm run check` clean (warnings OK).
- Every `biome-ignore` has a `TODO(<phase-#>)` reference.

**Estimate caveat**: cleanup pass alone is likely 1.5 days of the 2-day
phase budget. Don't try to fix every `noUncheckedIndexedAccess` hit;
annotate aggressively for later phases.

### 2.4 — CI gate

**Goal**: lint + typecheck block merge.

**Files**:
- `.github/workflows/test.yml` — add jobs.

**Acceptance**:
- PR fails CI if `npm run check` fails.

---

## Phase 3 — On-chain hardening (~3–5 days, must-fix-before-mainnet)

**Sequencing (locked)**: Phase 3 runs *after* Phase 4.1 (`RelayEnvelope`)
and 4.3 (`ServerPluginRuntime` capability types). 3.2's
`SettlementStateMachine` takes its dependencies as
`Pick<Capabilities, 'storage' | 'chain' | 'alarms'>` so Phase 5.3 wraps
it without rewriting. If 4.1/4.3 aren't done, 3.2 is blocked.

Within Phase 3, tasks 3.1, 3.3, 3.4, 3.5, 3.6, 3.7 can run in any order
(they don't touch the plugin runtime). 3.2 requires 4.3.

**Why this order (recap)**: both phases mutate `GameRoomDO.ts`,
`merkle.ts`, `onchain-relay.ts`, `engine/src/types.ts`. If 3.2 ships
first, it defines an ad-hoc `SettlementDeps` interface that gets
reconciled against 4.3's `Capabilities` in 5.3 — two DI shapes to
maintain. Doing 4.1+4.3 first collapses that to one.

### 3.1 — OATHBREAKER actually settles on-chain

**Goal**: OATH end-of-game produces deterministic integer payouts that
pass the existing zero-sum invariants.

**Status (verified)**: `GameRoomDO.ts:691-714` already enforces zero-sum
+ `delta ≥ -entryCost` via "skip-not-throw" guards. OATHBREAKER's
`computePayouts` (`packages/games/oathbreaker/src/plugin.ts:340`) returns
`Map<string, number>` where `dollarValue` is computed from
`dollarPerPoint = totalDollarsInvested / totalSupply` — float division.
Result: OATH games trip the invariant, settlement is silently skipped.

**Files**:
- `packages/games/oathbreaker/src/plugin.ts` — `computePayouts`,
  `getOutcome`, helpers `dollarPerPoint`, `dollarValue`.
- `packages/workers-server/src/chain/onchain-relay.ts` — confirm caller
  handles BigInt deltas.

**Implementation**:
- All payout math in BigInt or integer cents.
- Define `type CreditAmount = bigint`, use throughout the OATH plugin.
- **Rounding rule (locked)**: floor every `dollarValue`, then give the
  remainder (`potTotal - sum(floored)`) to the **highest-rank player**.
  Ties in rank broken by earliest-joined (`joinedAt`), then `playerId`
  lexicographic as the final tiebreaker. Document in
  `wiki/architecture/credit-economics.md`. Escrow-to-treasury is
  explicitly rejected — winners get the dust.

**Rounding sketch**:
```ts
function distributePot(potCents: bigint, ranked: RankedPlayer[]): Map<string, bigint> {
  // ranked is sorted: [winner, ..., loser]
  const floors = new Map<string, bigint>();
  let distributed = 0n;
  for (const p of ranked) {
    const f = (potCents * BigInt(p.points)) / BigInt(totalPoints);
    floors.set(p.id, f);
    distributed += f;
  }
  const remainder = potCents - distributed;  // ≥ 0
  const winner = ranked[0];
  floors.set(winner.id, floors.get(winner.id)! + remainder);
  return floors;
}
```

**Acceptance**:
- Property test: any valid OATH end-state, `computePayouts` returns
  BigInt deltas summing exactly to 0.
- Integration test: full OATH game end-to-end produces a successful
  on-chain settlement on local fork.
- Manual: play one OATH game on dev, settlement completes (today: skips).

**Tests**:
- `packages/games/oathbreaker/src/__tests__/payouts.test.ts` — property.
- `packages/workers-server/src/__tests__/onchain-oath.test.ts` — e2e.

**Observability**: log every invariant skip with full delta breakdown.
After fix, this counter should be 0.

### 3.2 — Settlement state machine (on Phase 4.3 capabilities)

**Goal**: settlement survives Worker hibernation and RPC failure. Built
on the Phase 4.3 capability-injection model so Phase 5.3 wraps it
without rewriting.

**Background**: `ctx.waitUntil(settleOnChain())` is fire-and-forget.
Hibernation, RPC blip, or failed receipt-poll silently loses settlement.

**Blocked by**: Phase 4.1 (RelayEnvelope), Phase 4.3
(`Capabilities` interface + `ServerPluginRuntime`). Do not start 3.2
before those two land.

**Files**:
- New: `packages/workers-server/src/chain/SettlementStateMachine.ts`.
- `packages/workers-server/src/do/GameRoomDO.ts` — instantiate it; alarm
  routes to it.
- New: `packages/workers-server/src/chain/alarm-multiplexer.ts`
  (see Risks — not optional).

**Sketch** (reuses `Capabilities` from `packages/workers-server/src/plugins/capabilities.ts`):
```ts
import type { Capabilities } from '../plugins/capabilities';

type SettlementState =
  | { kind: 'pending'; computedAt: number }
  | { kind: 'submitted'; txHash: `0x${string}`; submittedAt: number; attempts: number }
  | { kind: 'confirmed'; txHash: `0x${string}`; blockNumber: number }
  | { kind: 'failed'; reason: string; lastTxHash?: `0x${string}`; attempts: number };

type SettlementDeps = Pick<Capabilities, 'storage' | 'chain' | 'alarms'> & {
  log: (event: string, data: unknown) => void;
};

class SettlementStateMachine {
  constructor(private deps: SettlementDeps) {}
  async submit(payload: SettlementPayload): Promise<void>;
  async tick(): Promise<void>;       // called by alarm
}
```

**Acceptance**:
- `SettlementDeps` is `Pick<Capabilities, ...>`, not a redefined
  interface.
- DO storage holds state across hibernation.
- Test: simulate hibernation between submit and confirm — alarm wakes,
  re-checks receipt, transitions to confirmed.
- Test: RPC failure on submit — alarm retries with backoff up to N=10,
  then transitions to failed.
- Phase 5.3 later wraps this as a `ServerPlugin` with zero logic change.

**Tests**:
- DO unit tests using `@cloudflare/vitest-pool-workers` (set up if
  absent).

**Observability**: emit `settlement.state.transition` log per
transition, with attempt count + ms-since-computed. Failed terminal
state pages someone.

**Risks**:
- Don't double-submit: pin nonce on first submit, retry with same nonce.
- Idempotency: contract reverts `AlreadySettled` on repeat — handle as
  `confirmed`.
- **Alarm-slot contention (real work, not a caveat)**: DO has ONE alarm
  slot. `GameRoomDO.alarm()` currently owns it exclusively for turn
  deadlines. Adding settlement makes it a second consumer → every
  existing `setAlarm` call site must route through a small multiplexer
  that stores an in-DO-storage queue of `{when, kind, payload}` and
  dispatches the earliest one on alarm fire. This is net-new state,
  not a comment in a risk list. Budget: ~4 hours.

### 3.3 — Deterministic `outcomeBytes` + number policy

**Goal**: same end-state always hashes to the same bytes.

**Background**: CtL silently drops `Map` entries during JSON encoding;
OATH is order-sensitive on float keys; no key sort. JavaScript's
`number` is 64-bit float, and `0.1 + 0.2 !== 0.3`, so any game that
stores floats in hashable state risks cross-client divergence.

**Files**:
- New: `packages/engine/src/canonical-encoding.ts`.
- All callers: `grep -rn "outcomeBytes\|getOutcome" packages/`.

**Number policy (locked)**:
- **Money values**: always `bigint` (e.g. cents, satoshi-style fixed
  point). OATHBREAKER's `dollarValue`, CtL's entry fees / payouts — all
  `bigint`. Phase 3.1 already requires this; 3.3 enforces it at the
  encoder.
- **Counts / indices**: `number`, but must pass `Number.isSafeInteger`.
- **Floats in hashable state**: disallowed. Encoder throws
  `NonIntegerNumberError` if `!Number.isSafeInteger(value)` for any
  `typeof value === 'number'` field.
- **`NaN` / `Infinity`**: always rejected (JSON can't represent them
  anyway; we want a loud error, not silent `null`).
- **Non-POJO values**: `Map`, `Set`, `Date`, `undefined`, class
  instances, functions — all rejected at the encoder boundary with
  `NonPojoValueError`. Games convert to POJO before hashing.

**TypeScript caveat (why the runtime check matters)**: TS `number` has
no `Integer` subtype. Branded types like
`type Integer = number & { __brand: 'int' }` help at authoring time but
break the moment a game author does `x / 3`. Runtime validation is
mandatory; the encoder is that gate.

**Implementation**:
- Sorted-key JSON. Reject non-POJO at the engine boundary. Reject
  non-integer numbers. Reject `NaN`/`Infinity`.
- `bigint` serializes as `{ __bigint: '<decimal-digits>' }` (object
  sentinel, stable across versions, no `n` suffix string ambiguity).
- Document the full rule in `wiki/architecture/contracts.md` and link
  from the `CoordinationGame.getOutcome` docstring.

**Acceptance**:
- Property test: `encode(decode(encode(x))) === encode(x)`.
- Cross-game test: identical outcome → identical bytes regardless of
  insertion order.
- Throws on any float (`encode({ x: 1.5 })` → error).
- Throws on `NaN` / `Infinity`.
- Throws on `Map` / `Set` / `Date` / `undefined` / class instance.
- Round-trips `bigint` through the sentinel form.

**Migration**: OATHBREAKER's current `Map<string, number>` payout shape
is converted in Phase 3.1; 3.3 verifies the encoder rejects the old
shape (property test: feed a legacy state with floats, expect throw).

### 3.4 — Merkle: SHA-256 → keccak256

**Goal**: align with EVM hashing.

**Files**:
- `packages/engine/src/merkle.ts` — kill stale TODO; switch to viem
  `keccak256`.

**Implementation**:
- Empty input → `0x00…00`. Today's `hash('empty')` silently passes the
  contract `MissingMovesRoot` check; the new behavior should fire.
- Test vectors: `packages/engine/src/__tests__/merkle-vectors.json`.

**Acceptance**:
- All Merkle ops use keccak256.
- Empty input returns zero hash; contract `MissingMovesRoot` fires.

**No-compat note**: in-flight games hashed with SHA-256 die. Acceptable
pre-launch.

### 3.5 — Contract hardening

**Goal**: standard reentrancy + dust + dead-code cleanup.

**Files**:
- `packages/contracts/src/*.sol` — every external state-mutator.

**Implementation**:
- `nonReentrant` on `executeBurn`, `mint`, `settleDeltas`.
- `executeBurn`: revert with `DustBurnRejected` if USDC payout would
  round to 0.
- `emergencyReclaim`: delete or `onlyOwner`.

**Acceptance**:
- Hardhat tests for reentrancy on each guarded function.
- Test: `executeBurn` of < 100 credits reverts.
- `emergencyReclaim` gone or admin-gated.

### 3.6 — Hardhat config consolidation

**Goal**: single `hardhat.config.ts`.

**Decision recorded**: collapse the two configs. The verify split
(`06a0586`) was a workaround; the right shape is one config with
Etherscan v2 setup for both deploy and verify.

**Files**:
- `packages/contracts/hardhat.config.ts` — merge in verify settings.
- `packages/contracts/hardhat.verify.config.ts` — delete.
- `package.json` scripts — point `verify` at the unified config.

**Acceptance**:
- One config file.
- `npm run verify` works against OP Sepolia.
- Etherscan v2 hostnames everywhere.

### 3.7 — Auth path resilience

**Goal**: login doesn't die when one RPC dies.

**Files**:
- `packages/workers-server/src/auth.ts`

**Implementation**:
- RPC fallback list (env: `RPC_URLS=url1,url2,url3`).
- Retry next on error, exponential backoff.
- Cache successful URL for the request lifetime.

**Acceptance**:
- Test: first RPC returns 500, request succeeds via second.

**Observability**: log per-RPC failure rate; if any hits 50%+ for
sustained period, page.

---

## Phase 4 — Define real contracts (~5–7 days, foundation)

Without these, Phase 5 is fake. Most architectural critique findings live
here — this rev incorporates them.

**Inside-phase decision gate**: after 4.1 + 4.3 land, re-read 4.4–4.7.
Some may simplify or delete entirely once the runtime exists.

### 4.1 — `RelayEnvelope` as the single engine type

**Goal**: one canonical type for every relay message.

**Live shape (verified)**:
```ts
// packages/workers-server/src/do/GameRoomDO.ts:82
interface RelayMessage {
  index: number;
  type: string;
  data: unknown;
  scope: string;       // 'all' | 'team' | <handle> for DM
  pluginId: string;
  sender: string;
  turn: number;
  timestamp: number;
}
```

Defined in 3 places: `LobbyDO.ts:70` (no `turn`), `GameRoomDO.ts:82`,
`packages/plugins/basic-chat/src/index.ts:17`.

**New canonical type**:
```ts
// engine/src/types.ts
export type RelayScope =
  | { kind: 'all' }
  | { kind: 'team'; teamId: string }
  | { kind: 'dm'; recipientHandle: string };

export interface RelayEnvelope<TBody = unknown> {
  index: number;          // monotonic per game/lobby
  type: string;           // plugin-owned, e.g. 'chat:message'
  pluginId: string;
  sender: string;         // playerId; 'system' for engine-emitted
  scope: RelayScope;
  turn: number | null;    // null in lobby
  timestamp: number;      // ms epoch
  data: TBody;
}
```

**Open vs closed body**: Phase 4.2 lands the per-type validation
registry. Until 4.2 is done, every consumer treats `data` as `unknown`
and narrows at use site. The `<TBody = unknown>` parameter exists so
Phase 4.2 can produce a `ValidatedRelayEnvelope<T>` branded type.

**Migration**: per no-compat policy, just change every consumer in this
PR. Old DO storage (`scope: string`) is converted via a one-shot
`migrate-relay-shape.ts` script run on dev DBs; production has no real
data yet.

**Acceptance**:
- Single definition; all imports resolve to it.
- `Message.from: number` → `RelayEnvelope.sender: string`.
- `SpectatorContext.relayMessages: any[]` → `RelayEnvelope[]`.
- `LobbyDO`'s missing `turn` field added (set `null`).
- `basic-chat` re-exports the engine type, doesn't redefine.

**Tests**: type-level test using `expect-type` per consumer.

### 4.2 — Per-type validation registry

**Goal**: plugins register Zod schemas; engine validates inbound
envelopes; output is a branded type.

**Files**:
- New: `packages/engine/src/relay-registry.ts`.
- `packages/engine/src/types.ts` — extend `ToolPlugin` with
  `relayTypes: Record<string, ZodSchema>`.

**Sketch**:
```ts
declare const validatedBrand: unique symbol;
export type ValidatedRelayEnvelope<T = unknown> =
  RelayEnvelope<T> & { readonly [validatedBrand]: true };

const schemas = new Map<string, ZodSchema>();

export function registerRelayType(type: string, schema: ZodSchema) {
  if (schemas.has(type)) throw new Error(`relay type collision: ${type}`);
  schemas.set(type, schema);
}

export function validateRelay<T>(env: RelayEnvelope): ValidatedRelayEnvelope<T> {
  const schema = schemas.get(env.type);
  if (!schema) throw new RelayUnknownTypeError(env.type);
  const data = schema.parse(env.data);
  return { ...env, data } as ValidatedRelayEnvelope<T>;     // returns new object, not mutated
}
```

**Acceptance**:
- Engine validates every inbound `RelayEnvelope`.
- Unknown type → reject + log.
- Plugin re-registers same type → boot-time error.
- `validateRelay` returns a new object (no mutation).

**Tests**: collision throws, malformed body rejected, unknown type
rejected, branded type preserved through narrowing.

**Observability**: counter per `(plugin, relayType, outcome)`. Sustained
rejections = client/plugin drift.

### 4.3 — Server-side plugin runtime (capability-injection model)

**Goal**: workers-server gets a real `ServerPluginRuntime` that injects
only the capabilities a plugin declares.

**Why capability injection (not god-context)**: a chat plugin needs
`relay`. ELO needs `d1` and `relay`. Settlement needs `chain`, `storage`,
`alarms`. Handing every plugin all of them creates implicit coupling and
makes plugin-substitution untestable.

**Files**:
- New: `packages/workers-server/src/plugins/runtime.ts`,
  `packages/workers-server/src/plugins/capabilities.ts`.
- `packages/workers-server/src/do/GameRoomDO.ts`,
  `packages/workers-server/src/do/LobbyDO.ts` — instantiate runtime.

**Sketch**:
```ts
// capabilities.ts
export interface Capabilities {
  storage: PluginScopedStorage;          // namespaced 'plugin:<id>:<key>'
  relay: RelayClient;
  alarms: AlarmScheduler;
  d1: D1Database;
  chain: OnChainRelay;
}
type CapName = keyof Capabilities;

// runtime.ts
export interface ServerPlugin<R extends CapName = never> {
  id: string;
  requires: readonly R[];
  init(caps: Pick<Capabilities, R>, game: GameContext): Promise<void>;
  handleRelay?(env: ValidatedRelayEnvelope): Promise<RelayEnvelope[] | void>;
  handleCall?(name: string, args: unknown): Promise<unknown>;
  handleAlarm?(name: string): Promise<void>;
  dispose?(): Promise<void>;             // best-effort; see below
}
```

**`dispose` semantics**: best-effort on DO eviction. Long-running work
(e.g. settlement) lives in storage-backed state machines (Phase 3.2),
*not* in plugin-local state. Plugins MUST tolerate `dispose` not being
called.

**Acceptance**:
- DOs construct a `ServerPluginRuntime` on first use.
- `init` called exactly once; only declared `requires` are passed.
- Storage namespaced by plugin id (`plugin:<id>:<key>`).
- Test: register plugin requiring `['relay']`, verify it doesn't see
  `chain`.

**Tests**: capability isolation, storage namespacing, alarm dispatch
routing.

**Observability**: log plugin lifecycle (init, dispose, error). Plugin
errors don't crash the DO; they're caught and logged with full context.

### 4.4 — Real `RelayClient` (GameRoom + Lobby, write-amp fix included)

**Goal**: implement the publishing surface plugins use. One client
implementation serves BOTH `GameRoomDO` and `LobbyDO`, replacing the
two near-identical relay code paths that exist today (~280 duplicated
lines in `LobbyDO.ts:380-633` vs `GameRoomDO.ts:463-565`). Fold in the
DO-storage write-amplification fix so relay growth is bounded.

**Also introduces `SpectatorViewer` as a real type** (Phase 0.1 only
did inline filters by necessity — the type lands here, once
`RelayEnvelope.scope` is a discriminated union):
```ts
export type SpectatorViewer =
  | { kind: 'spectator' }
  | { kind: 'replay' }
  | { kind: 'admin' }
  | { kind: 'bot'; playerId: string }
  | { kind: 'player'; playerId: string };
```

**Files**:
- New: `packages/workers-server/src/plugins/relay-client.ts`.
- `packages/workers-server/src/do/GameRoomDO.ts` — delete
  `handleTool`/`_relay`/`getVisibleRelay` inline duplication; delegate.
- `packages/workers-server/src/do/LobbyDO.ts` — delete the inline
  filters from Phase 0.1; delegate. **Phase 0.1's inline code is
  superseded here, not duplicated.**

**Sketch**:
```ts
export interface RelayClient {
  publish(env: Omit<RelayEnvelope, 'index' | 'timestamp'>, opts?: {
    dedupeKey?: string;
  }): Promise<void>;
  visibleTo(viewer: SpectatorViewer): Promise<RelayEnvelope[]>;
  since(index: number, viewer: SpectatorViewer): Promise<RelayEnvelope[]>;
}

export class DOStorageRelayClient implements RelayClient {
  constructor(
    private storage: DurableObjectStorage,
    private registry: RelayRegistry,   // from Phase 4.2
  ) {}
  // ... see "Storage layout" below
}
```

**Storage layout (fixes write amplification)**:
- **Bug today**: `GameRoomDO.handleTool` does
  `this.ctx.storage.put('relay', this._relay)` per message
  (`GameRoomDO.ts:482`). The entire array is rewritten every time. A
  long OATH game with active chat will approach the DO 128KB per-value
  limit. Same bug in `LobbyDO`.
- **Fix**: store each envelope under its own key
  `relay:{paddedIndex}` (e.g. 10-digit zero-padded for lexicographic
  range scans). `_nextIndex` stays as a small counter under `relay:tip`.
  `publish` = one put of the new envelope + one put of the updated tip.
  Cost per message: bounded, independent of relay length.
- **Read**: `visibleTo(viewer)` uses `storage.list({ prefix: 'relay:',
  start: 'relay:0000000000', end: 'relay:tip' })` and filters in
  memory. For long games, `since(index, viewer)` with a narrower range.

**Filter logic** (canonical, replaces Phase 0.1's inline filters):
```ts
function isVisible(env: RelayEnvelope, viewer: SpectatorViewer): boolean {
  if (viewer.kind === 'admin') return true;
  if (env.scope.kind === 'all') return true;
  if (viewer.kind === 'spectator' || viewer.kind === 'replay') return false;
  // player / bot: same rules
  const handle = viewer.playerId;
  if (env.scope.kind === 'dm') return env.scope.recipientHandle === handle || env.sender === handle;
  if (env.scope.kind === 'team') return isOnTeam(handle, env.scope.teamId);
  return false;
}
```

**Acceptance**:
- Plugins never touch `_relay` directly.
- Both `GameRoomDO` and `LobbyDO` delegate to `RelayClient` — no
  duplicated filter or publish logic remains.
- Phase 0.1's inline `filterRelayForSpectator` / `filterRelayForPlayer`
  in `LobbyDO` are DELETED (not kept alongside).
- `publish` is idempotent per `dedupeKey` (if the same logical event is
  retried, no duplicate envelope is appended).
- DO storage per-message writes: O(1) puts, not O(n).
- Load test: 10k envelopes → no DO value-size errors; `visibleTo`
  returns in < 50ms P99.

**Tests**:
- Viewer kinds × scope kinds matrix (unit).
- Write-amp regression: after 10k publishes, assert `storage.get('relay')`
  (old key) is absent; `storage.list({ prefix: 'relay:' })` returns 10k+1.
- Dedupe: publish same `dedupeKey` twice → one envelope.

**Observability**: counter per `(kind, outcome)` on `publish`. Counter
per `(viewerKind, filtered, total)` on `visibleTo`.

### 4.5 — Frontend named-slot host (`WebToolPlugin`)

**Goal**: web shell iterates a slot host instead of a 4-slot god
interface.

**Why named-slot**: the v1 plan's `WebToolPlugin` had four optional
slots (`GameCard`, `LobbyPanel`, `GamePanel`, `SpectatorOverlay`). Each
new slot type would balloon the interface. The right shape is the VS
Code / Storybook pattern: plugins declare `slots: Record<SlotName,
Component>`, shells render `<SlotHost name="lobby:panel" />` which
filters the registry by name.

**Files**:
- New: `packages/web/src/plugins/types.ts`,
  `packages/web/src/plugins/registry.ts`,
  `packages/web/src/plugins/SlotHost.tsx`.

**Sketch**:
```ts
// plugins/types.ts
export type SlotName =
  | 'lobby:card'       // tile in LobbiesPage
  | 'lobby:panel'      // side panel in LobbyPage
  | 'game:panel'       // side panel in GamePage
  | 'game:overlay';    // overlay on SpectatorView

export interface WebToolPlugin {
  id: string;
  slots: Partial<Record<SlotName, React.FC<SlotProps>>>;
}

// SlotHost.tsx
export function SlotHost(props: { name: SlotName } & SlotProps) {
  return registry.getAll()
    .filter(p => props.name in p.slots)
    .map(p => <p.slots[props.name] key={p.id} {...props} />);
}
```

**Acceptance**:
- All shell pages render plugin UI via `<SlotHost />`.
- Adding a `WebToolPlugin` = export + add to registry init.
- Adding a new slot type = add to `SlotName` union; shells render where
  appropriate.

**Tests**: Vitest + React Testing Library component tests per slot —
render `<SlotHost name="lobby:panel" game={mockGame} />` with a mock
registry, assert the expected plugin component mounts with the right
props. No Storybook setup needed (rejected: would add a day of
Vite + Pages build-config work for a feature that's purely about
component-rendering assertions, which Vitest+RTL already handle).

Example test:
```ts
// web/src/plugins/__tests__/SlotHost.test.tsx
import { render, screen } from '@testing-library/react';
test('SlotHost renders plugin components for a named slot', () => {
  const plugin: WebToolPlugin = {
    id: 'chat',
    slots: { 'lobby:panel': () => <div>chat panel</div> },
  };
  registry.register(plugin);
  render(<SlotHost name="lobby:panel" game={mockGame} />);
  expect(screen.getByText('chat panel')).toBeInTheDocument();
});
```

### 4.6 — `CoordinationGame` interface refinements

**Goal**: tighten the contract every game implements.

**Files**:
- `packages/engine/src/types.ts`
- All game packages: update implementations.

**Changes**:
- Add `getTeamForPlayer(state, playerId): TeamId` — unifies the `'FFA'`
  sentinel.
- Drop `progressIncrement: boolean`. **Keep** existing
  "N progress units" model — don't replace with a 0..1 normalization
  (would break the existing spectator-delay implementation).
  Instead, require games to declare `progressUnit` and increment via
  the existing `progressCounter`.
- Replace tri-state `deadline: undefined | null | {…}` with discriminated
  union: `{ kind: 'none' } | { kind: 'absolute'; at: number }`.
- Single `Phase` enum: `'lobby' | 'in_progress' | 'finished'`. OATH and
  CtL update their internal phase strings to match. Per no-compat, just
  change them; in-flight games die.

**Acceptance**:
- Both games implement the new interface.
- Type-level test ensures interface satisfied.

**D1 migration**: `migrations/0009_phase_enum_unify.sql` drops/recreates
the `phase` column with the new enum (per no-compat). See
[D1 migration appendix](#d1-migration-appendix).

### 4.7 — Mandatory `getReplayChrome` and `getSummaryFromSpectator`

**Goal**: enforce per-plugin contracts at registration time. Keep
`getReplayChrome` data-only (no React) so the engine stays
platform-agnostic.

**Files**:
- `packages/engine/src/types.ts` — add to `CoordinationGame`:
  ```ts
  getReplayChrome(snapshot: unknown): {
    isFinished: boolean;
    winnerLabel?: string;        // e.g. "Team A", or undefined for draw
    statusVariant?: 'win' | 'loss' | 'draw' | 'in_progress';
  };
  ```
- `packages/engine/src/registry.ts` — `registerGame` throws if
  `getReplayChrome` or `getSummaryFromSpectator` is missing.
- `packages/games/*/src/plugin.ts` — implement.

**Per no-compat**: ship in one PR with both games updated. No grace
period.

**Acceptance**:
- `registerGame` throws on missing methods.
- Property test: `getSummaryFromSpectator(buildSpectatorView(s)) ⊆
  getSummary(s)` for all valid states.
- OATHBREAKER replay shows correct end-of-game label (today: "Draw!"
  forever).

### Decision gate (after Phase 4)

Re-scope Phases 5–7 with contracts in hand. Likely:
- Phase 5 tasks shrink to "kill the literal, plug into the runtime."
- Phase 7.1 (transport unification) may merge with Phase 5.1 (chat
  migration) into a single per-plugin PR.

---

## Phase 5 — Migrate hardcoded "plugins" onto the contract (~7–10 days)

The actual cleanup of the user's stated pet peeve.

### 5.1 — Chat: kill every `'messaging'` literal

**Goal**: chat is purely a plugin; no consumer references it by name.

**Real hardcode sites** (engine-internal uses are legitimate; these are
the bugs):
- `packages/workers-server/src/do/LobbyDO.ts:342`
- `packages/workers-server/src/do/GameRoomDO.ts:463`
- `packages/web/src/pages/GamePage.tsx:25`
- `packages/web/src/pages/LobbyPage.tsx:112`
- `packages/games/capture-the-lobster/src/plugin.ts:260, 263`

(Engine tests + `chat-scope.ts` comment + `types.ts` comment use
`'messaging'` as a pipeline type name — those are fine.)

**Acceptance**:
- The 5 sites above use plugin pipeline output, not literal `'messaging'`.
- Chat panel renders via `WebToolPlugin` slot
  (`lobby:panel` / `game:panel`).
- Server-side: chat is a `ServerPlugin`, not inline DO logic.
- Acceptance test: removing `basic-chat` from plugin list disables chat
  with no other regressions.

**Observability**: when chat plugin is absent, no `'messaging'` envelopes
should exist; assert via test.

### 5.2 — ELO: real `handleCall` path (one PR per no-compat)

**Goal**: ELO is a plugin; no parallel REST.

**Files**:
- `packages/plugins/elo/src/index.ts`
- `packages/workers-server/src/db/elo.ts` — DELETE the parallel
  `D1EloTracker`.
- `packages/workers-server/src/index.ts` — DELETE `/api/leaderboard`,
  `/api/my-stats`.
- `packages/cli/src/mcp-tools.ts` — DELETE hardcoded `get_leaderboard` /
  `get_my_stats`; rely on plugin tool registration.
- `packages/web/src/pages/LeaderboardPage.tsx` — switch from
  `fetch('/api/leaderboard')` to the plugin-call path (see sketch).

**Replacement client path**: the Worker exposes ONE generic endpoint,
`POST /api/plugin/:pluginId/call`, that routes to
`ServerPluginRuntime.handleCall(pluginId, name, args)`. The frontend
calls the plugin by name; there are no bespoke REST endpoints per
plugin.

**Frontend sketch**:
```ts
// packages/web/src/lib/plugin-call.ts
export async function callPlugin<T>(
  pluginId: string, name: string, args: unknown,
): Promise<T> {
  const r = await fetch(`/api/plugin/${pluginId}/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Player-Id': playerId() },
    body: JSON.stringify({ name, args }),
  });
  if (!r.ok) throw new Error(`plugin call failed: ${r.status}`);
  return (await r.json()) as T;
}

// packages/web/src/pages/LeaderboardPage.tsx
const rows = await callPlugin<LeaderboardRow[]>('elo', 'leaderboard', { limit: 50 });
```

**Worker-side sketch** (new, thin — one handler, all plugins):
```ts
// packages/workers-server/src/index.ts
router.post('/api/plugin/:pluginId/call', async (req, env) => {
  const { pluginId } = req.params;
  const { name, args } = await req.json();
  const viewer = parseViewerFromHeaders(req);   // uses X-Player-Id (see 0.3 path)
  const result = await runtime.handleCall(pluginId, name, args, viewer);
  return Response.json(result);
});
```

**D1 migration**: `migrations/0010_elo_plugin_namespace.sql` drops the
existing `elo` table and recreates it under
`plugin_elo_<table>` namespace owned by the plugin. Per no-compat, no
backfill.

**Worker + Pages deploy ordering**: per no-compat, single deploy. If the
frontend is briefly broken between Worker rollout and Pages rollout
(seconds), it's acceptable.

**Acceptance**:
- `EloPlugin.handleCall` is exercised in production.
- `D1EloTracker` is deleted.
- CLI sees ELO tools via dynamic registration.
- No `/api/leaderboard` or `/api/my-stats` endpoints remain.
- Frontend uses `callPlugin('elo', ...)` for every ELO interaction.

### 5.3 — Settlement: wrap the state machine as a plugin

**Goal**: settlement runs on the Phase 4 runtime.

**Files**:
- New: `packages/workers-server/src/plugins/settlement/index.ts`.
- `packages/workers-server/src/do/GameRoomDO.ts` — settlement code
  removed; runtime dispatch instead.

**Note**: Phase 3.2 already built `SettlementStateMachine` runtime-
agnostic. This task wraps it in a `ServerPlugin` declaration; minimal
new code.

**Acceptance**:
- Settlement logic in the plugin module.
- DO dispatches game-end → plugin → state machine.

### 5.4 — Acceptance test: hypothetical "voting" plugin

**Goal**: prove plug-and-play.

**Process**:
1. Branch `acceptance/voting-plugin`.
2. Implement `packages/plugins/voting/` end-to-end (server + web slots).
3. Add to plugin list in app init.
4. **Count files edited outside `packages/plugins/voting/`.** Target: ≤ 1
   (registry init).
5. Pick a *non-chat-shaped* plugin to expose real abstraction gaps. Two
   candidates:
   - "trust-graph" — per-player UI, cross-game persistence.
   - "kibitzer" — spectator-only commentary plugin.

**Acceptance**:
- Diff: ≤ 1 file outside `packages/plugins/voting/`.
- Branch is merged into `main` once we hit ≤ 1 outside file.
- Lessons learned written to `wiki/development/adding-a-plugin.md`.

---

## Phase 6 — Dehoist CtL from web shell (~3–5 days)

### 6.1 — Move CtL-only files into the CtL game package

**Files to move**:
- `packages/web/src/components/HexGrid.tsx` (656 lines, single consumer)
  → `packages/games/capture-the-lobster/web/HexGrid.tsx`
- `packages/web/src/types.ts` — split: shared types stay; CtL types
  (hex coords, A/B teams, classes) move.
- `packages/web/public/tiles/` (Wesnoth assets) → per-game static dir
  at `packages/games/capture-the-lobster/web/assets/tiles/`.

**Asset pipeline (locked decision)**: game static assets live in each
game package under `web/assets/`. A build step in
`packages/web/package.json` copies every `packages/games/*/web/assets/`
directory into `packages/web/public/games/<gameId>/` at Pages-build
time. Asset URLs become `/games/capture-the-lobster/tiles/foo.png`.

**Rejected alternatives**:
- ES-module import + bundler: would require Vite changes for every
  game's asset tree, and bundles binary PNGs into JS — wrong shape for
  Cloudflare Pages caching.
- Per-game CDN: pre-launch overkill; adds a new deployment target.

**Implementation**:
- Script: `packages/web/scripts/sync-game-assets.ts` (Node, runs in
  predev and prebuild). Uses `fs.cp` with `recursive: true`.
- Update `packages/web/package.json`: add `"predev": "tsx scripts/sync-game-assets.ts"`
  and `"prebuild": "tsx scripts/sync-game-assets.ts"`.
- Add `packages/web/public/games/` to `.gitignore` (regenerated
  artifact, not checked in).
- Update all CtL asset URL references from `/tiles/foo.png` to
  `/games/capture-the-lobster/tiles/foo.png`.
- Cloudflare Pages routing: no changes — Pages serves everything under
  `public/` as static at the root, so `/games/<id>/...` Just Works.

**Acceptance**:
- `grep -rn "HexGrid\|hexCoord" packages/web/src/` = empty.
- `ls packages/web/public/tiles/` = absent (moved out).
- `ls packages/games/capture-the-lobster/web/assets/tiles/` populated.
- `npm run dev` syncs assets and serves them.
- `npm run build` in `packages/web/` produces a `public/games/capture-the-lobster/tiles/`
  directory in build output.
- Visual: CtL UI identical before/after (manual QA).
- OATH has zero tile PNGs shipped (verifies per-game isolation).

### 6.2 — Layout / HomePage / JoinInstructions registry-driven

**Files**:
- `packages/web/src/components/Layout.tsx`
- `packages/web/src/pages/HomePage.tsx`
- `packages/web/src/components/JoinInstructions.tsx`

**Implementation**:
- Each game's `SpectatorPlugin` (or new `GameMetaPlugin`) declares
  branding: `{ shortName, longName, icon, primaryColor, intro }`.
- Layout reads active game from URL/context.

**Acceptance**:
- Layout has no `lobster`/`oathbreaker` literals.
- OATH games render without lobster emoji.

### 6.3 — LobbiesPage `lobby:card` slot

**Files**:
- `packages/web/src/pages/LobbiesPage.tsx` — replace branched render
  paths with `<SlotHost name="lobby:card" game={g} />`.

**Acceptance**:
- No `gameType === 'oathbreaker' ? … : …` branches in shell pages.

### 6.4 — Drop `SpectatorViewProps.perspective`

**Files**:
- `packages/web/src/games/types.ts` — remove
  `perspective: 'all' | 'A' | 'B'`.
- Each game owns its perspective UI internally.

### 6.5 — Game-ID literal sweep

**Files**: ~30 sites; produce a list:
```bash
grep -rn "'capture-the-lobster'\|'oathbreaker'\|\"capture-the-lobster\"\|\"oathbreaker\"" packages/
```

**Implementation**:
- Each literal becomes a registry lookup or is deleted.
- Default game on home page: first registered, not a string default.

**Acceptance**:
- Grep above returns hits **only inside game packages** that own the ID.

---

## Phase 7 — Spectator / data-flow cleanup (~3–5 days)

### 7.1 — Unify spectator transport (WS + HTTP)

**Goal**: one payload builder, two thin transports.

**Prerequisite**: Phase 4.4's `RelayClient.visibleTo(viewer)` is the
canonical filter surface (Phase 0.1's inline filter is superseded).
Build `buildSpectatorPayload(state, viewer)` on top of `RelayClient` so
HTTP and WS share one code path end-to-end.

Make both transports thin shells:
- HTTP returns one payload (`sinceIdx` from query string, **clamped to
  current public index** — never trust the client claim).
- WS returns the same payload on connect, then deltas on each broadcast.

**Frontend hook**:
```ts
// useSpectatorStream.ts
export function useSpectatorStream(gameId: string, opts?: {
  mode?: 'live' | 'replay';      // replay disables WS
  initialSnapshot?: SpectatorSnapshot;  // SSR / initial paint
}): {
  snapshot: SpectatorSnapshot | undefined;
  isLive: boolean;               // false during HTTP-only fallback
  sinceIdx: number;
  error: Error | null;
};
```

Hook MUST handle:
- React StrictMode double-mount (don't open 2 WS).
- `gameId` change (close old WS, open new).
- Replay mode (no WS, just HTTP).
- Initial paint flash (use `initialSnapshot` if provided).
- Subsuming the recent rewind state (C1–C7 commits) in `GamePage.tsx`.

**Files**:
- `packages/workers-server/src/do/GameRoomDO.ts` — both paths route
  through `buildSpectatorPayload(state, viewer)` → `RelayClient.visibleTo`.
- `packages/workers-server/src/do/LobbyDO.ts` — same.
- New: `packages/workers-server/src/plugins/spectator-payload.ts` —
  defines `buildSpectatorPayload(state, viewer)`; uses `RelayClient`
  from 4.4.
- New: `packages/web/src/hooks/useSpectatorStream.ts`.
- `packages/web/src/games/*/SpectatorView.tsx` — consume the hook;
  delete duplicated WS lifecycle code.

**Acceptance**:
- Both HTTP and WS return identical payload shape from a single function.
- WS disconnect → HTTP poll fallback within 5s, transparent to UI.
- WS reconnect → resume from `sinceIdx` without duplicate snapshots.

**Observability**: counter `transport.fallback{from=ws,to=http}` per
session. Sustained high rate = WS broken.

### 7.2 — Two-WS bug fix

**Goal**: live `/game/:id` opens one WS, not two.

After Phase 5.1 chat migration, chat is in the unified payload; drop the
chat-extraction WS in `GamePage.tsx`.

**Acceptance**: DevTools shows one WS connection per game page.

### 7.3 — `_progress.snapshots` and `_lastSpectatorIdx`

**Goal**: one persists, one is deleted.

**Files**:
- `packages/workers-server/src/do/GameRoomDO.ts`

**Locked decisions**:
- `_lastSpectatorIdx`: persist to DO storage. Eviction causes duplicate
  spectator broadcasts today. Add `storage.get('lastSpectatorIdx')` on
  DO init and `storage.put` on every bump.
- `_progress.snapshots`: **DELETE.** Written at every progress tick,
  read by nothing. If a future consumer materializes (replay
  fast-seek, timeline scrubber, etc.) we can rebuild it — but we don't
  keep write-only state on the off chance. No investigation, no
  "identify a consumer" step. Just delete the field, the writes, and
  the storage key.

**Acceptance**:
- `grep -rn "progress\.snapshots\|_progress\.snapshots" packages/` = 0
  hits outside git history.
- `_lastSpectatorIdx` survives DO hibernation (test: trigger
  hibernation mid-game, assert no duplicate broadcasts after wake).

---

## Phase 8 — Final consistency sweep (~2–3 days)

### 8.1 — Bot harness genericity

**Files**:
- `scripts/lib/bot-agent.ts` — bot prompt.
- `wiki/development/bot-system.md`.

**Implementation**:
- Bot prompt builds tool catalog via `get_guide()`; no per-game tool
  example list.
- Game-over heuristic uses `getReplayChrome(...).isFinished`, not string
  match for "captured the flag."

**Acceptance**:
- Bot prompt has zero per-game references.
- Bot plays both games out-of-the-box.

### 8.2 — CLI command surface audit

**Acceptance**:
- No CLI command file references a game by ID.
- Game-specific commands dynamically registered from plugins.

### 8.3 — Wiki sweep (verify-only)

**Process**:
- Walk every `wiki/` page; confirm it matches code.
- Per operating principles, prior PRs have already updated wiki for
  their changes. This phase is a final pass: any drift = a PR-process
  failure to file as a separate issue.

**Acceptance**:
- Random-page test: reviewer reads a randomly selected wiki page and
  successfully predicts the live behavior.

---

## D1 migration appendix

Per no-compat policy, every shape change is a clean drop+recreate. List:

| # | File | Phase | Purpose |
|---|------|-------|---------|
| 0009 | `0009_phase_enum_unify.sql` | 4.6 | Drop and recreate `phase` column with unified enum |
| 0010 | `0010_elo_plugin_namespace.sql` | 5.2 | Drop `elo` tables, recreate under `plugin_elo_*` |
| 0011 | `0011_settlement_state.sql` | 3.2 | New table backing `SettlementStateMachine` |

DO storage shapes (`relay`, `state`, etc.) are not migrated — they're
ephemeral and die cleanly between deploys per no-compat.

---

## Estimates (recalibrated)

| Phase | Days  | Sequenced after |
|-------|-------|-----------------|
| 0     | 0.5   | —               |
| 1     | 1–2   | 0               |
| 2     | 2     | 1               |
| 4.1+4.3 | 3   | 2               |
| 3     | 3–5   | 4.1 + 4.3       |
| 4.2, 4.4–4.7 | 4–5 | 3 *or* parallel with 3 (files disjoint) |
| 5     | 7–10  | 3, 4            |
| 6     | 3–5   | 4               |
| 7     | 3–5   | 4, 5            |
| 8     | 2–3   | 5–7             |

**Total**: ~5–6 weeks focused, realistic 7–8.

**Why Phase 1 before Phase 2**: strict-mode triage (2.3) on code you're
about to delete is wasted work. Ship the dead-engine deletion first
(Phase 1) so the lint/typecheck pass in 2.3 operates on live code only.

**Why 4.1 + 4.3 before Phase 3.2**: 3.2's `SettlementStateMachine`
takes its dependencies as `Pick<Capabilities, 'storage' | 'chain' |
'alarms'>`. `Capabilities` is defined by 4.3. If 3.2 ships first, it
defines a redundant `SettlementDeps` interface that 5.3 has to
reconcile against 4.3's `Capabilities` anyway. One DI shape is better
than two.

**Why 3 and the rest of 4 aren't a hard sequence**: after 4.1 +
4.3 land, the remaining Phase 4 tasks (4.2 validation registry, 4.4
RelayClient, 4.5 slot host, 4.6 CoordinationGame refinements,
4.7 replay chrome) touch different files than Phase 3's remaining
tasks (3.1 payouts in OATH plugin, 3.3 canonical encoder, 3.4 merkle,
3.5 contracts, 3.6 hardhat, 3.7 auth RPC fallback). These can
legitimately run in parallel by different owners. 3.2 is the only
Phase 3 task with a hard blocker on 4.3.

---

## What we are NOT doing

- Rewriting Solidity contract architecture. Reentrancy + canonical
  hashing only.
- Adding new games. Phase 4.6 makes it trivial; not a deliverable.
- Replacing Cloudflare Workers / DO. Dead engine deletion is *not* an
  invitation to redesign the runtime.
- Splitting the monorepo.
- Backwards compatibility. Pre-launch; we just write the right code.
