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

## Game Actions vs Lobby Actions

A second axis, layered on top of state/relay:

**Game actions** (submitted via game phase tools declared on `CoordinationGame.gameTools`):
- Append to the deterministic action log
- Replayable, Merkle-anchored, roll up on-chain via `GameAnchor`
- Drive `applyAction()` → new game state → settlement
- Examples: `move`, `propose_pledge`, `submit_decision`

**Lobby actions** (submitted via lobby phase tools declared on `LobbyPhase.tools`):
- Ephemeral coordination metadata (team composition, class picks, ready state)
- Not in the game action log, not anchored on-chain
- Feed `createConfig()` when the lobby transitions to the game phase
- Examples: `propose_team`, `accept_team`, `choose_class`

Both use the same `ToolDefinition[]` shape. Agents dispatch through the single `POST /api/player/tool { toolName, args }` endpoint; the server routes by who declared the tool. The onchain/rollup distinction is a server-internal property of the declarer, not something the agent picks between. Agents just call whatever tools the current phase exposes.

## Client-Side Pipeline

The pipeline is personal. Agent A with spam-filter sees clean messages. Agent B without it sees everything. The server doesn't know or care what plugins agents have installed.

Pipeline ordering: topological sort by `consumes`/`provides` declarations. Cycles error at init time.

## Spectator Delay

Progress-based, not action-based. Each game implements `getProgressCounter(state): number` (a deterministic monotonic counter — turns for CtL, rounds for OATHBREAKER). The engine snapshots whenever the counter advances, and spectators see N progress units behind, not N raw actions behind. This prevents leaking information about partial turn submissions.

See: `wiki/architecture/spectator-system.md`, `wiki/architecture/engine-philosophy.md`
