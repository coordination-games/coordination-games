# Spectator Colocation

**Status:** Proposed. Not yet built. Sibling spec to `unified-tool-surface.md` (split out because scope is unrelated).

A game's total footprint today spans three folders in two packages:

- `packages/games/capture-the-lobster/` — server logic (`CoordinationGame`, phases, `buildSpectatorView`)
- `packages/web/src/games/capture-the-lobster/` — React spectator component (`SpectatorView.tsx`, hooks)
- `packages/web/public/tiles/` — PNG assets (terrain, unit sprites)

Adding a game requires editing three directories across two packages. That's scatter. This spec proposes a low-lift cleanup.

## Design

### 1. Colocate the React spectator with the game package

Move `packages/web/src/games/capture-the-lobster/` → `packages/games/capture-the-lobster/spectator/`.

- All files are TypeScript/React, no build implications
- Web already depends on the game package for types (e.g. `SpectatorState`)
- Web imports become `import { CaptureTheLobsterSpectator } from '@coordination-games/capture-the-lobster/spectator'`
- Package.json `exports` field gets a `/spectator` subpath

### 2. Declare asset paths on the game plugin

Add to `CoordinationGame`:

```ts
interface CoordinationGame {
  // ...existing fields...
  assets?: {
    baseUrl: string;                    // e.g. '/tiles/ctl/'
    [category: string]: Record<string, string> | string;
    // category example: units: { knight: 'knight.png', rogue: 'rogue.png', mage: 'mage.png' }
    // category example: terrain: { forest: 'green.png', castle: 'castle.png' }
  };
}
```

Spectator components read paths via `plugin.assets.baseUrl + plugin.assets.units.knight`. Path constants live with the plugin — one source of truth for renames.

Asset files stay physically in `packages/web/public/tiles/` for this spec. Physical relocation requires build config to copy assets; higher lift, punt.

### 3. Rename asset directories for consistency

CtL assets live at `packages/web/public/tiles/terrain/` and `packages/web/public/tiles/units/`. OATHBREAKER assets live at `packages/web/public/assets/oathbreaker/`. Different conventions.

Standardize to `packages/web/public/assets/<game>/` for both:
- `packages/web/public/assets/capture-the-lobster/terrain/`
- `packages/web/public/assets/capture-the-lobster/units/`
- `packages/web/public/assets/oathbreaker/` (already conforms)

Requires updating hardcoded URL strings in CtL components; all of those become references to `plugin.assets.baseUrl` after step 2, so the rename is a one-line change in the plugin's `assets.baseUrl` value.

## After

A game has:
- `packages/games/<game>/src/` — server logic + spectator React component
- `packages/web/public/assets/<game>/` — static assets

Two directories, one package each. Spectator plugin's existence in a separate `packages/web/src/games/` folder is eliminated.

## Non-goals

- Moving PNGs into the game package's own directory. Would require the web build to copy them to its public dir; more effort than reward. If/when we reach that point, asset declarations in `plugin.assets` make the final move trivial — it's a baseUrl change.
- Extracting a separate `@coordination-games/<game>-types` package. Current `CoordinationGame` / `SpectatorState` types live with the game; works fine. Only worth splitting if web's bundle size grows problematic.

## Migration

One PR:

1. Move `packages/web/src/games/capture-the-lobster/` files to `packages/games/capture-the-lobster/spectator/`.
2. Add `spectator` export to CtL package.json.
3. Update web imports.
4. Add `assets` field to `CoordinationGame` interface and both game plugins.
5. Rename `packages/web/public/tiles/` to `packages/web/public/assets/capture-the-lobster/` (git mv).
6. Replace hardcoded URLs in spectator components with `plugin.assets.*` references.
7. Visual regression test: load a spectator view, confirm tiles render.

No backwards compat concerns — assets aren't versioned and external consumers don't reference internal URL paths.
