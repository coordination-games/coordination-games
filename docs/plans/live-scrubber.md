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
show, truncated to `publicSnapshotIndex()` server-side.

When the user toggles "Live" back on, they snap to the latest public
turn and the WS feed continues to drive updates. They never see a
not-yet-public turn.

## 2. What this unblocks

Post-game replay already works (`ReplayPage` + `/api/games/:id/replay`).
The spectator-delay fix shipped in PR #11 narrowed `/replay` to
`[0, publicSnapshotIndex()]` for active games. This PR lets a spectator
rewind while play continues, using the snapshots already arriving over
WebSocket.

## 3. Non-goals

- Rewinding past the public window. Server-side truncation already
  enforces this; frontend should never reveal more than snapshots it
  has legitimately received.
- Fast-forward past the current public index.
- Mid-game scrub for OATHBREAKER. OATH has `spectatorDelay = 0`, so a
  scrubber for it would work but adds no information. Ship CtL first;
  OATH can opt in later via the same generic primitive.
- Rewind auto-play loop. Users step manually for this PR.
- URL state preservation (`?scrub=5`). Nice-to-have, not now.

## 4. Target UX

Active CtL game, spectator view. A new "Rewind" toggle next to the
Team A / B / All perspective buttons. Off by default. The toggle is
hidden (not just disabled) when there are fewer than 2 public snapshots
or when `liveState.phase === 'finished'` — a finished game should go to
`/replay/:id` instead.

- **Off (Live):** current behaviour. WS drives the view; the turn bar
  reads "Turn N/M".
- **On (Rewind):** a `<ScrubberSlider>` appears under the top bar, max =
  the latest accumulated public snapshot index. Scrubbing renders the
  selected snapshot. While in Rewind:
  - Hex grid renders `snapshots[scrubIndex]`.
  - Kill feed, chat, and turn bar all read from the rewound snapshot,
    not from live.
  - The top-bar game-end/FINISHED indicator reads from `liveState`
    (the actual live game state), never from the scrubbed state.
  - WS messages still arrive; `snapshots` grows; slider max increases,
    but `scrubIndex` stays put so the user isn't yanked forward.
  - "↻ Back to live" snaps to the newest index and exits Rewind.
  - Animation is disabled while in Rewind (instant snap per scrub).

## 5. Data flow

```
           ┌──────── WebSocket ────────┐
           │  type: state_update       │
           │  progressCounter: idx     │
           │  ...full snapshot         │
           └──────┬────────────────────┘
                  │ every public-index advance
                  ▼
   ┌──────────────────────────────────────┐
   │ snapshotCache: Map<idx, RawSnapshot> │ accumulated client-side
   │                                      │ seeded once via /replay
   └────────┬──────────────────┬──────────┘
            │                  │
            ▼                  ▼
   Live (mode=live):    Rewind (mode=active):
     mapServerState(       mapServerState(
       latest snapshot       snapshots[scrubIndex]
     )                     )
```

**Key insight:** every `state_update` message already carries the full
public snapshot (`GameRoomDO.buildSpectatorMessage` spreads
`...snapshot` into the message with `progressCounter: idx` —
`packages/workers-server/src/do/GameRoomDO.ts:800-818`). We just need
to keep them instead of discarding after render. No extra fetch on
each advance.

Cold start: if the user connects mid-game or opens Rewind mid-game,
we have only the snapshots that arrived over WS since connection. One
`/replay` call on first rewind-open backfills everything from index 0
to the current public index.

## 6. Implementation

### 6.1 Extract `<ScrubberSlider>` primitive

The existing `ScrubberBar` in `packages/web/src/pages/ReplayPage.tsx`
(lines 206–317) bundles too much: play/pause loop, winner banner,
"Replay" titling. Live-rewind doesn't need play/pause (non-goal) and
must not show the scrubbed snapshot's phase as "finished" (see §6.5).

Extract a minimal primitive instead of adding `liveMode?`,
`onBackToLive?`, `titleSuffix?` props to the existing bar:

```ts
// packages/web/src/components/ScrubberSlider.tsx
interface ScrubberSliderProps {
  currentTurn: number;      // 0..totalTurns-1
  totalTurns: number;       // snapshot count
  onSeek: (turn: number) => void;
  onPrev: () => void;
  onNext: () => void;
}
```

Two container components compose around it:
- `ReplayScrubberBar` (in `ReplayPage.tsx`) — keeps play/pause, winner
  banner, "Replay" title, `gameId`/`gameType` footer. Internally uses
  `<ScrubberSlider>`.
- Live rewind renders `<ScrubberSlider>` inline in `CtlSpectatorView`
  with a sibling "↻ Back to live" button. No container needed.

Net refactor: the slider+prev/next markup is the only thing moving. The
existing ScrubberBar keeps its current props and becomes a thin wrapper
that renders `<ScrubberSlider>` plus its own play/finish/title chrome.

### 6.2 State in `CtlSpectatorView`

Replace the three-useState suggestion with a discriminated union. It
makes illegal states unrepresentable and removes the "clamp prev if
not null" dance:

```ts
type RewindState =
  | { mode: 'live' }
  | { mode: 'loading' }
  | { mode: 'active'; index: number; snapshots: RawSnapshot[] };

const [rewind, setRewind] = useState<RewindState>({ mode: 'live' });
```

Plus a client-side snapshot cache driven by the WS feed:

```ts
// RawSnapshot is the shape of a spectator-visible snapshot. The
// canonical source is `buildCtlSpectatorView` in
// `packages/games/capture-the-lobster/src/plugin.ts` (returns
// `SpectatorState`). That type isn't currently exported to the web
// package — just alias locally to keep the PR small:
type RawSnapshot = Record<string, any>;

const snapshotCacheRef = useRef<Map<number, RawSnapshot>>(new Map());
const [latestProgress, setLatestProgress] = useState<number | null>(null);
```

The cache is a ref (not state) to avoid re-rendering on every WS
message — only `latestProgress` triggers re-renders, and only when
the public index advances.

Also declare a mirror ref for the WS handler (§6.3 needs to read
current mode from inside the stable `ws.onmessage` closure):

```ts
const rewindRef = useRef<RewindState>({ mode: 'live' });
useEffect(() => { rewindRef.current = rewind; }, [rewind]);
```

### 6.3 Accumulate snapshots from WS

Modify the existing `ws.onmessage` handler
(`SpectatorView.tsx:277-300`):

```ts
ws.onmessage = (event) => {
  try {
    const raw = JSON.parse(event.data);
    if (raw?.type === 'spectator_pending') {
      setPendingWindow(true);
      // DO NOT null liveState if we have a rewind session open.
      // See §6.7 — keeping liveState prevents the pending placeholder
      // from tearing down the rewind UI mid-scrub.
      if (rewindRef.current.mode === 'live') setLiveState(null);
      return;
    }
    setPendingWindow(false);
    const mapped = mapServerState(raw);
    if (mapped) {
      setLiveState(mapped);
      // Accumulate raw snapshot keyed by public index.
      if (typeof raw.progressCounter === 'number') {
        snapshotCacheRef.current.set(raw.progressCounter, raw);
        setLatestProgress(raw.progressCounter);
      }
      // allKills bookkeeping unchanged.
      ...
    }
  } catch { ... }
};
```

`rewindRef` is a `useRef` mirror of `rewind.mode` updated by a tiny
effect; we need the current value inside the stable WS callback.

Why cache raw (not mapped) snapshots: `mapServerState` runs once per
*render frame*, not per WS message, and rewind sessions will call it
on arbitrary indices. Caching raw keeps the cache cheap and lets
`mapServerState` evolve without invalidating the cache.

### 6.4 Cold-start backfill via `/replay`

When the user toggles Rewind on, if `snapshotCacheRef` is missing any
indices in `[0, latestProgress]`, fetch `/replay` once to backfill.

```ts
const enterRewind = useCallback(async () => {
  if (latestProgress === null) return;  // nothing to rewind through
  setRewind({ mode: 'loading' });

  const haveAll = Array.from({ length: latestProgress + 1 })
    .every((_, i) => snapshotCacheRef.current.has(i));

  if (!haveAll) {
    try {
      const res = await fetch(
        `${API_BASE}/games/${gameId}/replay`,
        { cache: 'no-store' },
      );
      const data = await res.json();
      if (data.type === 'replay' && Array.isArray(data.snapshots)) {
        data.snapshots.forEach((s: RawSnapshot, i: number) => {
          if (!snapshotCacheRef.current.has(i)) {
            snapshotCacheRef.current.set(i, s);
          }
        });
      } else {
        // spectator_pending — bail, live view still valid.
        setRewind({ mode: 'live' });
        return;
      }
    } catch {
      setRewind({ mode: 'live' });
      return;
    }
  }

  // Snap to latest. User scrubs from there.
  const snapshots = Array.from(
    { length: latestProgress + 1 },
    (_, i) => snapshotCacheRef.current.get(i)!,
  );
  setRewind({ mode: 'active', index: latestProgress, snapshots });
}, [gameId, latestProgress]);
```

`{ cache: 'no-store' }` on the fetch options covers browser cache; the
server-side `Cache-Control` header is a separate defence-in-depth step
(§8.2). No query-param cache-bust needed.

### 6.5 Keep snapshots array in sync with live advances

While `rewind.mode === 'active'`, any new `state_update` adds to the
cache. We want the slider max to grow. A small effect keeps
`rewind.snapshots` aligned:

```ts
useEffect(() => {
  if (rewind.mode !== 'active') return;
  if (latestProgress === null) return;
  if (rewind.snapshots.length - 1 >= latestProgress) return;

  setRewind((r) => {
    if (r.mode !== 'active') return r;
    const snapshots: RawSnapshot[] = [];
    for (let i = 0; i <= latestProgress; i++) {
      const snap = snapshotCacheRef.current.get(i);
      if (!snap) {
        // A gap here means WS dropped an index and enterRewind's
        // backfill hasn't run (or the game-end burst in §7.2 landed).
        // Loud warn > silent filter — gaps would misalign scrubIndex.
        console.warn('[live-scrubber] cache gap at index', i);
        return r;  // abort this sync; let enterRewind handle it.
      }
      snapshots.push(snap);
    }
    // Preserve user's current scrub position; clamp only if impossible.
    const index = Math.min(r.index, snapshots.length - 1);
    return { mode: 'active', index, snapshots };
  });
}, [latestProgress, rewind.mode]);
```

No `/replay` refetch on advance. We already have the data.

### 6.6 Render gate

```ts
const displayRaw = rewind.mode === 'active'
  ? rewind.snapshots[rewind.index]
  : null;

// Memoize the mapping — scrubbing drags fire many renders per second;
// mapServerState rebuilds Maps/Sets and is not free.
const displayState = useMemo(
  () => displayRaw ? mapServerState(displayRaw) : liveState,
  [displayRaw, liveState],
);

// Kill feed MUST come from the displayed state, not allKills.
// allKills accumulates across all WS messages including future turns —
// rendering it during rewind would leak future kills into the feed.
const displayKills = isReplay
  ? (replayState?.kills ?? [])
  : rewind.mode === 'active'
    ? (displayState?.kills ?? [])
    : allKills;

// Animation disabled whenever we're showing a rewound frame.
const effectiveAnimate = rewind.mode === 'active' ? false : (animate ?? false);
```

The existing `useHexAnimations` call reads `displayState.tiles` and
`displayKills`. With the substitutions above it just works.

### 6.7 Finish indicator reads from live, not display

There are two JSX sites that render game-end chrome, both keyed off
`gameState.phase === 'finished'`:

1. **Top-bar badge** — `SpectatorView.tsx:412-417`:
   `{gameState.phase === 'finished' && <span>FINISHED — Team {gameState.winner} wins</span>}`
2. **Full-screen overlay** — `SpectatorView.tsx:452-...`:
   `{gameState.phase === 'finished' && <div>TEAM {gameState.winner} WINS!</div>}`

In rewind, `gameState` is the scrubbed snapshot, so scrubbing to the
final frame would flash FINISHED spuriously, and scrubbing back would
hide it even after the game actually ended.

Fix: both sites switch from `gameState.phase` / `gameState.winner` to
`liveState.phase` / `liveState.winner`:

```ts
const gameIsFinished = liveState?.phase === 'finished';
const winner = liveState?.winner ?? null;

// Site 1 (top bar):
{gameIsFinished && (
  <span ...>FINISHED{winner && ` — Team ${winner} wins`}</span>
)}

// Site 2 (overlay):
{gameIsFinished && (
  <div ...>TEAM {winner} WINS!</div>
)}
```

When `gameIsFinished` becomes true mid-rewind, we also auto-exit
rewind (§6.9) — the `/replay` page is the right surface for a finished
game. React 18 batches the auto-exit `setRewind` and the visibility
re-render in the same commit, so no single-frame flash of "button
visible while overlay also showing".

### 6.8 `spectator_pending` during rewind

The current `ws.onmessage` handler sets `setLiveState(null)` on
`spectator_pending` (SpectatorView.tsx:280-284). Combined with the
`!gameState` early return that renders `SpectatorPendingPlaceholder`,
this nukes the entire rewind UI.

Fix in §6.3: don't null `liveState` while `rewind.mode !== 'live'`.
The pending placeholder gate also needs to be aware of rewind:

```ts
// Before:
if (!gameState) return <SpectatorPendingPlaceholder ... />;

// After:
if (!gameState && rewind.mode !== 'active') {
  return <SpectatorPendingPlaceholder ... />;
}
```

In rewind mode, we render `displayState` from the snapshot cache even
if `liveState` is momentarily null.

### 6.9 Auto-exit on game end

One effect:

```ts
useEffect(() => {
  if (liveState?.phase === 'finished' && rewind.mode !== 'live') {
    setRewind({ mode: 'live' });
  }
}, [liveState?.phase, rewind.mode]);
```

Combined with the §4 visibility rule (button hidden when finished),
this prevents the user from being stuck in a weird post-game rewind.

### 6.10 Perspective × rewind

`mapServerState` does not bake in perspective; fog-of-war is derived
downstream from `selectedTeam` + `gameState.visibleA/B`. Scrubbing and
flipping Team A/B/All compose correctly without extra work. Worth
noting — no code change needed.

### 6.11 Controls

**Rewind button placement:** inside the right-side button cluster at
`SpectatorView.tsx:419-445` (same `flex items-center gap-1` container
as the Team A/B/All buttons), rendered *after* the last team button.
Same visual weight as the Team buttons.

Hide the button when:
- `latestProgress === null` (no public snapshots yet), OR
- `latestProgress < 1` (only one public snapshot — nothing to rewind
  through), OR
- `liveState?.phase === 'finished'` (use `/replay/:id` instead).

When `rewind.mode === 'loading'`: render the button as disabled with a
spinner glyph.

**Slider placement:** when `rewind.mode === 'active'`, render
`<ScrubberSlider>` as a new row **below** the top bar (between the
top-bar div closing at line 446 and the `Main content area` div at
line 448), with a sibling "↻ Back to live" button. Props:
- `currentTurn={rewind.index}`
- `totalTurns={rewind.snapshots.length}` (slider renders
  `0..totalTurns-1`)
- `onSeek={(i) => setRewind(r => r.mode === 'active' ? { ...r, index: i } : r)}`
- `onPrev` / `onNext` analogous.

The turn-bar text (currently line 406-408) reads:
- Live: `Turn ${liveState.turn}/${liveState.maxTurns}` (unchanged).
- Rewind: `Turn ${displayState.turn}/${displayState.maxTurns} · Rewind`.

## 7. Risks and edges

### 7.1 Reconnection during rewind

If the WS drops and reconnects while `rewind.mode === 'active'`:
- The reconnect effect keys only on `gameId`/`isReplay`, so
  `snapshotCacheRef` is preserved across reconnects within the same
  mount.
- The server re-sends the current snapshot on reconnect; cache gets a
  repeat write, no harm.
- If the reconnect delivers a higher `progressCounter`, §6.5's effect
  grows the slider max.

If the reconnect fails and the user is stuck in rewind with stale
data: acceptable. They can hit "↻ Back to live" and see the usual
disconnected banner.

### 7.2 Game end expands public window atomically

On game end, `publicSnapshotIndex()` jumps from `N - delay - 1` to
`N - 1` in one tick (§architecture/spectator-system.md). Several
snapshots become public at once. The server broadcasts only the
*latest* index's snapshot in that burst (see `buildSpectatorMessage`),
so the cache gets a gap: indices `N-delay..N-2` are never pushed over
WS. Our `enterRewind` backfill via `/replay` handles this case for
users who toggle in post-finish, but since we auto-exit on
`phase === 'finished'` (§6.9), this only matters briefly.

If we want to preserve a rewind session through the finish tick, the
§6.5 effect must trigger a backfill when it detects `latestProgress`
jumped by more than 1. Out of scope — we auto-exit instead.

### 7.3 Debounce / race

There is no debounce in this design. The WS cache accumulates
automatically; only `enterRewind` does HTTP. Races on `enterRewind`:
- User clicks Rewind, fetch starts, user clicks again before it
  resolves. `rewind.mode === 'loading'` gates the second click in the
  UI. Belt-and-suspenders: the async `enterRewind` bails if
  `rewindRef.current.mode !== 'loading'` when it resumes after `await`.
- User clicks Rewind, fetch pending, unmounts. The stale-closure write
  to `setRewind` fires on an unmounted component — React logs a
  warning but state is GC'd. Can guard with an `AbortController` if
  we care to silence the warning.

### 7.4 Snapshot immutability

`_spectatorSnapshots` is append-only server-side
(GameRoomDO writes `buildSpectatorView(snapshot)` exactly once per
index and never mutates — spectator-delay-security-fix.md enforces
this). So cached raw snapshots are stable. No "snapshot at index K
changed after we cached it" problem.

### 7.5 Cache growth

Per-snapshot size: a CtL snapshot with radius-8 hex grid plus chat and
kills is ~20–40 KB serialized. A typical CtL match runs 20–40 public
turns. Worst case cache footprint: ~1.6 MB. Acceptable. Not worth
implementing eviction.

### 7.6 Observability

Add one `console.debug` line in the WS handler when `progressCounter`
increments, and one when `enterRewind` does a backfill. Helps future
debugging without polluting logs.

## 8. Rollout

Single PR. Change inventory:

**`packages/web/src/components/ScrubberSlider.tsx`** (new):
- Minimal primitive: slider + prev/next buttons + current-turn display.

**`packages/web/src/pages/ReplayPage.tsx`**:
- Keep the existing `ScrubberBar`; refactor its slider+prev/next
  internals to delegate to `<ScrubberSlider>`. No behaviour change.

**`packages/web/src/games/capture-the-lobster/SpectatorView.tsx`**:
- Add `snapshotCacheRef`, `latestProgress`, `rewind` state.
- `ws.onmessage` accumulates `raw` into cache; guards
  `setLiveState(null)` on `spectator_pending`.
- `enterRewind` + `backToLive` handlers.
- `§6.5` effect keeps `rewind.snapshots` aligned with cache growth.
- `§6.9` effect auto-exits on game finish.
- `displayState`, `displayKills`, `effectiveAnimate` derivations.
- Top-bar Rewind button + `<ScrubberSlider>` render.
- Finish chrome (winner banner, FINISHED label) reads from
  `liveState`, not `gameState`.
- Pending-placeholder gate passes through when `rewind.mode === 'active'`.

**`packages/workers-server/src/do/GameRoomDO.ts`** (optional, defence-in-depth):
- Add `Cache-Control: no-store` to the `/replay` response headers. The
  `{ cache: 'no-store' }` fetch option makes this redundant for our
  caller, but it's one line and good hygiene.

### Sequence in the PR

1. Extract `<ScrubberSlider>`, wire ReplayPage through it (no-op refactor).
2. Add `snapshotCacheRef` + WS accumulation (no UI change yet; verify
   via `console.debug` that the cache grows as snapshots arrive).
3. Add `rewind` state + `enterRewind` + render gate (displays but
   doesn't yet grow).
4. Add §6.5 alignment effect + §6.9 auto-exit + §6.7 finish-chrome fix.
5. Wire top-bar button + ScrubberSlider + Back-to-live.
6. Manual QA against `wrangler dev`.

### Deploy verification

- Open an active CtL game as spectator. Confirm cache grows over the
  WS feed (debug log).
- Click Rewind. Slider appears, snaps to latest public turn.
- Drag slider back. Hex grid, kill feed, chat, turn counter all match
  that turn. Confirm NO future kills leak into the feed (§6.6).
- Wait for a live turn to resolve. Slider max increments; current
  scrub position stays put.
- Click "↻ Back to live". Slider disappears; view resumes with latest
  turn.
- Flip Team A/B/All while rewound — fog updates without re-fetching.
- Let the game finish. Confirm we auto-exit rewind and the FINISHED
  banner appears.
- Kill the WS tab (devtools) and reopen. Cache should have zero
  duplicate-write issues; slider still works if offline.

## 9. Out of scope / follow-ups

- **Rewind auto-play.** Reuse `ReplayScrubberBar`'s play/pause loop
  when a user asks for it.
- **Scrubber for OATHBREAKER.** The `<ScrubberSlider>` primitive is
  already generic; opt in when a delay-bearing OATH variant lands.
- **Persistent URL state.** `?scrub=5` to share a specific turn.
- **Mobile gesture scrubbing.** The range input works but a proper
  gesture would be nicer.
- **Snapshot cache eviction.** Not needed at expected game lengths.
- **Server-side `Cache-Control: no-store` on `/replay`.** The
  client-side `cache: 'no-store'` covers our caller; the server change
  is defence-in-depth, not blocking.
