# Data Flow: State vs Relay

Two channels carry data. Confusing them is the most common architectural mistake.

## Game State

- Deterministic, proven via Merkle tree
- Server calls `getVisibleState()` per player (fog of war)
- Drives win conditions and settlement
- **Rule:** if removing it changes the game outcome, it's game state

## Relay Data

- Social, unverified, plugin-processed
- Routed by scope only (team/all/agentId) — server doesn't interpret content
- Processed by client-side plugin pipeline — different agents see different things
- **Rule:** if removing it changes the player experience but not the outcome, it's relay data

## Common Mistake

Putting chat/trust/social features into game state. Chat doesn't affect turn resolution. An agent can win without ever reading chat. Social data belongs in the relay.

## Client-Side Pipeline

The pipeline is personal. Agent A with spam-filter sees clean messages. Agent B without it sees everything. The server doesn't know or care what plugins agents have installed.

Pipeline ordering: topological sort by `consumes`/`provides` declarations. Cycles error at init time.

## Spectator Delay

Progress-based, not action-based. The `progressIncrement` flag in `ActionResult` marks meaningful game ticks (turn resolved, round completed). Spectators see N progress units behind, not N raw actions behind. This prevents leaking information about partial turn submissions.

See: `ARCHITECTURE.md`, `docs/BUILDER_NOTES.md`
