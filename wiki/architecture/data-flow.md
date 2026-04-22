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

## Relay Delta Cursor

The relay log grows unboundedly with game length. To keep per-call responses (and agent context) bounded, the three layers split the work cleanly:

- **Server — stateless.** `GET /api/player/state?sinceIdx=N` and `WS /ws/player?sinceIdx=N` return only envelopes with `index >= N`. `buildSpectatorPayload` (`packages/workers-server/src/plugins/spectator-payload.ts`) clamps `N` to `[0, relayTip]` and echoes back the next cursor as `meta.sinceIdx`. No cursor state on the server.
- **CLI — holds the cursor.** `ApiClient._relayCursor` (`packages/cli/src/api-client.ts`) is the single source of cursor state. Every read passes it; every response advances it. Reset on auth change.
- **Pipeline — runs over whatever it gets.** The pipeline is stateless by design, so feeding it deltas produces delta messages without any pipeline-side bookkeeping.
- **Agent — cursor-free.** MCP tools (`get_state`, `wait_for_update`) have no cursor in their signatures or responses. `flattenStateEnvelope` strips `meta.sinceIdx` on the way out; `game-client.ts` strips raw `relayMessages` after the pipeline consumes them.

Net effect: first call → full history, subsequent calls → small deltas. First-read-after-auth always gets the full picture; after that, every call ships only what's new.

## Change Notification: WebSockets, Not Long-Poll

Both authed agents and anonymous spectators learn about state changes via WebSocket (`/ws/player`, `/ws/game/:id`, `/ws/lobby/:id`), not HTTP long-poll. This choice is Cloudflare-Workers-specific and load-bearing for cost.

- **Hibernatable WS** (`ctx.acceptWebSocket()`) lets the Durable Object hibernate while sockets are idle. The DO pays CPU time only when a message flows. Thousands of idle connections cost essentially nothing.
- **Long-poll would bill wall-clock.** A held-open request consumes worker invocation slots for the entire wait window and bills the DO for the full duration. At a 25s wait-per-turn that's 50s of DO wall-time per 2-player turn vs ~0s idle with hibernatable WS. Scales badly with concurrent players.

The CLI's `waitForUpdate` opens a WS, waits for the next frame, then HTTP-fetches fresh state. The WS is pure change-notification — we discard the frame content and trust `/api/player/state?sinceIdx=N` for the authoritative delta. (Client-side hang watchpoint: Node's built-in `WebSocket.close()` is graceful, which leaves the socket in CLOSE_WAIT and keeps the event loop alive for up to 30s. The CLI uses the `ws` npm package and calls `.terminate()` on wakeup to force-destroy the socket immediately. If you ever migrate off `ws`, preserve the force-terminate semantics or the CLI will hang after each wait.)

## Spectator Delay

Progress-based, not action-based. Each game implements `getProgressCounter(state): number` (a deterministic monotonic counter — turns for CtL, rounds for OATHBREAKER). The engine snapshots whenever the counter advances, and spectators see N progress units behind, not N raw actions behind. This prevents leaking information about partial turn submissions.

See: `wiki/architecture/spectator-system.md`, `wiki/architecture/engine-philosophy.md`
