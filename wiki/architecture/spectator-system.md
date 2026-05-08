# Spectator System
> Spectators see a delayed projection of the game; the delay is measured in the game's own progress units, applied at exactly one boundary, and frozen at game creation so a deploy can't retroactively reveal hidden state.

## Why

A spectator is anyone watching without `X-Player-Id` — `/spectator`, the `/replay` shell, the public WS feed, the `/api/games` summary. None of them are entitled to see the live state, because the live state leaks the *cadence* of hidden actions: which players have submitted moves this turn, how long they sat thinking, when a turn flipped. If `broadcastUpdates` pushed every state mutation to the public WS, an observer with a stopwatch could infer turn timings even without seeing turn contents.

The defence is a delay measured in **progress units** (turns for CtL, rounds for OATHBREAKER), not in raw actions and not in wall-clock seconds. Wall-clock would be wrong because OATHBREAKER's per-pledge cadence is interactive — a 30-second wall delay in OB has no meaning. Action count would be wrong because CtL emits multiple actions per turn (one `submit_move` per player) and counting them leaks the same cadence we're trying to hide. A monotonic per-game counter (`getProgressCounter(state) → number`, `packages/engine/src/types.ts:188`) is the only thing both shapes agree on, and it's the game's own definition of "an interesting boundary just passed."

The other half of the design is **one boundary**. We could enforce delay at every public emission site separately — `/spectator`, `/replay`, the WS push, the D1 summary write. Every one of those is a place a future change could forget to apply the delay. Instead, every public emission goes through `computePublicSnapshotIndex(snapshotCount, finished, delay)` (`packages/workers-server/src/do/spectator-delay.ts:9`), and there is no other path. Adding a new public surface means calling that function — there's nowhere else to put a snapshot. We also push spectator WS frames *only when the public index advances* (`broadcastUpdates`, `packages/workers-server/src/do/GameRoomDO.ts:1519`), so an observer can't count push events to infer hidden-action cadence either.

The scar pinned in `/replay`: returning the raw relay log alongside snapshots would have leaked DMs, team chat, and per-action turn timings. The handler intentionally serves *only* `_spectatorSnapshots.slice(0, idx + 1)` (`packages/workers-server/src/do/GameRoomDO.ts:855`); chat a spectator is entitled to see is already baked into each snapshot via `buildSpectatorView`'s `SpectatorContext.relayMessages`. There is no second relay channel for replay.

## How

**Three tiers of visibility.**

| Tier | What they see | Fog | Delay |
|---|---|---|---|
| Agent | `getVisibleState(state, playerId)` — fog-filtered + relay scoped to them + pipeline output | Yes | No |
| Spectator | `buildSpectatorView(state, prevState, ctx)` snapshot + scope-`all`/`team` relay folded into the snapshot | No | Yes (progress-based) |
| Server (admin) | Full state + every relay scope (internal only) | No | No |

**Snapshot capture is derived, not declared.** `applyActionInternal` compares `getProgressCounter(prevState)` vs `getProgressCounter(newState)`; on advance it captures a new snapshot via `plugin.buildSpectatorView(state, prevState, snapshotCtx)` and appends to `_spectatorSnapshots` (`packages/workers-server/src/do/GameRoomDO.ts:1117-1135`). Snapshot 0 is built at game creation (`:615`) so even pre-window callers have something coherent under the delay. The defensive `>` guard means a non-monotonic counter (rewinds, resets) silently produces no snapshots — never a corrupted history.

**The single boundary.** `computePublicSnapshotIndex(snapshotCount, finished, delay)` returns the highest `_spectatorSnapshots` index a non-player caller may see:

```typescript
//   null                       — pre-window; nothing public yet.
//   snapshotCount - 1          — game finished (full reveal).
//   snapshotCount - 1 - delay  — active game, delay applied.
```

`packages/workers-server/src/do/spectator-delay.ts:9-19`. Every public emission boundary calls it via `publicSnapshotIndex()` (`packages/workers-server/src/do/GameRoomDO.ts:1455`):

- **Live spectator WS broadcast** (`broadcastUpdates`, `packages/workers-server/src/do/GameRoomDO.ts:1513`) — pushes only when `idx !== _lastSpectatorIdx` so push cadence cannot leak action cadence. The cursor is persisted to DO storage (`:1527`) so a post-eviction wake-up doesn't redeliver.
- **HTTP `/spectator` + initial WS frame** — both produced by `buildSpectatorPayload` (`packages/workers-server/src/plugins/spectator-payload.ts:175`), which receives the pre-resolved `publicSnapshotIndex` and pre-fetched snapshot.
- **HTTP `/replay`** (`handleReplay`, `packages/workers-server/src/do/GameRoomDO.ts:824`) — slices `_spectatorSnapshots` to `[0, idx]`, returns `spectator_pending` when `idx === null`, and never emits raw relay envelopes.
- **`/api/games` summary** — `writeSummaryToD1` (`packages/workers-server/src/do/GameRoomDO.ts:1324`) reads the public snapshot at `publicSnapshotIndex()` and runs `plugin.getSummaryFromSpectator(snapshot)` (`:1332`). The summary cannot leak ahead of the spectator view because it doesn't see raw state.

Player-level endpoints (`/state`, player WS, DM/team chat delivery) take identity exclusively from `X-Player-Id` set by the authenticated Worker. Query params and request bodies are ignored for player identity — there is no `?playerId=X` trust-anyone path. Player reads use the *current* state, not the delayed snapshot (`buildPlayerPayload`, `packages/workers-server/src/do/GameRoomDO.ts:1395`).

**Frozen-at-creation delay.** `GameMeta.spectatorDelay` is pinned when the room is created (`packages/workers-server/src/do/GameRoomDO.ts:609`) and reloaded across DO eviction (`:1636`). A deploy that changes `plugin.spectatorDelay` cannot retroactively shorten the delay on an in-flight game; new games pick up the new value, old games keep theirs. This is the same scar logic as `chain_agent_id` immutability — pinning frozen values out of plugin code is the only way a deploy can't corrupt in-flight contracts.

**Pre-window envelope.** When `publicSnapshotIndex()` returns `null`, public endpoints emit `{ type: 'spectator_pending', meta }` instead of a misleading `state_update` with empty content (`packages/workers-server/src/plugins/spectator-payload.ts:205`). The frontend `SpectatorPendingPlaceholder` renders a "Spectator view is delayed — waiting for first turns to resolve…" placeholder in `CtlSpectatorView`, `OathbreakerSpectatorView`, and `ReplayPage`.

**SpectatorPlugin (frontend).** Each game registers a `SpectatorPlugin` in `packages/web/src/games/registry.ts`:

```typescript
interface SpectatorPlugin {
  gameType: string;
  displayName: string;
  branding: GameBranding;
  SpectatorView: React.ComponentType<SpectatorViewProps>;
  GameCard?: React.ComponentType<GameCardProps>;
  animationDuration?: number;
  getReplayChrome(snapshot): ReplayChrome;
}
```

`packages/web/src/games/types.ts:82`. `SpectatorView` receives the raw spectator snapshot via `gameState`, the previous snapshot via `prevGameState` (for diffing), an `animate?: boolean`, and (in replay mode) `replaySnapshots`. The shell — `ReplayPage` (`packages/web/src/pages/ReplayPage.tsx:166`) and `GamePage` — owns the WS lifecycle, snapshot fetch, and scrubber state, then delegates rendering to `plugin.SpectatorView`. `getReplayChrome` returns the finish badge / winner label from a snapshot so the shell never inspects game-specific shapes. Animation specifics — what to do with `prevGameState` and `animate`, whether the game even animates at all — are the per-game view's problem; for CtL's implementation see `wiki/development/ctl-animations.md`.

**`buildSpectatorView` contract.** The game plugin owns the snapshot shape. Its inputs are `(state, prevState, SpectatorContext)` where `SpectatorContext.relayMessages` already contains every `scope: 'all' | 'team'` envelope visible up to this progress point (DMs are excluded by definition — `packages/workers-server/src/do/GameRoomDO.ts:1129-1132`). The plugin's job is purely to project state + relay into a spectator-shaped POJO; the framework handles fog (it doesn't apply any), the delay (already enforced by *when* this is called), and the relay scope (already filtered).

## Edge cases & gotchas

- **All-scope relay between progress ticks doesn't reach live spectators until the next tick.** A `buildSpectatorMessage`-style emission via the chat tool plugin (a separate path that doesn't go through `applyAction`) lands in the relay log but isn't visible to spectators until a progress tick captures a new snapshot embedding it. CtL has `spectatorDelay: 2` so all observable-public messages are naturally two-ticks delayed; OATHBREAKER has `spectatorDelay: 0` (`packages/games/oathbreaker/src/plugin.ts:246`) so "delayed" ≈ "next progress tick." If a game ever needs zero-tick public chat, route it through an action that bumps `getProgressCounter` instead.
- **Non-monotonic `getProgressCounter` silently produces no snapshots.** `applyActionInternal`'s `>` guard (`packages/workers-server/src/do/GameRoomDO.ts:1118`) is defensive; a counter that decreases on phase change or rewinds will never advance the snapshot list, and spectators will see frozen state with no error. Keep the counter monotonic — same rule as `wiki/architecture/engine-philosophy.md`'s "progress is derived, not declared."
- **`getSummaryFromSpectator` is required, not optional.** `registerGame` rejects plugins without it. The reason is exactly the boundary rule: the live `/api/games` summary cannot read raw state, because raw state is ahead of what spectators can see. The spectator snapshot is the privacy-filtered projection; `getSummaryFromSpectator(snapshot) ⊆ getSummary(state)` is the invariant (`packages/games/capture-the-lobster/src/__tests__/replay-chrome.test.ts:68` covers it for CtL).
- **An operator running every player on both teams is not a covered threat.** The trust boundary is per-`playerId`, not per-operator. A bot harness with both teams' bearer tokens reads both teams' fog-filtered states directly and the spectator delay does nothing for that case.
- **Per-tick cadence is still inferable.** A spectator can count push events to know *roughly* how often public progress ticks advance. The per-action timing channel is closed; the per-tick one is inherent to real-time push and is accepted by the design.
- **`spectatorDelay = 0` is not "no delay system."** It still routes through `computePublicSnapshotIndex`, still gates on `finished`, still emits `spectator_pending` until the first snapshot exists. The boundary is the same — only the constant changes.
- **Initial snapshot 0 is captured at creation, not on first action.** `_spectatorSnapshots[0]` is `buildSpectatorView(initialState, null, {handles, relayMessages: []})` (`packages/workers-server/src/do/GameRoomDO.ts:615`). Plugins must accept `prevState: null`; CtL's view ignores prev entirely and OB's renders the initial round-zero shape.

## Pointers

- `packages/engine/src/types.ts` — `getProgressCounter` (line 188), `buildSpectatorView` (line 254), `SpectatorContext` (line 77), `getSummaryFromSpectator` (line 276), `getReplayChrome` (line 294), `spectatorDelay` (line 247).
- `packages/workers-server/src/do/spectator-delay.ts:9` — `computePublicSnapshotIndex`, the single boundary.
- `packages/workers-server/src/do/GameRoomDO.ts` — snapshot capture at the progress edge (line 1117), `publicSnapshotIndex` accessor (line 1455), `broadcastUpdates` index-advance gate (line 1519), `handleReplay` (line 824), `writeSummaryToD1` (line 1324), frozen `meta.spectatorDelay` (line 609).
- `packages/workers-server/src/plugins/spectator-payload.ts:175` — `buildSpectatorPayload`, the unified HTTP+WS payload assembler.
- `packages/web/src/games/types.ts:82` — `SpectatorPlugin`, `SpectatorViewProps`, `ReplayChrome`.
- `packages/web/src/games/registry.ts` — registered spectator plugins.
- `packages/web/src/pages/ReplayPage.tsx` — generic replay shell; consumes `plugin.animationDuration` (line 50) for auto-play pacing.
- `wiki/architecture/engine-philosophy.md` — why `getProgressCounter` is the only progress signal the framework reads.
- `wiki/architecture/relay-and-cursor.md` — relay scopes, `RelayClient.visibleTo`, what `SpectatorContext.relayMessages` is filtered against.
- `wiki/development/ctl-animations.md` — CtL's animation system (what it does with `prevGameState`, `animate`, and `deathPositions`).
