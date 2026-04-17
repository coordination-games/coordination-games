# Spectator Delay — Security Fix and Unification

**Status:** Draft plan, ready for implementation.
**Owner:** Borg (Capture the Lobster thread).
**Date:** 2026-04-17.

---

## 1. Goal and invariants

Make the spectator-delay guarantee a **server-enforced, single-boundary
invariant**:

> At any moment during an active game, no caller — authenticated or not,
> player-in-the-game or not — can obtain state, relay messages, chat, or
> derived summaries from turns within the last `spectatorDelay` progress
> ticks through any public endpoint. Client-side filtering is never
> part of the defence.

This applies to Capture the Lobster (delay = 2) today and must hold for
any future game that sets a non-zero `spectatorDelay`.

Legitimate capabilities to preserve:

- An authenticated player sees **their own** fog-filtered current-turn
  view in real time.
- A player receives their own team's scoped chat in real time.
- An opposing-team player never receives opposing-team chat in any
  form.
- Finished games are fully public (replay, snapshots, chat, bundle,
  settlement).
- Mid-game scrubbing is possible but bounded to the public (delayed)
  window.

## 2. Current bugs

Source-of-truth quotations are from `packages/workers-server/src/do/GameRoomDO.ts`
and `packages/workers-server/src/index.ts` at commit `be44ed7` on `main`.

### Bug A — `/api/games/:id/replay` leaks the full undelayed snapshot array

`index.ts:297` lists `/replay` alongside `/spectator` and `/bundle` as a
no-auth "spectator-safe" path. `GameRoomDO.handleReplay`
(`:338–368`) returns `_spectatorSnapshots` verbatim: no `finished` gate,
no truncation, and an undocumented `relay: this._relay` field tacked on
that exposes every relay message in the DO.

**Impact:** any caller with the game ID hits `GET
/api/games/<id>/replay` mid-game and reads the latest turn, plus every
DM, plus every team-scoped chat message.

### Bug B — `/api/games/:id/state?playerId=<victim>` leaks any player's live fog-filtered view

`index.ts:302–308` authenticates the caller and sets `X-Player-Id` on
the forwarded request, but **does not strip the `?playerId=` query
param**. `GameRoomDO.handleState` (`:259–264`) reads `playerId` from the
query param and trusts it — never cross-checking against the header or
`_meta.playerIds`.

**Impact:** any registered user — including a Team B player in the same
game, or a completely unrelated account — calls
`/api/games/<id>/state?playerId=<victim>` and receives the victim's
undelayed fog-filtered state, including their `chatA`/`chatB` via
`getVisibleRelay` (`:460–484`). This is strictly worse than Bug A: it
leaks per-team chat and private fog, not just the public snapshot.

### Bug C — Delay depth is hardcoded to 1, ignoring `spectatorDelay`

`GameRoomDO.ts:738–756`:

```ts
private buildSpectatorMessage(): object {
  const delay = this._plugin!.spectatorDelay ?? 0;
  const relayMessages = this._relay.filter(m => m.scope === 'all');
  const ctx = { handles: this._meta!.handleMap, relayMessages };
  const view = delay > 0 && this._prevProgressState && !finished
    ? this._plugin!.buildSpectatorView(this._prevProgressState, null, ctx)
    : this._plugin!.buildSpectatorView(this._state, this._prevProgressState, ctx);
  // ...
}
```

`delay` is only checked as a boolean. `_prevProgressState` is updated at
every progress tick (`:558`) to the state *before* the most-recent
action, so it is exactly one tick behind regardless of whether
`spectatorDelay` is 1, 2, or 50.

CtL declares `spectatorDelay: 2`
(`packages/games/capture-the-lobster/src/plugin.ts:641`) but the live
spectator feed delivers a one-tick delay. On a brand-new game before
the first tick, `_prevProgressState` is `null` and the fallback branch
emits the *current* state — zero delay.

### Bug D — Live spectator broadcast strips all team chat

Same block, `:742`:

```ts
const relayMessages = this._relay.filter(m => m.scope === 'all');
```

Only `all`-scoped messages survive. The CtL plugin's
`buildSpectatorView` (`plugin.ts:259–264`) filters its input relay for
`scope === 'team'` when building `chatA` / `chatB`, so after the DO's
`'all'`-only filter the plugin sees nothing team-scoped and the chat
arrays are always empty. Live spectators see zero chat, even though
stored snapshots correctly include both teams' team-scoped chat
(`:564`).

### Bug E — `writeSummaryToD1` publishes current-state summary via `GET /api/games`

`GameRoomDO.ts` calls `plugin.getSummary(this._state)` on every progress
tick and writes the result to D1's `game_summaries`, served
unauthenticated via `GET /api/games` (`index.ts:472–507`).

CtL's `getSummary` (`plugin.ts:628–639`) returns
`{ turn, maxTurns, phase, winner, teams }`. The **`winner` field is
set the instant `isOver` returns true**, but `_meta.finished` (which
gates the replay / bundle endpoints) is only flipped inside the same
action path. More importantly, `turn` and `winner` are published
live — so the list endpoint reveals the outcome of a game at the
actual game-over turn, while the delayed spectator view is still
showing two turns earlier. Anyone polling `/api/games` during a match
can see "Team A won" before that turn becomes visible in the spectator
view.

For OATHBREAKER (delay = 0) this is a non-issue; for any game with a
non-zero delay it is a real leak.

## 3. Why it got fucked up

Four code paths each make their own independent decision about what
public data to emit:

1. `buildSpectatorMessage` — live WS push + HTTP `/spectator`. Drops
   team chat, one-turn delay, ignores snapshot store.
2. Progress-tick snapshot writer (`:557–567`) — keeps team chat,
   captures the *new* (undelayed) state, writes to
   `_spectatorSnapshots`.
3. `handleReplay` — returns `_spectatorSnapshots` plus raw `_relay`,
   with no auth gate, no truncation.
4. `handleState` — reads `playerId` from an untrusted query param.
5. `writeSummaryToD1` → `GET /api/games` — writes current state as a
   publicly-readable summary.

No shared helper answers "what is a caller allowed to see right
now?" Each path improvises, and four of five get it wrong. The
architectural fix is to collapse these onto one visibility oracle.

## 4. Target architecture

### 4.1 Invariants codified

1. `_spectatorSnapshots[N]` is the full-fidelity snapshot at progress
   tick N, including both teams' team-scoped chat up to that tick.
   This structure is **internal** to the DO; it is never emitted
   as-is for an active game.
2. There is exactly one helper — `publicSnapshotIndex()` — that
   answers "what is the highest snapshot index a caller without
   player-level authorisation may see right now?". Every public
   emission boundary calls it. No exceptions.
3. Public emission boundaries are:
   - Live spectator WS broadcast + initial WS message + HTTP
     `/spectator`.
   - HTTP `/replay` (active-game scrubber / finished-game replay).
   - `GET /api/games` list summaries.
4. Player-level boundaries (`handleState`, player WS,
   `broadcastRelayMessage`) derive authorisation from the **trusted**
   `X-Player-Id` header, never from a request body or query param.
5. `spectatorDelay` is frozen into `_meta` at game creation. Changes to
   the plugin value affect only future games. Deployments never reveal
   in-flight data retroactively.

### 4.2 The helper

```ts
/**
 * Highest index in _spectatorSnapshots that may be revealed to a
 * caller without player-level authorisation. Returns null if the
 * delay window has not yet elapsed (nothing is public yet).
 *
 * Pure function of _spectatorSnapshots length, _meta.finished, and
 * _meta.spectatorDelay. Exported for unit testing.
 */
function computePublicSnapshotIndex(
  snapshotCount: number,
  finished: boolean,
  delay: number,
): number | null {
  const lastIdx = snapshotCount - 1;
  if (lastIdx < 0) return null;
  if (finished) return lastIdx;
  const idx = lastIdx - delay;
  return idx >= 0 ? idx : null;
}

// On the class:
private publicSnapshotIndex(): number | null {
  if (!this._meta) return null;
  return computePublicSnapshotIndex(
    this._spectatorSnapshots.length,
    this._meta.finished,
    this._meta.spectatorDelay ?? 0,
  );
}
```

Notes:

- **Index, not turn.** An index of N means "show snapshot at tick N",
  which is state *after* N progress ticks from game creation. The
  initial snapshot written at game creation has index 0.
- Finished games expose everything. There is no competitive reason to
  withhold data after settlement.
- `null` means pre-window: no snapshot is public yet.

### 4.3 `spectatorDelay` pinned into `_meta`

At game creation in `GameRoomDO` (the point that writes the initial
snapshot at `:218`), also set:

```ts
this._meta.spectatorDelay = this._plugin.spectatorDelay ?? 0;
```

Persist in storage alongside the rest of `_meta`. When loading an
existing game, fall back to `this._plugin.spectatorDelay ?? 0` if the
field is absent — handles the one-time migration for in-flight games.

### 4.4 Live spectator feed

`buildSpectatorMessage` is rewritten to emit either the stored
delayed snapshot or a pre-window envelope:

```ts
private buildSpectatorMessage(): object {
  const idx = this.publicSnapshotIndex();
  if (idx === null) {
    return {
      type: 'spectator_pending',
      gameType: this._meta!.gameType,
      handles: this._meta!.handleMap,
      progressCounter: null,
    };
  }
  const snapshot = this._spectatorSnapshots[idx] as Record<string, unknown>;
  return {
    type: 'state_update',
    gameType: this._meta!.gameType,
    handles: this._meta!.handleMap,
    progressCounter: idx,  // ← what we're showing, not what exists
    ...snapshot,
  };
}
```

The envelope-level `type: 'spectator_pending'` is used instead of
shoving a new value into the game-level `phase` enum
(`packages/web/src/types.ts:37` defines
`'pre_game' | 'in_progress' | 'finished'` — stay out of its namespace).

### 4.5 Broadcast cadence

Today `broadcastUpdates` fires a spectator push on every applied
action. After the fix, push to the spectator tag only when
`publicSnapshotIndex()` has *advanced* since the last broadcast. Track
`_lastSpectatorIdx: number | null` on the DO:

```ts
private broadcastUpdates(): void {
  if (!this._meta || !this._plugin) return;

  try {
    const idx = this.publicSnapshotIndex();
    if (idx !== this._lastSpectatorIdx) {
      const msg = JSON.stringify(this.buildSpectatorMessage());
      for (const ws of this.ctx.getWebSockets(TAG_SPECTATOR)) {
        try { ws.send(msg); } catch {}
      }
      this._lastSpectatorIdx = idx;
    }

    // Player broadcasts unchanged — they always see latest.
    for (const pid of this._meta.playerIds) {
      const conns = this.ctx.getWebSockets(pid);
      if (conns.length === 0) continue;
      const payload = JSON.stringify(this.buildPlayerMessage(pid));
      for (const ws of conns) {
        try { ws.send(payload); } catch {}
      }
    }
  } catch (err) {
    console.error('[GameRoomDO] broadcastUpdates failed:', err);
  }
}
```

This closes a tick-timing side-channel (spectators could previously
count push events to infer hidden action cadence) and reduces
bandwidth.

### 4.6 Replay / scrubber feed

`handleReplay` becomes truncation + envelope:

```ts
private async handleReplay(): Promise<Response> {
  await this.ensureLoaded();
  if (!this._meta || !this._plugin) {
    return Response.json({ error: 'Game not found' }, { status: 404 });
  }

  const idx = this.publicSnapshotIndex();
  if (idx === null) {
    return Response.json({
      type: 'spectator_pending',
      gameType: this._meta.gameType,
      gameId: this._meta.gameId,
      handles: this._meta.handleMap,
      teamMap: this._meta.teamMap,
      finished: false,
      progressCounter: null,
      snapshots: [],
    });
  }

  return Response.json({
    type: 'replay',
    gameType: this._meta.gameType,
    gameId: this._meta.gameId,
    handles: this._meta.handleMap,
    teamMap: this._meta.teamMap,
    finished: this._meta.finished,
    progressCounter: idx,
    snapshots: this._spectatorSnapshots.slice(0, idx + 1),
  });
}
```

Changes from today:

- Snapshots truncated to `[0, publicSnapshotIndex()]`.
- **Raw `relay` field dropped.** Nothing in the frontend consumes it on
  this endpoint (verified: `ReplayPage` reads only `snapshots`), and
  exposing raw relay to an unauthenticated caller is an open-ended leak
  surface (DMs, per-turn timing, any future metadata).
- `ReplayData.relay` is removed from `packages/web/src/api.ts`
  correspondingly. The `ReplayData.progressCounter` field widens to
  `number | null`.

### 4.7 `handleState` — trust only the header

```ts
private async handleState(url: URL): Promise<Response> {
  await this.ensureLoaded();
  if (!this._meta || !this._plugin) {
    return Response.json({ error: 'Game not found' }, { status: 404 });
  }

  // Only trust the header set by the authenticated Worker.
  const playerId = url.searchParams.get('playerId');  // legacy compat only
  const headerPlayerId = this.lastRequestHeaders?.get('X-Player-Id') ?? null;
  const effectivePid = headerPlayerId;

  if (effectivePid && !this._meta.playerIds.includes(effectivePid)) {
    return Response.json({ error: 'Not a player in this game' }, { status: 403 });
  }

  // The query param is ignored. If a caller needs "spectator view",
  // they call /spectator, not /state.
  return Response.json(this.buildPlayerMessage(effectivePid));
}
```

The DO doesn't see raw headers on `url` — it needs the request.
Adjust the signature to accept the `Request` and read
`request.headers.get('X-Player-Id')` directly; the existing handler
invocation at `:117` already has access. Small refactor.

Paired Worker change: `index.ts:306` already forwards the request
as-is. Also explicitly strip `playerId` from the forwarded URL so that
even if the DO logic regresses, the Worker never forwards attacker
input. `handlePlayerState` at `index.ts:586–588` continues to use the
query-param form internally, but adjust it to also set the header —
then the DO only reads the header path, and both the /api/player/state
and /api/games/:id/state routes go through the same DO code.

### 4.8 `writeSummaryToD1` — gate by public index

Replace `plugin.getSummary(this._state)` with a summary built from the
public snapshot:

```ts
private writeSummaryToD1(): void {
  const idx = this.publicSnapshotIndex();
  if (idx === null) return;  // pre-window — don't publish anything yet

  const publicSnapshot = this._spectatorSnapshots[idx] as SpectatorState;
  // Plugin exposes `getSummary(state)` — pass the public-visible state
  // instead of the raw current state. For games that store public state
  // directly, pass the snapshot. Otherwise the plugin adapts internally.
  const summary = this._plugin.getSummary
    ? this._plugin.getSummaryFromSpectator?.(publicSnapshot)
      ?? this._plugin.getSummary(publicSnapshot as any)
    : {};
  // ... existing D1 write ...
}
```

Plugin contract update: add optional
`getSummaryFromSpectator?(snapshot: SpectatorState): Record<string, any>`
on `CoordinationGame`. If absent, fall back to `getSummary(state)`
called with the *snapshot* — which works for CtL today because
`getSummary` only reads `state.turn`, `state.config.turnLimit`,
`state.phase`, `state.winner`, and unit IDs, and all of those are
present (with the same names) on the public snapshot shape.

OATHBREAKER is unaffected: delay = 0 means `publicSnapshotIndex()`
always returns `lastIdx`, so the public snapshot equals the current
snapshot.

### 4.9 Untouched paths

- `buildPlayerMessage` — correct, uses `getStateForAgent` with
  fog-of-war and `getVisibleRelay`. Keep.
- `resolveRelayRecipients` (`:490–510`) — correctly scopes `scope:
  'team'` to same-team `playerIds` and DMs to sender + recipient. Keep.
- `broadcastRelayMessage` — delivers to authorised playerIds by WS
  tag. Cannot reach `TAG_SPECTATOR`-tagged sockets. Keep.
- `/bundle` — already finished-gated (`:307`). Keep.
- `/result` (`:267–302`) — finished-gated, returns outcome +
  merkle root only. Keep.

## 5. Frontend changes

### 5.1 `CtlSpectatorView` — pre-window branch

The current view assumes the WS message is a `state_update` envelope
with `tiles`. The pre-window envelope has no `tiles`. `mapServerState`
(`packages/web/src/games/capture-the-lobster/SpectatorView.tsx:16–91`)
returns `null` in that case and the early return at `:334` shows
"Connecting…" — wrong.

Add an early branch in the WS `onmessage` handler:

```ts
if (raw.type === 'spectator_pending') {
  setLiveState(null);
  setPendingWindow(true);
  return;
}
setPendingWindow(false);
// ...existing mapping...
```

Render: when `pendingWindow` is true, show the existing "Spectator view
is delayed — waiting for first turns to resolve…" placeholder from
`:459–471`. Move that placeholder out of the `turn === 0 && !isReplay`
branch so it's driven by the pending flag, not a state field.

`OathbreakerSpectatorView` is unaffected in practice (delay = 0, never
pending) but add a symmetric branch for consistency.

### 5.2 `ReplayData` type

`packages/web/src/api.ts:45–58`:

- Drop the `relay: any[]` field.
- Widen `progressCounter: number` to `progressCounter: number | null`.
- Add optional discriminator `type?: 'replay' | 'spectator_pending'`.

`ReplayPage` handles `type === 'spectator_pending'` by showing the
pending placeholder instead of the "No replay data" error at `:122`.

### 5.3 Live scrubber (deferred)

Out of scope for this PR. The fix to `/replay` unblocks it; see §9.

## 6. Tests

### 6.1 Unit tests — `computePublicSnapshotIndex`

Pure function, lives in a new module
`packages/workers-server/src/do/spectator-delay.ts` alongside the class
method that calls it. Tests in
`packages/workers-server/src/__tests__/spectator-delay.test.ts` cover:

1. Delay 0, 0 snapshots → `null`.
2. Delay 0, 1 snapshot, unfinished → `0`.
3. Delay 0, 5 snapshots, unfinished → `4`.
4. Delay 2, 0 snapshots → `null`.
5. Delay 2, 1 snapshot, unfinished → `null`.
6. Delay 2, 2 snapshots, unfinished → `null`.
7. Delay 2, 3 snapshots, unfinished → `0`.
8. Delay 2, 5 snapshots, unfinished → `2`.
9. Delay 2, 5 snapshots, finished → `4` (full reveal on finish).
10. Delay 50, 10 snapshots, unfinished → `null`.

All run under existing `vitest` setup — no Miniflare needed.

### 6.2 Integration smoke test — `scripts/smoke-spectator-delay.ts`

Run against `wrangler dev`. Scenarios (each an assertion, exits
non-zero on failure):

- **T1 (Bug C / D).** Create a CtL game with two authenticated bots,
  drive it through five progress ticks. `GET /spectator` returns
  snapshot at index `length - 1 - 2`; payload contains non-empty
  `chatA` and `chatB` corresponding to tick ≤ 3.
- **T2 (Bug C pre-window).** Immediately after creation, `GET
  /spectator` returns `{ type: 'spectator_pending', ... }` with no
  `tiles` field.
- **T3 (Bug A).** Mid-game at tick 5 with delay 2, `GET /replay`
  returns `snapshots.length === 4` (indices 0..3), last snapshot's
  `turn` is 3. Response has no `relay` field.
- **T4 (chat cross-team leak).** Inject a Team B relay message at tick
  5. `GET /spectator` at tick 5 does not contain it in `chatB`.
  Continue the game to tick 7; `GET /spectator` now contains it.
- **T5 (Bug B).** Authenticate as user Y. `GET
  /api/games/<id>/state?playerId=<X>` returns 403 (or returns Y's
  state; either is acceptable — the requirement is that it never
  returns X's state). Also `GET /api/games/<id>/state?playerId=<someone-not-in-game>`
  returns 403.
- **T6 (Bug E).** After game ends at tick 5, before `isOver` triggers
  the snapshot-delay boundary — specifically: create a game where
  tick 5 is the winning move. `GET /api/games` list endpoint does not
  show `winner` until `finished: true` is set AND the public
  spectator view has caught up. (Simpler framing: after the fix,
  `writeSummaryToD1` uses the public snapshot, so `winner` appears
  when the public snapshot shows it.)
- **T7 (player delivery).** Team A player WS receives own-team chat
  messages in real time with no delay.
- **T8 (opposing team isolation).** Team A player WS never receives
  any Team B relay message.
- **T9 (finished reveal).** After game finishes, `GET /spectator` and
  `GET /replay` both return the final-state snapshot with
  `progressCounter` equal to the true last index.
- **T10 (reconnect).** Close spectator WS, reopen. Received initial
  message equals current `buildSpectatorMessage()` output.

Add `npm run smoke:spectator` in `packages/workers-server/package.json`
that boots `wrangler dev` in the background, runs the script, tears
down.

### 6.3 Frontend check

Manual: open `/game/<id>` on a CtL game in progress. Confirm the turn
counter in the spectator view is two behind the players'. Confirm chat
appears in the delayed view. Confirm `/replay/<id>` scrubber works and
its slider max equals `publicSnapshotIndex()` of the moment.

## 7. Risks, sharp edges, and known unknowns

### 7.1 OATHBREAKER regression risk

OATH has `spectatorDelay: 0`. Today's `buildSpectatorMessage` rebuilds
`ctx` (including the latest `_relay` messages) at emit time and calls
`buildSpectatorView` live. After the fix, the emitted snapshot is
whatever was frozen at the last progress tick — so any `scope: 'all'`
relay message sent *between* progress ticks does not reach live
spectators until the next tick.

**Action before merge:** grep OATH for `scope: 'all'` emissions and
confirm none are expected to arrive mid-tick. Current audit:
`packages/games/oathbreaker/src/plugin.ts` emits relay only inside
`applyAction`, which is followed by a progress tick, so there is no
between-tick gap. Document this plugin-contract invariant in the wiki:
"plugins that want real-time all-scope relay to spectators must emit
it via progressIncrement actions."

### 7.2 `_prevProgressState` becomes unused — delete it together with the `/replay` fallback

After the fix:

- `buildSpectatorMessage` no longer reads it.
- `handleReplay` no longer reads it (the fallback branch at `:342–357`
  that reads it is dead code — the initial snapshot is always written
  at game creation, so `_spectatorSnapshots.length === 0` is
  unreachable for games created after the snapshot feature landed).
- `applyActionInternal` still writes it at `:558` and persists it at
  `:575`.

Delete in one pass: the fallback branch, the writes, the storage put,
the storage load in `ensureLoaded`, and the field itself. Add a
one-time `ctx.storage.delete('prevProgressState')` on load. Confirmed
no other readers via grep.

### 7.3 `progressCounter` semantics change

Today the live spectator message reports `this._progress.counter` —
the true internal counter. After the fix, spectator and replay
responses report the *displayed* index (`null` when pre-window). No
frontend consumer currently reads it as a monotonic tick counter
(grep in `packages/web/src/api.ts` finds only DTO declarations), so
the widening is safe. Plan the type change to `number | null` in
`api.ts:51` in the same PR.

### 7.4 Deploy ordering

Order matters on deploy:

1. Deploy backend first. In-flight CtL games: `_meta.spectatorDelay` is
   absent from storage → fallback to plugin value (2) → correct
   behaviour from first request after deploy. No migration script.
2. Deploy frontend immediately after. Before the frontend update, the
   new `type: 'spectator_pending'` envelope lands at a client that
   doesn't know the type; `mapServerState` returns null → current
   "Connecting…" placeholder. Annoying but not broken. Confirmed no
   client crash because the code already guards on `gameState` being
   null.

### 7.5 Snapshot array size

CtL cap is turn limit + 2 (progress writer fires once per action that
sets `progressIncrement`). Worst case ~30 snapshots. Each ~5–15 KB.
Total <500 KB — well inside CF Workers response-body limits (~10 MB
practical, 100 MB hard). OATHBREAKER is shorter. Not a concern.

### 7.6 Race: game ends between `applyActionInternal` and `broadcastUpdates`

`_meta.finished` is set at `:589` *before* `broadcastUpdates` is called
at `:657`, inside the same DO fetch. DO input gates serialise fetches
so no other request interleaves. The broadcast observes `finished:
true` and emits the full final snapshot. No flicker.

### 7.7 DO eviction + reload

`ensureLoaded` at `:787–840` restores `_spectatorSnapshots` from the
per-key storage entries. After the fix, also restore
`_meta.spectatorDelay` (written at creation). `_lastSpectatorIdx` is
not persisted; it's reset to `null` on reload, so the first
post-reload broadcast always fires — matches the first-connection
semantics, which is fine. Explicit test: T10.

### 7.8 Timing side-channel residual

Clamping broadcast to "public index advanced" eliminates the
per-action timing channel. A lower-bandwidth channel remains: the
interval between public-index advances leaks the tick duration. This
is inherent to real-time push; mitigating further would require
batched pushes with fixed cadence, which hurts UX. Accept this
residual.

### 7.9 Dev-mode / replay page regression

`LobbiesPage` links the "Replay" action to `/replay/<gameId>` for
every game, including in-progress ones. After the fix, mid-game
replays show a truncated scrubber, which is the intended behaviour.
Mark this as a feature, not a bug. `ReplayPage` already exits cleanly
when `snapshots.length === 0` (see §5.2's `spectator_pending` handler).

### 7.10 Things explicitly not fixed

- **Authenticated bot operator running both teams.** Trust boundary is
  per-playerId, not per-operator. Out of scope; document in wiki as a
  known non-goal.
- **Browser-side cached pre-fix `/replay` responses.** Historical;
  cannot unring. Invalidate via deploy-busting query string if needed
  (not doing it — impact is limited and transient).

## 8. Rollout

Single PR. Change inventory:

**`packages/workers-server/src/`:**
- New `do/spectator-delay.ts` — exported `computePublicSnapshotIndex`.
- `do/GameRoomDO.ts`:
  - Add `_lastSpectatorIdx` field.
  - Freeze `spectatorDelay` into `_meta` on create + persist + load.
  - Rewrite `buildSpectatorMessage` per §4.4.
  - Rewrite `broadcastUpdates` per §4.5.
  - Rewrite `handleReplay` per §4.6.
  - Rewrite `handleState` per §4.7.
  - Rewrite `writeSummaryToD1` per §4.8.
  - Delete `_prevProgressState` + `/replay` fallback branch (§7.2).
- `index.ts`:
  - In `forwardToGameDO` caller at `:306`, strip the `playerId` query
    param from the forwarded URL. Worker explicitly drops any
    attacker-controlled `?playerId=` before calling the DO.
  - In `handlePlayerState` at `:577–590`, set `X-Player-Id` header on
    the sub-request in addition to the URL param.
- `src/__tests__/spectator-delay.test.ts` — unit tests for helper.

**`packages/engine/src/`:**
- `types.ts`: add optional
  `getSummaryFromSpectator?(snapshot): Record<string, any>` on
  `CoordinationGame`. Add `spectatorDelay?: number` to `GameMeta` type
  if it's defined there (else keep locally in the DO's meta).

**`packages/web/src/`:**
- `api.ts:45–58`: drop `ReplayData.relay`; widen `progressCounter` to
  `number | null`; add optional `type` discriminator.
- `games/capture-the-lobster/SpectatorView.tsx`: add
  `spectator_pending` branch per §5.1.
- `games/oathbreaker/SpectatorView.tsx`: symmetric no-op branch for
  type safety.
- `pages/ReplayPage.tsx`: handle `type === 'spectator_pending'` per
  §5.2.

**`scripts/`:**
- `smoke-spectator-delay.ts` — integration scenarios T1–T10 per §6.2.

**`wiki/architecture/spectator-system.md`:**
- Document single-boundary rule and the helper.
- Document the plugin-contract invariant that real-time all-scope
  relay must piggyback on progress ticks (§7.1).
- Document that `spectatorDelay` is frozen at game creation.

### Sequence in the PR

1. Helper module + unit tests (smallest, fastest feedback).
2. `_meta.spectatorDelay` freeze.
3. `handleState` + Worker URL sanitisation (Bug B).
4. `buildSpectatorMessage` + pending envelope (Bugs C, D).
5. `broadcastUpdates` cadence clamp.
6. `handleReplay` truncation (Bug A).
7. `writeSummaryToD1` gating (Bug E).
8. `_prevProgressState` deletion.
9. Frontend changes (§5).
10. Smoke script.
11. Wiki.

Each step compiles and tests clean independently; the PR can be
squashed or retained as a series.

### Deploy verification

From a laptop against prod, after deploy:

- `curl https://api.capturethelobster.com/api/games/<active>/replay`
  → snapshots truncated, no `relay` field.
- `curl -H 'Authorization: Bearer <Y>' '.../api/games/<active>/state?playerId=<X>'`
  → 403.
- Browser: load an active CtL game as spectator. Confirm the "Turn
  N/M" bar shows two fewer than the authoritative server turn
  (observable by cross-referencing the player-side view via a second
  tab as an in-game player).
- Browser: confirm chat appears in the delayed spectator view.

## 9. Out of scope / follow-ups

- **Live scrubber UI.** Unblocked by §4.6 but shipped in a separate
  PR. Design: add a "Rewind" toggle to `CtlSpectatorView`; when on,
  fetch `/replay` periodically and render the selected snapshot via
  the same plugin `SpectatorView`. Fallback to live WS feed when off.
- **Pushing real-time all-scope relay between progress ticks for
  delay=0 games.** Not currently needed by OATHBREAKER; revisit if a
  future game needs it. Would be a separate incremental push channel,
  not a spectator-view replacement.
- **Moving spectator logic into the plugin.** Index-based generic
  delay is sufficient and matches the existing `spectatorDelay`
  contract. Consider only if a future game needs per-turn visibility
  rules a uniform delay can't express.
- **On-chain settlement / merkle tree.** Unrelated — the settlement
  path fires after game end, exposes outcome + moves root only,
  already safe.
- **Rate limiting of `/api/games` list polling.** Orthogonal concern;
  belongs in a separate DoS-hardening pass.
