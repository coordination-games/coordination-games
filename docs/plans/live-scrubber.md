# Live Scrubber — rewind UI for active games

**Status:** Draft plan, ready for implementation.
**Owner:** Borg (Capture the Lobster thread).
**Date:** 2026-04-17.
**Prereqs:** `docs/plans/spectator-delay-security-fix.md` (merged as PR #11).

---

## 1. Goal

Let a spectator watching a live Capture the Lobster game rewind through
past turns without disconnecting from the live feed. Scrubbing is bounded
to the public (delayed) window — the same data a finished replay would
show, truncated to `publicSnapshotIndex()`.

When the user toggles "Live" back on, they snap to the latest delayed
turn and the WS feed continues to drive updates. They never see a
not-yet-public turn.

## 2. What this unblocks

Post-game replay already works (`ReplayPage` + `/api/games/:id/replay`).
The spectator-delay fix shipped in PR #11 narrowed `/replay` to
`[0, publicSnapshotIndex()]` for active games. This PR uses that same
endpoint mid-game so a spectator can rewind while play continues.

## 3. Non-goals

- Rewinding past the public window. Server-side truncation already
  enforces this; frontend should never reveal more than the snapshots
  the server returned.
- Fast-forward past the current public index. You can scrub to the
  latest returned index and no further.
- Mid-game scrub for OATHBREAKER. OATH has `spectatorDelay = 0`, so a
  scrubber for it would work mechanically but adds no information over
  the live view. Ship CtL first; OATH can opt in later via the same
  generic component.

## 4. Target UX

Active CtL game, spectator view. A new "Rewind" toggle next to the
Team A / B / All perspective buttons (top bar). Off by default.

- **Off (Live)**: current behaviour. WS drives the view; the turn bar
  reads "Turn N/M" where N is the public turn.
- **On (Rewind)**: a slider appears under the top bar, max = the
  current public index. Scrubbing updates the hex grid to the selected
  snapshot. While in Rewind mode:
  - Hex grid renders `snapshots[scrubIndex]`.
  - The turn bar reads "Turn X/M (Rewind)" with X = `snapshots[scrubIndex].turn`.
  - WS messages still arrive in the background; `snapshots` grows;
    the slider max increases, but `scrubIndex` stays put so the user
    doesn't get yanked forward.
  - A "↻ Back to live" button snaps `scrubIndex` to the newest index
    and toggles Rewind off.
  - Animation is disabled during Rewind (like scrubbing in ReplayPage).

## 5. Data flow

```
                ┌──────── WebSocket ────────┐
                │  type: state_update       │
                │  progressCounter: N       │
                └──────┬────────────────────┘
                       │ advances
                       ▼
          ┌────────────────────────┐
          │ snapshots: SnapshotArr │ ← fetched from /replay on rewindMode toggle
          │ length: N+1            │   + refetched each time WS advances idx
          └────────┬───────────────┘
                   │
   ┌───────────────┴─────────────────┐
   │                                 │
   ▼                                 ▼
Live feed (rewindMode=off):     Rewind (rewindMode=on):
  snapshots[length-1]              snapshots[scrubIndex]
```

**Key insight:** the WS `state_update` already carries the public
snapshot's `progressCounter` (which the fix set to the public index).
Whenever that value increases, we know a new entry has landed in
`_spectatorSnapshots` on the server. We re-fetch `/replay` lazily.

## 6. Implementation

### 6.1 Extract `<ScrubberBar>`

Pull the slider + play/pause/step buttons out of
`packages/web/src/pages/ReplayPage.tsx` (`ScrubberBar` sub-component)
into `packages/web/src/components/ScrubberBar.tsx`. Same props:

```ts
interface ScrubberBarProps {
  currentTurn: number;      // 0..totalTurns-1
  totalTurns: number;
  isPlaying: boolean;
  isFinished: boolean;
  winner: string | null;
  gameId: string;
  gameType: string;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlay: () => void;
  onSeek: (turn: number) => void;
  /** New: show "↻ Back to live" when true. */
  liveMode?: boolean;
  onBackToLive?: () => void;
  /** New: optional title override (replay says "Replay", live says "Live"). */
  titleSuffix?: string;
}
```

ReplayPage imports it unchanged; add the `liveMode` + `onBackToLive`
props without changing existing behaviour.

### 6.2 State in `CtlSpectatorView`

Add three fields. All gated behind `isReplay === false` (replay page
already has its own scrubber, ignore).

```ts
const [rewindMode, setRewindMode] = useState(false);
const [scrubIndex, setScrubIndex] = useState<number | null>(null);
const [rewindSnapshots, setRewindSnapshots] = useState<any[] | null>(null);
```

`rewindSnapshots` is the truncated snapshot array from `/replay`.
`scrubIndex` is null when in Live mode.

### 6.3 Fetch cadence

One `useEffect` keyed on `rewindMode` and `liveState?.progressCounter`.
Debounce a `/replay` fetch with a 100ms trailing edge so a burst of WS
updates collapses to one request:

```ts
useEffect(() => {
  if (!rewindMode || isReplay || !gameId) return;

  let cancelled = false;
  const t = setTimeout(() => {
    fetch(`${API_BASE}/games/${gameId}/replay`)
      .then(r => r.json())
      .then((data: ReplayData) => {
        if (cancelled) return;
        if (data.type === 'spectator_pending') return;  // shouldn't hit
        setRewindSnapshots(data.snapshots);
        // Clamp scrubIndex to the new max; null means "start at latest"
        setScrubIndex(prev => {
          if (prev === null) return data.snapshots.length - 1;
          return Math.min(prev, data.snapshots.length - 1);
        });
      })
      .catch(() => {});
  }, 100);

  return () => { cancelled = true; clearTimeout(t); };
}, [rewindMode, isReplay, gameId, liveState?.turn]);
```

Keying the effect on `liveState?.turn` means it re-runs whenever the
public turn advances. No polling.

### 6.4 Render gate

Derive the state to render:

```ts
const displayState = rewindMode && rewindSnapshots && scrubIndex !== null
  ? mapServerState(rewindSnapshots[scrubIndex])
  : liveState;

const displayPrev = rewindMode && rewindSnapshots && scrubIndex !== null && scrubIndex > 0
  ? mapServerState(rewindSnapshots[scrubIndex - 1])
  : null;
```

Feed `displayState` into the existing hex grid pipeline. Pass
`displayPrev` into `useHexAnimations` only when `rewindMode` is false
(otherwise turn-to-turn animation is disabled; scrubbing is an
instant snap).

### 6.5 Controls

Replace the existing top-bar "Turn N/M" span with:

- In Live mode: "Turn N/M" (unchanged) + a "Rewind" button.
- In Rewind mode: a `<ScrubberBar>` with max = `rewindSnapshots.length - 1`
  and the "↻ Back to live" button via the new props above.

Rewind toggle:

```ts
const enterRewind = () => {
  setRewindMode(true);
  setScrubIndex(null);  // populated by the fetch effect
};

const backToLive = () => {
  setRewindMode(false);
  setScrubIndex(null);
  setRewindSnapshots(null);
};
```

### 6.6 Animation discipline

Borrow from ReplayPage:
- Scrubbing → `animate = false`.
- Rewind auto-play is out of scope for this PR (adds complexity, not
  much value — users can step manually). If we want it later, it slots
  in the same way ReplayPage's play loop does.

### 6.7 OATHBREAKER

OATH's `SpectatorView` also receives `replaySnapshots` for replay mode
but has no delay. Don't add the Rewind toggle to OATH's view — it
provides no information. Keep the component as-is.

## 7. Risks and edges

### 7.1 The `/replay` endpoint is cacheable

The server returns snapshots up to `publicSnapshotIndex()`. If the
browser or a CDN caches the response, a subsequent fetch after the
public index advances still returns stale data. Mitigation: append a
cache-busting query param `?t=${liveState?.turn}` on each fetch, or
ensure the server sends `Cache-Control: no-store` on `/replay`. The
simpler play is a query-param bust since the server code is already
merged.

### 7.2 First-fetch race

`rewindMode` toggles on, fetch fires, user scrubs before it returns.
Fine — `scrubIndex` is null until the fetch resolves, and the render
gate falls back to `liveState`. First fetch lands in <100ms on
localhost; worst case a slow user sees one blip of live view.

### 7.3 Replay page + live scrubber code sharing

`ReplayPage` and `CtlSpectatorView` will both render `<ScrubberBar>`,
both call `mapServerState` on snapshots, and both manage a
`currentTurn`/`scrubIndex` pair. Consider extracting a
`useSnapshotNavigation(snapshots, totalTurns)` hook if a third consumer
shows up. Don't do it pre-emptively.

### 7.4 WebSocket still drives `liveState` during Rewind

Intentional. If we paused WS-driven updates, returning to Live would
have to catch up from the last rewind fetch, adding complexity. Keep
the WS running; `liveState` stays current; Rewind just overlays a
different snapshot on top.

### 7.5 Spectator_pending while rewinding

Shouldn't happen — `rewindMode` is only enable-able when there's a
live state, which implies at least one snapshot. If the backend ever
sends `spectator_pending` mid-rewind (e.g. a DO reload scenario), the
render gate degrades gracefully: `rewindSnapshots` stays non-null,
`scrubIndex` stays valid.

### 7.6 Finished games

When the game ends, `liveState.phase === 'finished'`, `isFinished`
becomes true. Rewind still works; max = `snapshots.length - 1`
(the final snapshot). At that point the existing `/replay` page
is probably a better UX — consider hiding the Rewind toggle on
finished games and pointing the user to the replay URL instead.

## 8. Rollout

Single PR. Change inventory:

**`packages/web/src/`**:
- New `components/ScrubberBar.tsx` — extracted from ReplayPage.
- `pages/ReplayPage.tsx` — import the shared ScrubberBar instead of the
  inline one. No behaviour change.
- `games/capture-the-lobster/SpectatorView.tsx`:
  - New state: `rewindMode`, `scrubIndex`, `rewindSnapshots`.
  - New `/replay` fetch effect (§6.3).
  - Rewind toggle in the top bar; ScrubberBar when `rewindMode` is on.
  - Render gate for `displayState` / `displayPrev` (§6.4).

**`packages/workers-server/src/do/GameRoomDO.ts`** (optional):
- Add `Cache-Control: no-store` to the `/replay` response headers if
  we want defence-in-depth beyond the query-param bust.

### Sequence in the PR

1. Extract ScrubberBar, wire ReplayPage to it (no-op refactor — ship
   or bundle with step 2).
2. Add rewindMode state + fetch effect + render gate to CtlSpectatorView.
3. Wire controls (top-bar button + ScrubberBar + Back-to-live).
4. Manual QA against `wrangler dev`: toggle on, scrub, toggle off,
   verify WS keeps updating in the background, verify slider max
   grows with live turns.

### Deploy verification

- Open an active CtL game in the browser.
- Click Rewind. Slider appears, snaps to latest public turn.
- Drag slider back. Hex grid renders past turn. Kills and chat match
  that turn.
- Wait for a live turn to resolve. Slider max increments; current
  position stays put.
- Click "↻ Back to live". Slider disappears; view resumes with latest
  turn.

## 9. Out of scope / follow-ups

- **Rewind auto-play.** Reuse ReplayPage's play/pause loop when a user
  asks for it.
- **Scrubber for OATHBREAKER.** Generic component is ready; opt in when
  a delay-bearing OATH variant lands.
- **Persistent URL state.** `?scrub=5` to share a specific turn. Nice
  to have; out of scope.
- **Mobile gesture scrubbing.** The range input works but a proper
  gesture (drag with momentum) would be nicer.
- **Server-side cache headers on `/replay`.** Track separately; the
  query-param bust is sufficient for launch.
