# OATHBREAKER Animation Plan

Status: **Ready** (CtL animations complete, generic contract in place)

## Current State

- 9 characters (buchu, star, oolong, nuncha, fan, chain, sword, tonfun, blues)
- Each has 4 **static pose PNGs**: idle, attack, hit, victory
- `useRevealAnimation` hook in ArcadeBattleView manages a 4-phase state machine: none → darken → reveal → aftermath
- Poses map to outcomes: cooperation=victory+victory, betrayal=attack+hit, standoff=attack+attack
- CSS effects: shake, red-flash, golden-glow, float-up (dollar deltas), fade-in-up (outcome banner)
- **Replay bug**: reveal animation only triggers when following a player AND the result key changes. Round transitions during replay scrubbing don't trigger animations.

## Goals

1. Replace static pose swaps with animated sprite sequences
2. Add distinct visual+sound-cue animations for each outcome type
3. Fix replay mode to properly trigger animations on round transitions
4. Keep the Yie Ar Kung-Fu arcade aesthetic

## Sprite Animation Approach

**`sprites-original.png`** (`packages/web/public/assets/oathbreaker/sprites-original.png`) is the full Yie Ar Kung-Fu arcade sprite rip containing multi-frame animation sequences for every character — idle cycles, attack wind-ups, strikes, follow-throughs, hit recoils, jumps, crouches, etc. Far more frames than the 4 static poses currently extracted.

**Plan:** Parse the sprite sheet to extract frame sequences per character per action. Build a `useFrameAnimation` hook that cycles through frames at ~8fps (authentic retro feel). `CharacterSprite` switches from static `<img>` to a clipped sprite sheet view with frame stepping.

**Challenge:** The sprite sheet is not on a perfect grid — characters have different sizes and frame counts per row. Will need manual mapping (character → row, action → frame ranges, frame dimensions). May need Lucian's help identifying which frames map to which actions for each character.

## Outcome Animations

### Cooperation (Both Keep Oath)
- Both sprites do a small bow (dip transform), then victory pose
- Golden ripple effect expands from center (CSS radial gradient animation)
- Text burst: "HONOR" in gold, arcade-style scaling text
- Concentric circle "gong" visual (gold rings expanding + fading)

### Mutual Betrayal (Both Break Oath)  
- Both sprites lunge toward center simultaneously
- Meet in middle — white flash + spark particles (CSS)
- Both bounce back to positions with hit pose briefly
- Screen shake (existing, enhance with longer duration)
- Text burst: "CLASH!" in orange/red

### One-Sided Betrayal
- Attacker winds up (attack frames), lunges toward victim
- Victim shows surprise (brief idle), then hit pose as attacker connects
- Red slash mark ("X") appears over victim (SVG or CSS)
- Victim sprite flashes red, slides back
- Text burst: "BETRAYED!" in red
- Dollar delta floats appear (existing, keep)

## Chat Bubbles

Show each player's latest chat message as a speech bubble over their character sprite in the fight screen. The spectator view already receives chat data per round — display the most recent message from each player as a comic-book-style bubble (retro pixel font, pointed tail toward the character). Bubbles should appear during the "darken" phase (pre-reveal) and fade during "aftermath". Truncate long messages.

## Timing

Current reveal animation: darken(1000ms) → reveal(2000ms) → aftermath(2000ms) → none
Proposed: darken(800ms) → wind-up(400ms) → action(600ms) → impact(400ms) → aftermath(1500ms) → none
Total: ~3.7s per round resolution (vs current 5s)

## Replay Mode Fix

The platform now passes `prevGameState` and `animate` to `SpectatorView` (same contract CtL uses). The `useRevealAnimation` hook should:
1. When `animate=true` (auto-play), diff `prevGameState` vs `gameState` to detect round transitions and trigger the reveal sequence
2. When `animate=false` (scrubbing), skip directly to final pose state without animation
3. No need for the `resultKey` hack — the platform handles snapshot diffing

## Dependencies

- ~~Generic animation contract (prevGameState, animate props on SpectatorViewProps)~~ — **Done.** `SpectatorViewProps` has `prevGameState`, `animate`, and plugins set `animationDuration`. See `docs/building-a-game.md` → "Turn Transition Animations" and `wiki/architecture/spectator-system.md`.
- Sprite frame mapping from `sprites-original.png` (may need Lucian's help identifying character rows and action frame ranges)
- Set `animationDuration` on the OATHBREAKER `SpectatorPlugin` once timing is finalized
