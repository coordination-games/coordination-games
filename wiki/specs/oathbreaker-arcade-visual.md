# OATHBREAKER Arcade Visual Spec

## Status: Designed, Not Built

Current spectator UI is a functional data dashboard (~943 lines). Assets copied to `packages/web/public/assets/oathbreaker/` but unused. This spec captures the target aesthetic.

## Design Philosophy

- **Everything is dollars, not points.** Spectators never see raw balances or supply numbers. All values: `dollarValue = balance × (totalDollarsInvested / totalSupply)`.
- **The $1 break-even line.** Every player enters for $1. Health bars center on this line. Above = winning, below = losing.
- **Yie Ar Kung-Fu (1985) aesthetic.** Pixel art characters, temple/waterfall backgrounds, Press Start 2P font, `image-rendering: pixelated`.

## Key Components (To Build)

### Sprite System
- Pink-key removal (#FF00FF → transparent) via canvas
- 9 characters from `sprites-original.png` (616x608), each with idle/attack/hit/victory poses
- Seeded character assignment (`config.seed + 'characters'`), hue-rotate for overflow (>9 players)

### Battle View
- Two fighters facing off on temple/waterfall background
- Retro HUD: round counter, health bars, coop stats
- Chat/negotiation overlay with speech bubbles and proposal highlights
- "OATH SWORN" / "FATES SEALED" banners

### Round Resolution Animations
- cooperation → golden glow, victory poses, "+$X" float
- betrayal → attack/hit poses, screen shake, red flash, "BREAKS THE OATH"
- standoff → both attack+hit, double shake
- All CSS-only (no animation library)

### Tournament Overview
- Arcade select screen grid (reference: `opponent-select.jpg`)
- Character portraits, dollar health bars, coop records
- Click → drill into battle view

## Implementation Order
1. Sprite system (blocks everything visual)
2. Battle view (the "wow" moment)
3. Animations (makes it feel alive)
4. Tournament overview (arcade select)
5. Polish (CRT scanlines, retro sound via Web Audio API)

## Assets
All at `packages/web/public/assets/oathbreaker/`:
- `sprites-original.png` — 9 characters, pink bg
- `bg-temple.jpg`, `bg-waterfall.jpg` — battle backgrounds
- `opponent-select.jpg` — layout reference
- `title-arcade.jpg`, `title-imagine.jpg` — branding reference
