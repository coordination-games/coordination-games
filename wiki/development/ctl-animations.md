# CtL Animations
> Capture the Lobster's spectator view animates the diff between two consecutive turn snapshots; the platform only ships a generic `(prev, current, animate)` contract, so this doc explains what CtL builds on top of it.

## Why

This doc builds on the spectator delay system (see `wiki/architecture/spectator-system.md`) — `buildSpectatorView` produces self-contained snapshots at every progress tick and the shell hands the per-game `SpectatorView` consecutive snapshots to render. The platform stops there. It tells the view nothing about *how* to animate the transition; that's per-game by design, because OATHBREAKER's round-resolution chrome and CtL's hex movement have nothing in common.

CtL needs animations because the spectator-delay design specifically denies you the per-action stream: the only thing a spectator ever sees is the post-resolution snapshot at the end of every turn. A raw cut from turn N to turn N+1 hides the entire interesting story — who moved where, who killed whom, who got a flag. The animation timeline reconstructs that story locally on the client, from data already present in the two snapshots, without any new server round-trip and without re-running any game logic. Every position, kill, and respawn is derivable from the snapshots; the animation is purely a visualisation of the diff.

The single load-bearing extension to the spectator-snapshot shape is `deathPositions` (`packages/games/capture-the-lobster/src/plugin.ts:172`), which captures *post-move, pre-respawn* coordinates for units killed this turn. Without it the animation has only `prev.position` (where they started) and `current.position` (where they respawn) — and a unit that walks into a knight's reach to die there should not appear to teleport from its starting hex straight to spawn. The death position bridges those two, and it has to come from the server because by the time the client gets snapshot N+1 the unit has already been moved to its respawn hex.

## How

**Where it lives.** `useHexAnimations` (`packages/web/src/games/capture-the-lobster/useHexAnimations.ts:151`) is a React hook that takes `(prevTiles, currentTiles, animate, kills, deathPositions?)` and returns an `AnimationState` consumed by `HexGrid` (`packages/games/capture-the-lobster/web/HexGrid.tsx`). The hook owns a `requestAnimationFrame` loop, animation refs, and a per-turn `animKey` for de-dup. `CtlSpectatorView` (`packages/web/src/games/capture-the-lobster/SpectatorView.tsx:493`) wires it up: in live mode `prevLiveState` advances only when `mapped.turn > prev.turn` (`:362-364`) so same-turn updates (chat envelopes, ETag pulses) never re-trigger a movement animation from a stale anchor.

**The shipped declaration.** `CaptureTheLobsterSpectator.animationDuration = 5000` (`packages/web/src/games/capture-the-lobster/index.ts:36`). `ReplayPage` reads this and waits `animationDuration + 700ms` (read-time padding) between auto-advance ticks (`packages/web/src/pages/ReplayPage.tsx:50-51`). For comparison: OATHBREAKER ships `animationDuration: 3700` (`packages/web/src/games/oathbreaker/index.ts:45`); games without animations leave it unset and `ReplayPage` falls back to `0 + 700ms`.

**The five-phase timeline.** All durations are constants at the top of `useHexAnimations.ts` (`:132-140`):

| Phase | Duration | What runs | Constants |
|---|---|---|---|
| 1. Vision fade-out | 300ms + 150ms pause | Per-team vision boundary paths fade to opacity 0 | `VISION_FADE_OUT`, `VISION_PAUSE` |
| 2. Movement | 600ms / unit, 400ms stagger | All units (incl. dying) slide from prev to target hex | `MOVE_DURATION`, `MOVE_STAGGER` |
| 3. Combat | 700ms / kill, 250ms stagger, after a 300ms beat | Kill effects render at the death position | `KILL_DURATION`, `KILL_STAGGER`, `COMBAT_DELAY` |
| 4. Float-to-respawn | 500ms | Ghost skull floats from death position to respawn hex | `FLOAT_DURATION` |
| 5. Vision fade-in | 300ms | Vision boundaries restore with the new turn's visibility | `VISION_FADE_IN` |

End-to-end deterministic timeline math is at `useHexAnimations.ts:282-295`. Easings are `easeOutBack` for movement (small overshoot — units arrive with weight, `:118-122`) and `easeOutCubic` for the float-to-respawn (`:124-126`).

**Where the data comes from.** `useHexAnimations` reads two structures:

- **Unit positions** — extracted from `tile.unit` on each `VisibleTile` via `extractUnits` (`useHexAnimations.ts:70-86`). The diff between `prevUnits.get(id)` and `currUnits.get(id)` produces a `MovingUnit` if the hex changed.
- **Death positions** — passed in as `deathPositions: Record<string, { q, r }>` (`useHexAnimations.ts:157`), sourced from `gameState.deathPositions` on the spectator snapshot. The CtL plugin injects them into `buildSpectatorView` output: `state.lastDeathPositions ?? undefined` (`packages/games/capture-the-lobster/src/plugin.ts:346`). Upstream, `resolveTurn` populates `lastDeathPositions` *after* the move phase but *before* the respawn teleport (`packages/games/capture-the-lobster/src/game.ts:430-434`), so the field captures the post-move killing-blow hex even though the unit's `position` field by snapshot time is the respawn hex.

A dying unit therefore has three coordinates active in one animation: `prev.position` (turn-start), `deathPositions[id]` (where the kill animation plays), and `current.position` (respawn). The hook routes them as: movement phase animates `prev → death`, combat plays at `death`, and float-to-respawn animates `death → current`.

**HexGrid animation props.** `useHexAnimations` returns five fields the `HexGrid` component reads (`packages/games/capture-the-lobster/web/HexGrid.tsx:61-69`):

- `floatingUnits: FloatingUnit[]` — units currently mid-tween, rendered as absolute-positioned SVG groups instead of as tile children.
- `hiddenUnitIds: Set<string>` — IDs to skip in the tile-based render path so a moving unit doesn't appear in *both* its old and new hex.
- `killEffects: KillEffect[]` — poof/sparks/skull at `(deathX, deathY)` plus float-to-respawn progress.
- `visionOpacity: number` — `0..1`, applied as the vision-boundary path's opacity.
- `dyingUnitIds: Set<string>` — units currently in the combat phase; HexGrid uses this to suppress their tile sprite while the kill effect renders.

These fields are CtL-specific. Other games building their own animation hook would return entirely different shapes; the platform-level `SpectatorViewProps` are just `prevGameState`, `animate`, `replaySnapshots`.

**Same hook drives live + replay.** In replay mode `ReplayPage` passes `animate={true}` during auto-play and `animate={false}` while the user scrubs (`packages/web/src/pages/ReplayPage.tsx:62-93`). In live mode `CtlSpectatorView` defaults `animate` to true on every turn flip and to false in rewind (`SpectatorView.tsx:490`). The hook's internal `animKeyRef` (`useHexAnimations.ts:166`) de-dups: a re-render with the same `(prev, current, positions)` triple skips the timeline.

## Edge cases & gotchas

- **`deathPositions` is the load-bearing field.** Without it, the animation has no idea where the kill happened and would draw movement straight from `prev.position` to the respawn hex. The fallback in `useHexAnimations.ts:258` (`deathPositions?.[id] ?? prevVictim`) keeps the animation correct-ish if the field is missing — the unit appears to die at its starting hex — but loses the "moved into reach, then died" story. Don't trim the field thinking it's optional.
- **Same-turn relay updates must not advance `prevLiveState`.** `CtlSpectatorView` only sets `prevLiveState` when `mapped.turn > prev.turn` (`:362-364`). A chat envelope arriving mid-turn re-renders the same snapshot via `liveSnapshot`, which would otherwise re-trigger a noop movement animation from the now-current state to itself. The `animKey` de-dup catches it but the explicit guard is what actually prevents the wrong-baseline class of bug.
- **Animation duration is a contract, not a hint.** `ReplayPage` waits `animationDuration + 700ms` per turn in auto-play. Bumping a constant in `useHexAnimations.ts` without updating `CaptureTheLobsterSpectator.animationDuration` cuts off the tail of the animation; bumping `animationDuration` without the timeline change adds dead air. Keep them in sync.
- **`extractUnits` reads from `tile.unit`, not `state.units`.** The spectator snapshot's `units` array is a parallel listing, but the hook walks tiles because that's how `HexGrid` already maps unit IDs to pixel positions (`useHexAnimations.ts:70-86`). If a future snapshot shape ever decouples `tile.unit` from `state.units`, the hook reads tiles.
- **TypeScript `@ts-expect-error TS18048` markers in the kill effect loop** (`useHexAnimations.ts:382-397`) are explicit `TODO(2.3-followup)` markers — array indexing in strict mode. Not a behaviour bug; safe under our own iteration but the compiler can't prove it. Don't delete the markers without re-typing the loop.
- **Non-CtL games have their own implementation.** OATHBREAKER's `OathbreakerSpectator` registers an entirely separate `SpectatorView`, ignores `prevGameState` for unit-movement-style animation (it has none), and uses `animationDuration: 3700` for a different kind of round-result reveal. None of the constants in `useHexAnimations.ts` apply to it.
- **The hook owns its own RAF loop.** `useHexAnimations` calls `cancelAnimationFrame` in its cleanup effect (`:168-173`) and on every animation key change. A view that swaps the hook out mid-animation (e.g. switching games) cleans up correctly; one that calls it in two places at once doesn't, and you'd see double-advancing animations.

## Pointers

- `packages/web/src/games/capture-the-lobster/useHexAnimations.ts` — hook entry (line 151), constants (lines 132-140), timeline math (line 282), easings (lines 118, 124).
- `packages/web/src/games/capture-the-lobster/SpectatorView.tsx:493` — wiring of `useHexAnimations` into the spectator view; `prevLiveState` advance guard at line 362.
- `packages/web/src/games/capture-the-lobster/index.ts:36` — `animationDuration: 5000` registered on the plugin.
- `packages/games/capture-the-lobster/web/HexGrid.tsx:61` — animation props consumed by HexGrid.
- `packages/games/capture-the-lobster/src/plugin.ts:346` — `deathPositions` injected into the spectator snapshot.
- `packages/games/capture-the-lobster/src/game.ts:430` — `deathPositions` populated post-move, pre-respawn during turn resolution.
- `packages/web/src/pages/ReplayPage.tsx:50` — `animationDuration + 700ms` auto-play interval; how the platform shell consumes the constant.
- `wiki/architecture/spectator-system.md` — why snapshots, why delay, why animations exist at all.
- `wiki/development/hex-grid-rendering.md` — flat-top axial coords, Wesnoth tile assets, fog rendering.
