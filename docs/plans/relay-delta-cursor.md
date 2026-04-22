# Relay Delta Cursor

## Problem

`/api/player/state` returns the full relay (every chat message, every tool event) on every call. `wait_for_update` opens a WS, receives a delta on wakeup, then throws it away and fetches fresh state via HTTP. Each `get_state` response grows unboundedly with game length — by the end of a long lobby phase, a single call can push tens of KB into an MCP agent's context. This was the proximate cause of "Prompt is too long" blowing up `haiku` bots after ~50 turns.

The delta infrastructure exists: `GameRoomDO._lastBroadcastRelayIdx`, `LobbyDO._lastBroadcastRelayIdx`, `buildSpectatorPayload(ctx, sinceIdx)`. It's used on the WS broadcast path. It's not used for HTTP `/state` reads or for `wait_for_update`'s post-wakeup refetch.

## Desired End State

- The agent sees a stateless `get_state` tool. No cursor in the signature, no cursor in the response.
- The MCP server (`coga serve --stdio`) holds a per-process cursor and plumbs it through automatically.
- `/api/player/state?sinceIdx=N` returns only relay envelopes `>= N` plus the new tip.
- `wait_for_update` consumes the WS push directly — the delta payload becomes the state it returns, no second HTTP hit.
- A fresh `coga serve` starts with `sinceIdx=0` → one full snapshot → subsequent calls are tiny deltas.

Matches the `/ws/player` refactor's philosophy: the server is the source of truth, the agent is stateless, plumbing lives in the CLI.

## Non-Goals

- No per-session cursor persistence on the server. Server stays stateless for reads.
- No cursor exposed to the agent. It's pure plumbing.
- No change to the public relay contract (envelope shape stays identical).
- No change to the anonymous spectator path (`/ws/game/:id`, `/ws/lobby/:id`). It already uses `sinceIdx`.

## Design

### Server

Both `LobbyDO.handleState` and `GameRoomDO.handleState` already read `sinceIdx` from the query string for the spectator path. Extend the authed player path so it threads `sinceIdx` into `buildSpectatorPayload`. The builder already supports deltas — this is wiring, not new logic.

`/api/player/state?sinceIdx=N`:
- Returns only relay envelopes `>= N`.
- Envelope `meta.sinceIdx` reports the new tip.
- `N` omitted → full relay (unchanged from today, the fresh-start case).

Same for `/api/player/tool` — its returned state envelope should honor an `X-Relay-Since-Idx` header (or `sinceIdx` in the body) so the post-action state is also delta-shaped.

### CLI plumbing

`ApiClient` gains a `_relayCursor: number` field. All reads that return state envelopes bump it from `meta.sinceIdx`:

```
// inside getState / callTool / waitForUpdate
const url = sinceIdx ? `/api/player/state?sinceIdx=${this._relayCursor}` : '/api/player/state';
const env = await this.get(url);
if (env.meta?.sinceIdx != null) this._relayCursor = env.meta.sinceIdx;
return flattenStateEnvelope(env);
```

`GameClient` exposes no new API — the cursor lives on `ApiClient`.

`flattenStateEnvelope` keeps `relayMessages` semantics, but callers should expect it to be a *delta* after the first call. The MCP `get_state` tool needs to merge deltas into its own view or just pass the delta through — see next section.

### MCP tool surface

Two choices for the `get_state` tool response:

**(a) Merge-on-client**: MCP tool keeps the full relay in memory, merges incoming delta, returns the full relay to the agent. Agent sees a consistent full-state view. Memory grows with game length but stays on the plumbing side, never hitting haiku's context.

**(b) Pass-through**: MCP tool returns only the delta. Agent sees new relay envelopes since its last call. Agent's context contains only what's new. Massive context savings, but the agent has to handle "I see chat from turn 37 but nothing from turns 1-36" reasonably.

Pick (b). The agent already treats each turn's `get_state` as independent; they don't look back at prior responses. Stripping history from the response text eliminates the context bloat root cause. Include a `{ relayDelta: Envelope[], sinceIdx: number, tip: number }` shape so the agent (and any human reader) can tell it's a delta, but the field is just documentation — the agent doesn't act on it.

### wait_for_update

Today:

1. POST `/api/player/ws-ticket`
2. WS `/ws/player?ticket=X`
3. Wait for second frame / close / timeout
4. Discard the frame, `getState()` via HTTP

Change:

1. POST `/api/player/ws-ticket`
2. WS `/ws/player?ticket=X` (with `?sinceIdx=N` forwarded to the DO)
3. Consume the first post-snapshot frame — it IS a delta envelope
4. Bump `_relayCursor` from its `meta.sinceIdx`
5. Return the envelope directly to the MCP tool (no second HTTP hit)

LobbyDO/GameRoomDO's WS handlers already honor `sinceIdx` on the initial snapshot via `buildSpectatorPayload`. They need to also honor it for the post-snapshot broadcast frames the client waits for (i.e. the WS should filter to envelopes `>= N` when broadcasting). For hibernatable WSs the per-connection cursor lives in the attachment (`ws.serializeAttachment({sinceIdx: N})`).

## Implementation Plan

1. **Server: authed state honors `sinceIdx`.**
   - `LobbyDO.handleState`: pass `sinceIdx` through to `buildLobbySpectatorPayload`.
   - `GameRoomDO.handleState` (auth branch): same, via `buildPlayerPayload`.
   - Unit tests: player state with `sinceIdx=0` and `sinceIdx=tip` returns expected slices.

2. **Server: tool dispatch honors `sinceIdx`.**
   - `dispatchToolCall` reads `X-Relay-Since-Idx` (or query) and forwards it when re-building post-action state.

3. **Server: WS push honors per-connection cursor.**
   - On WS upgrade, parse `?sinceIdx=N` and serialize into the WS attachment.
   - On broadcast, read each WS's attachment, build a per-connection delta payload.
   - Update attachment to the new tip after each successful `send`.

4. **CLI: `ApiClient` holds `_relayCursor`.**
   - Wire it into `getState`, `callTool`, `waitForUpdate`, `authVerify` (which returns initial state).
   - Reset on `authenticate()` — the cursor is per-session.

5. **CLI: `waitForUpdate` returns the WS delta directly.**
   - Drop the post-wakeup HTTP refetch.
   - Promote `waitForWsWakeup` to `waitForWsFrame` — returns the parsed frame or `null` on timeout.
   - On timeout, fall back to `getState()` (same as today).

6. **MCP: `get_state` returns delta shape.**
   - Response: `{ state, meta: {sinceIdx, tip}, relayDelta: Envelope[], currentPhase?, gameOver? }`.
   - Update tool description so the agent knows it's a delta.

7. **Tests.**
   - Server unit: delta slicing at lobby + game.
   - CLI unit: `ApiClient` cursor progresses correctly across `getState` → `waitForUpdate` → `getState`.
   - Integration: smoke-test a full lobby→game→finish flow, assert total relay bytes sent to the agent < 10% of full-transcript bytes.

## Risk

- **WS broadcast fan-out cost.** Building per-connection payloads on every tick is more CPU than one payload shared across all WSs. Mitigation: for games with N players (N is tiny), per-connection is fine. For spectator fan-out we can still build one public payload and share it — the per-connection cursor only matters for authed player WSs.
- **Dropped envelopes if a client reconnects mid-broadcast.** The attachment cursor is on the DO side. A fresh connect with `sinceIdx=old` resends missed envelopes. Safe.
- **Agent confusion from "delta mode."** We accept this — per tool description, `get_state` returns "relay envelopes since your last call." Bots and humans both read the description.

## Followups

- Persist the cursor in `coga serve`'s session file so a crashed+restarted CLI resumes where it left off. Not needed for correctness, but nice for long-lived bots.
- Expose `sinceIdx` in the `coga wait` CLI output so humans debugging can see the delta moving.
