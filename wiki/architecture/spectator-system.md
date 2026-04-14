# Spectator System

## Three Tiers of Visibility

| Tier | What they see | Fog | Delay |
|---|---|---|---|
| Agent | Their fog-filtered state + relay scoped to them + pipeline output | Yes | No |
| Spectator | Full state + all relay messages | No | Yes (progress-based) |
| Server | Full state + all relay (internal only) | No | No |

## Progress-Based Delay

Spectator delay is measured in **progress units**, not raw actions. The `progressIncrement` flag in `ActionResult` marks meaningful game ticks (turn resolved in CtL, round completed in OATHBREAKER).

The engine tracks a `progressCounter` and takes state snapshots at each increment. Spectators see N progress units behind. This prevents leaking partial-turn information (e.g., which players have submitted moves).

Set `spectatorDelay` on your game plugin (e.g., `spectatorDelay: 2` for CtL).

## SpectatorPlugin (Frontend)

Each game provides a React component registered in `packages/web/src/games/registry.ts`:

```typescript
interface SpectatorPlugin {
  gameType: string;
  displayName: string;
  SpectatorView: React.ComponentType<SpectatorViewProps>;
  GameCard?: React.ComponentType<GameCardProps>;
  animationDuration?: number;  // ms for turn transition animations
}
```

The `SpectatorView` receives raw game state (from `buildSpectatorView()`), chat messages, player handles, kill feed, perspective controls, and **animation props** for replay mode.

## Replay & Animation

Replay data is fetched via `/api/games/:id/replay` (returns all snapshots). `ReplayPage` is a generic shell that delegates rendering to the plugin's `SpectatorView`.

### Animation Contract

`SpectatorViewProps` includes:
- `prevGameState?: any` — previous snapshot for diffing (null on first snapshot)
- `animate?: boolean` — true during auto-play, false during scrubbing/seeking
- `replaySnapshots?: any[]` — all snapshots (replay mode indicator)

`SpectatorPlugin.animationDuration` tells ReplayPage how long to wait before auto-advancing. Interval = `animationDuration + 700ms` read time. Games without animations leave this unset (defaults to instant transitions).

### CtL Animations

`useHexAnimations` hook (`packages/web/src/games/capture-the-lobster/useHexAnimations.ts`) diffs unit positions between prev/current snapshots:

1. **Movement phase**: Units slide from prev to current positions via requestAnimationFrame. Staggered starts (200ms apart), 600ms per unit, ease-out-back easing for bouncy feel.
2. **Combat phase**: After movement, kill effects play — expanding poof circle, spark particles, skull float-up. 600ms per kill, staggered 200ms.

HexGrid accepts `floatingUnits` (units at animated pixel positions), `hiddenUnitIds` (units to skip in normal tile rendering), and `killEffects` for the death animations.

## buildSpectatorView()

Server-side. Your game implements `buildSpectatorView(state, prevState, context)`. Called with the delayed state snapshot. `SpectatorContext` includes display handles and relay messages filtered up to that progress point.

Each game defines its own spectator shape — CtL returns hex grid + kill feed, OATHBREAKER returns round results + matrix.

## WebSocket Feed

`GameRoomDO` broadcasts spectator updates via WebSocket. Spectators connect to `/api/spectator/ws/:gameId`. Updates include the `buildSpectatorView()` output.

See: `packages/engine/src/types.ts` (SpectatorPlugin, SpectatorContext), `packages/web/src/games/`
