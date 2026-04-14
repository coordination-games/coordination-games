# Hex Grid Rendering

## Coordinate System

Flat-top hexagons with axial coordinates. Six directions: N/NE/SE/S/SW/NW (no E/W — flat-top means the east/west edges are flat, not pointy).

## Combat Rules

- Adjacent melee (distance 1), mage ranged (distance 2 + line of sight)
- Same-hex same-class = both die
- No friendly stacking — teammates block each other
- Combat resolves at final positions only — rogues can dash through danger zones

## Visual Assets

Hex tile art from **Battle for Wesnoth** (GPL licensed):
- Terrain: `packages/web/public/tiles/terrain/` — grass, forest, castle, keep, dirt
- Units: `packages/web/public/tiles/units/` — rogue, knight, mage sprites
- Team B: CSS `hue-rotate(160deg)` filter shifts blue sprites to red

## Rendering Details

`HexGrid.tsx` renders SVG with:
- Wesnoth tile backgrounds per terrain type
- Forest = grass base + forest overlay (trees need terrain underneath — don't render forest without grass first)
- Vision boundary edges per team (blue/red) from server-computed fog
- Unit sprites with team-colored backing circles and labels (R1/K2/M1)
- Border ring of forest tiles around map edge (generated in `map.ts`, purely visual)

## Map Scaling

Team size determines map radius: 2→5, 3→6, 4→7, 5→8, 6→9. Teams of 5+ get 2 flags each. Turn limit scales with radius: `20 + radius*2`.
