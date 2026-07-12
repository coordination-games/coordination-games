export const GENIUS_GUIDE = `# Genius — Project-Local Fixture Rules

This is an explicitly project-local Simon-inspired fixture for deterministic multiplayer validation and replay testing. It is not commercial Genius fidelity and does not claim to reproduce any authoritative product rules.

## Players and objective
- 2–4 players repeat a visible sequence of red, blue, green, and yellow.
- The sequence grows by one color each round, up to the configured round limit.
- Correctly completing a round prefix earns one point.
- A wrong press eliminates the acting player.
- The game ends when one active player remains or every active player completes the final round.

## Turn flow
- Only the current active player may act.
- Read the visible \`sequence\` and \`inputIndex\` fields.
- Call \`press_color\` with the color at that input index.
- After completing the full prefix, play advances to the next active player.

## Determinism
The full active prefix is intentionally visible. Colors are derived from the configured seed using the project canonical hash domain \`coordination-games/genius-fixture/v1\`. No clock, runtime randomness, or environment entropy participates.

## Ranking
Players rank by score, then active status, then later elimination. Original join order and player id only make serialization order deterministic; ladder placements remain tied when the competitive keys tie.
`;
