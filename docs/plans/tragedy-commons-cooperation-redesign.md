# Tragedy Commons Cooperation Redesign

Proposal for a feature branch off `djimo/agentic-trust-integration` that makes Tragedy of the Commons simpler, more visually entertaining, and mechanically aligned with “win while keeping the commons alive.”

## Current Problem

- `packages/games/tragedy-of-the-commons/src/game.ts` assigns Catan-like production numbers with `PRODUCTION_WHEEL`, and the spectator board pulses matching tiles.
- Actual production is not tile-number driven: `applyProduction` gives each controlled region `+1` of its primary resource every round, plus a flourishing ecosystem bonus.
- Extraction is the real commons decision: `low`, `medium`, and `high` yield `1/2/3` resources and apply `1/3/6` pressure.
- Ecosystems recover with `health + 2 - pressure`, start near flourishing, and collapse only changes future extraction yield.
- `computePayouts` is winner-take-all by VP/influence ranking; ecosystem health does not affect payout.
- The spectator UI currently shows trust, prize-pool pressure, slashing, commitments, and structures that are partly synthesized rather than fully grounded in game incentives.

## Design Direction

The game should revolve around one visible shared-pool loop:

1. Show ecosystem health as the main board state.
2. Agents choose low / medium / high extraction.
3. Reveal extraction choices together or in a clear round-resolution beat.
4. Animate damage, regeneration, and collapse.
5. Update public cooperation reputation from actual behavior.
6. Make final rewards depend on both individual rank and surviving commons health.

This keeps competitive tension while making cooperation rational: an agent can lead individually but still lose value if the commons collapses.

## Proposed Mechanics

| Area | Proposed change | Why it supports the premise |
| --- | --- | --- |
| Production | Remove or visually demote production-number wheel unless it becomes real logic. | Avoids Catan confusion and focuses attention on extraction choices. |
| Extraction | Keep low / medium / high as the main decision; make the reveal visually dramatic. | Spectators immediately understand restraint vs greed. |
| Health | Tune recovery and collapse so overuse becomes visible within a match. | The commons must feel fragile enough for cooperation to matter. |
| Payout | Scale final pot by final ecosystem health or collapse penalties. | Winning now requires balancing individual score with collective survival. |
| Reputation | Derive public reputation from actual extraction restraint, trades, and stewardship. | Cooperation becomes legible and strategically useful. |
| Slashing | Tie slashing/punishment visuals to real rule outcomes, not decorative overlays. | Spectator drama matches actual incentives. |

## Proposed Visual Model

- Use `/Users/djimoserodio/Downloads/tragedy_commons_asset_library_with_visual_index 2` as the visual source.
- Most valuable sheets:
  - terrain base: six flat-top biomes.
  - terrain health states: six biomes across flourishing / stable / strained / collapsed.
  - VFX A: extraction, warning, health drain, regeneration.
  - VFX B: collapse, trade route, build, winner/endgame.
  - player banners, settlement progression, extraction structures, resource icons.
- Put the shared ecosystem state at the center of the screen.
- Put agents around it with clear color identities.
- Use green trails for stewardship, amber for moderate extraction, red for over-extraction/slashing.
- Show a short action-history ribbon per agent so spectators can judge cooperation at a glance.

## Implementation Shape

First implementation branch should stay narrow:

- Rules layer: align payout and health incentives in `packages/games/tragedy-of-the-commons/src/game.ts` and `plugin.ts`.
- View-model layer: expose real cooperation/reputation signals instead of synthesizing them only in the spectator.
- Spectator layer: simplify `OriginalObservatory.tsx`, `GameBoard.tsx`, and side panels around health, extraction reveal, reputation, and payout risk.
- Asset layer: replace temporary or blurry visual choices with cropped frames from the new structured asset library.
- Tests: cover payout-health coupling, extraction pressure, collapse consequences, and visible-state fields used by the spectator.

## Merge Readiness

The visual branch depends on these files being included when the work is committed:

- `packages/web/src/games/tragedy-of-the-commons/original/lib/terrain-images.ts`
- `packages/web/public/assets/tragedy/`
- `packages/web/tragedy-preview.html` and `packages/web/src/tragedy-preview-main.tsx` if the local preview fixture should remain available to reviewers.

Do not merge only the React component changes without the asset loader and PNG asset tree; the board will fall back or lose the intended health-state visual language outside this machine.

## Non-Goals For The First Branch

- No full rules rewrite into a different game genre.
- No hidden-information complexity.
- No extra settlement/city/road systems unless they directly support the commons loop.
- No fake spectator economics that agents cannot reason about.

## Merge Target

Develop on a feature branch and merge back into `djimo/agentic-trust-integration` after tests, build, and spectator QA pass.
