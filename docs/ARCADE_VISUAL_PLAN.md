# OATHBREAKER — Arcade Visual Overhaul Plan

## Current State

The CtL thread built a functional spectator UI at
`packages/web/src/games/oathbreaker/SpectatorView.tsx` (~943 lines). It works:
- Player cards with dollar health bars centered on break-even
- Battle drill-down with pledge negotiation, chat, phase indicators
- Round results panel with C/D reveals and outcome labels
- WebSocket integration, real-time updates

**What's missing:** All the arcade fighter aesthetic we designed. The assets are
copied to `packages/web/public/assets/oathbreaker/` but completely unused.
No sprites, no backgrounds, no arcade fonts, no animations. It's a clean
data dashboard, not an arcade game.

---

## The Vision

**OATHBREAKER** (誓約破り / *Seiyaku-yaburi*)

Yie Ar Kung-Fu (1985) arcade aesthetic. Two pixel-art fighters face off on
temple/waterfall backgrounds. Chat bubbles float between them as they
negotiate oaths. The round ends with attack animations for betrayal, golden
bows for cooperation. Health bars track dollar value centered on the $1
break-even line.

---

## Phase 1: Sprite System

**Foundation — everything visual depends on this.**

### 1.1 Pink-key removal utility

Canvas-based function that loads `sprites-original.png`, walks pixels,
replaces #FF00FF (and near-matches for antialiasing) with transparent,
caches as a data URL. Run once on component mount.

```typescript
// utils/spriteLoader.ts
async function loadSpriteSheet(url: string): Promise<HTMLCanvasElement>
```

### 1.2 Sprite coordinate map

Define bounding boxes for each character + pose. The sprite sheet is
616x608 with characters in rows. Need to measure exact coordinates:

```typescript
// data/spriteMap.ts
interface SpriteFrame {
  x: number; y: number; w: number; h: number;
}

interface CharacterSprites {
  name: string;
  idle: SpriteFrame;
  attack: SpriteFrame;
  hit: SpriteFrame;
  victory: SpriteFrame;  // or idle mirrored + golden tint
}

const CHARACTERS: CharacterSprites[] = [
  { name: 'Buchu', idle: {...}, attack: {...}, ... },
  { name: 'Star', ... },
  { name: 'Oolong', ... },
  { name: 'Nuncha', ... },
  { name: 'Fan', ... },
  { name: 'Chain', ... },
  { name: 'Sword', ... },
  { name: 'Tonfun', ... },
  { name: 'Blues', ... },
];
```

This is the most tedious part — measuring exact pixel coordinates for
each frame. Use the sprite sheet image to eyeball, then fine-tune.

### 1.3 CharacterSprite component

```tsx
// components/CharacterSprite.tsx
interface Props {
  character: string;      // 'Buchu', 'Star', etc.
  pose: 'idle' | 'attack' | 'hit' | 'victory';
  mirror?: boolean;       // flip horizontally (right-side fighter)
  scale?: number;         // pixel scaling factor (default 3-4x)
  tint?: string;          // CSS hue-rotate for duplicate characters
}
```

Uses CSS `background-image` + `background-position` on the keyed sprite
sheet. `image-rendering: pixelated` for crisp scaling. Mirror via
`transform: scaleX(-1)`.

### 1.4 Character assignment

Seeded by `config.seed + 'characters'` — deterministic. Each agent gets a
character index. If more than 9 agents, wrap with hue-rotate tint.

```typescript
function assignCharacter(agentId: string, seed: string, index: number): {
  character: string;
  tint: string | null;  // null for first 9, hue-rotate for overflow
}
```

---

## Phase 2: Battle View Overhaul

**Replace the data-grid battle view with the arcade fighter layout.**

### 2.1 Arena background

Full-width scene using `bg-temple.jpg` or `bg-waterfall.jpg` (randomly
selected per pairing or per round, seeded). CSS `background-size: cover`,
slightly darkened overlay so UI elements are readable.

### 2.2 Fighter layout

Two characters on either side of the arena, facing each other. Left
fighter normal, right fighter mirrored. Scale 3-4x from original sprite
size. Position in lower third of the arena.

```
┌──────────────────────────────────────────────┐
│  ROUND 7/12         OATHBREAKER  誓約破り     │
│                                               │
│  Agent_03      ⚔ VS ⚔      Agent_17          │
│  $1.23 ▓▓▓▓▓▓░░  │  ░░▓▓▓▓▓▓ $0.87          │
│  8/10 oaths      │     6/10 oaths            │
│                                               │
│     🥋                           🥋           │
│   [SPRITE]                    [SPRITE]        │
│   idle pose                   idle pose       │
│_______________________________________________|
│                                               │
│  Chat / Negotiation / Results panel           │
│                                               │
└───────────────────────────────────────────────┘
```

### 2.3 Arcade HUD

Top bar styled like an arcade game HUD:
- **Round counter**: "ROUND 7/12" in pixel font
- **Title**: "OATHBREAKER" in stylized text + "誓約破り" underneath in smaller type
- **Health bars**: Retro-styled, centered on break-even, blue/gold vs red
- **Coop stats**: Small text under health bars "8/10 OATHS KEPT"

Font: **Press Start 2P** (Google Fonts) for all HUD text. Load via
`@import` or `<link>`. Apply `image-rendering: pixelated` to sprites.

### 2.4 Chat/negotiation overlay

Below the fighters (lower third of screen). Shows:
- Chat messages in speech-bubble style (retro pixel bubble)
- Proposal actions highlighted: "► PROPOSES: 12 POINTS"
- Agreement banner: "⚔ OATH SWORN — 12 POINTS ON THE LINE ⚔"
- Decision indicators: "⏳ AWAITING DECISIONS..." with sealed icons

---

## Phase 3: Battle Animations

**State machine for the battle sequence.**

### 3.1 Pairing phases → visual states

| Pairing Phase | Visual State | Sprites | Effects |
|---|---|---|---|
| `pledging` | Negotiation | Both idle | Chat bubbles flowing |
| `deciding` (pledge agreed) | Oath sworn | Both idle, slight glow | "OATH SWORN" banner |
| `decided` (both submitted) | Tension | Both idle, screen darkens | "FATES SEALED" text |
| Round end → `cooperation` | Mutual honor | Both → victory pose | Golden glow, "+$X" float up |
| Round end → `betrayal_1` | P1 breaks oath | P1 attack, P2 hit | Screen shake, red flash on P2 |
| Round end → `betrayal_2` | P2 breaks oath | P2 attack, P1 hit | Screen shake, red flash on P1 |
| Round end → `standoff` | Both break | Both attack + hit | Double shake, red flash |

### 3.2 CSS animations

All animations CSS-only (no animation library needed):

```css
@keyframes screenShake {
  0%, 100% { transform: translate(0); }
  25% { transform: translate(-4px, 2px); }
  50% { transform: translate(4px, -2px); }
  75% { transform: translate(-2px, 4px); }
}

@keyframes goldenGlow {
  0% { filter: brightness(1); }
  50% { filter: brightness(1.5) sepia(0.3); }
  100% { filter: brightness(1); }
}

@keyframes floatUp {
  0% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(-60px); }
}

@keyframes redFlash {
  0% { background-color: transparent; }
  50% { background-color: rgba(255, 0, 0, 0.3); }
  100% { background-color: transparent; }
}
```

### 3.3 Sprite pose transitions

On resolution reveal:
1. Both sprites in idle (0.5s pause, screen darkens)
2. Swap to attack/hit/victory poses based on outcome
3. Hold for 2 seconds
4. CSS effects play (glow/shake/flash)
5. Dollar delta floats up from each fighter
6. Health bars animate to new values
7. Return to idle after 3 seconds

---

## Phase 4: Tournament Overview (Arcade Select)

**Replace the data grid with an arcade character select screen.**

### 4.1 Layout inspiration

Reference: `opponent-select.jpg` — the "NEXT OPPONENT" portrait grid.

Grid of agent cards, each showing:
- Character portrait (sprite idle frame, scaled up)
- Agent name (Press Start 2P font)
- Dollar health bar (same as battle view, smaller)
- Cooperation record: "OATHS: 8/10"
- Status indicator: "VS Agent_17" or "DECIDED" or "+$0.12"

### 4.2 Card styling

Dark card with pixel border. Active battles have a pulsing border.
Decided pairings have a dim overlay until round resolves. Click → battle view.

### 4.3 Title header

```
╔══════════════════════════════════════════╗
║         O A T H B R E A K E R           ║
║             誓約破り                      ║
║          Seiyaku-yaburi                   ║
╚══════════════════════════════════════════╝
         ROUND 7 / 12  ·  8 WARRIORS
```

Styled like the Yie Ar Kung-Fu title screen. Gold text on dark background.
Maybe use the title screen image as a subtle background watermark.

---

## Phase 5: Polish

### 5.1 CRT scanlines (optional, subtle)

```css
.arcade-screen::after {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    transparent 0px, transparent 1px,
    rgba(0,0,0,0.1) 1px, rgba(0,0,0,0.1) 2px
  );
  pointer-events: none;
}
```

### 5.2 Retro sound effects (Web Audio API)

Oscillator-based bleeps and bloops. No audio files needed:
- Proposal submitted: short rising tone
- Oath sworn: two-note chord
- Betrayal: harsh buzz/crash
- Cooperation: pleasant bell
- Round start: arcade "READY?" jingle

### 5.3 Pixel font everywhere

- HUD: Press Start 2P
- Title: Press Start 2P (large, spaced)
- Japanese: Noto Sans JP or similar (for 誓約破り)
- Numbers: Press Start 2P monospace

### 5.4 Responsive

Lock to 16:9 or 4:3 aspect ratio for the battle view. Letterbox on
ultra-wide screens. Scale everything relative to viewport height.

---

## File Structure (new/modified in CtL repo)

```
packages/web/src/games/oathbreaker/
  SpectatorView.tsx          — MODIFY: rewire to use arcade components
  components/
    ArcadeBattleView.tsx     — NEW: full arcade battle scene
    ArcadeOverview.tsx       — NEW: tournament select grid
    CharacterSprite.tsx      — NEW: sprite rendering + poses
    HealthBar.tsx            — NEW: retro health bar centered on break-even
    ArcadeHud.tsx            — NEW: top bar (round, title, health bars)
    ChatOverlay.tsx          — NEW: speech-bubble style chat + proposals
    OathBanner.tsx           — NEW: "OATH SWORN" / "FATES SEALED" banners
    ResultReveal.tsx         — NEW: round-end animation orchestrator
  utils/
    spriteLoader.ts          — NEW: pink-key removal + caching
    spriteMap.ts             — NEW: character bounding box coordinates
    characterAssignment.ts   — NEW: seeded character → agent mapping
  styles/
    arcade.css               — NEW: all arcade-specific styles, animations
```

**Existing SpectatorView.tsx** stays as the data layer — it already maps
server state to the right types. The arcade components are a visual layer
on top. Don't rewrite the data handling, just replace the JSX rendering.

---

## Implementation Order

1. **Sprite system** (Phase 1) — 1.1 through 1.4. This blocks everything visual.
   Hardest part is measuring the sprite coordinates.
2. **Battle view** (Phase 2) — backgrounds + fighters + HUD. The "wow" moment.
3. **Animations** (Phase 3) — pose transitions + CSS effects. Makes it feel alive.
4. **Tournament overview** (Phase 4) — arcade select grid with character portraits.
5. **Polish** (Phase 5) — CRT, sound, font tuning. Cherry on top.

Each phase is independently demoable. Phase 1+2 gets you 80% of the visual
impact. Phase 3 makes it feel like a real game. Phase 4+5 are polish.

---

## Assets Available

All at `packages/web/public/assets/oathbreaker/`:
- `sprites-original.png` — 616x608, pink bg (#FF00FF), 9 characters
- `bg-temple.jpg` — temple/mountain scene
- `bg-waterfall.jpg` — waterfall/mountain scene
- `opponent-select.jpg` — reference for overview layout
- `title-arcade.jpg` — branding reference
- `title-imagine.jpg` — alt branding reference
