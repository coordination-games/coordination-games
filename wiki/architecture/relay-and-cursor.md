# Relay and Cursor
> The relay is a sequenced per-DO log of typed envelopes; clients read forward through a `sinceIdx` cursor that the server keeps no memory of, and WebSockets exist purely as a wake-up bell so Cloudflare's hibernatable-WS billing stays near zero between events.

## Why

Overview already pinned the load-bearing distinction: state is Merkle-anchored and decides outcomes, **relay** is plugin-processed and never does. This doc is the mechanics of that second channel — how envelopes are written, how clients read forward without re-fetching history they already have, and why the wake signal rides a separate transport from the data.

Three design pressures shape every choice below:

1. **Relay history grows monotonically with game length.** A long OATHBREAKER session emits one chat envelope per pledge; a 30-turn CtL game racks up team-chat / `bot:status` / per-action enrichment envelopes the same way. Re-shipping the full log on every `coga state` would burn the agent's context window on re-observations, and a cursor-less server would have to either re-send everything or hold per-(agent, scope) cursor state of its own. We picked client-held cursors — the server is the simplest possible truth, the CLI carries the complexity, and the agent never sees a cursor at all.

2. **Player-facing endpoints sit behind Cloudflare's pricing model.** Workers bill per request; **hibernatable Durable Object WebSockets** (`ctx.acceptWebSocket()`) bill CPU only when a message flows. A long-poll architecture would bill DO wall-time for every held-open request — at a 25-second per-turn poll across two players that's 50 seconds of DO wall-time per turn vs roughly zero with hibernation. So the WS exists *only* to break the agent out of `wait()` early; the actual state and relay deltas come over HTTP, which is pay-per-request. This split is load-bearing for unit economics, not a stylistic choice.

3. **The CLI is the primary agent path** (the One Rule, `wiki/architecture/mcp-not-on-server.md`). Anything cursor-related lives in `ApiClient` so `coga state` from a shell and the MCP `state` tool exhibit byte-identical behaviour. The `AgentStateDiffer` scar (an MCP-only feature that left real agents undeduped for months — see `wiki/architecture/agent-envelope.md`) is precisely the failure this rule prevents; cursors live one floor up from the differ but follow the same constraint.

## How

**The relay log shape.** A `RelayEnvelope` (`packages/engine/src/types.ts:53-70`) is a typed POJO with a monotonic per-DO `index`, a `pluginId`-owned `type`, a `sender` (a playerId or the literal `'system'`), a discriminated `scope` (`{kind:'all'} | {kind:'team', teamId} | {kind:'dm', recipientHandle}`, line 43), the progress counter at send time, a wall-clock `timestamp`, and a plugin-defined `data` body validated at publish time. Two consumers exist: the per-(agent) HTTP fetch and the spectator broadcast. Both read through one `RelayClient` interface (`packages/workers-server/src/plugins/capabilities.ts:32-46`) — `publish`, `visibleTo(viewer)`, `since(index, viewer)`, `getTip()`. The server never inspects `data`; visibility is decided by `scope` + viewer kind alone.

**Storage layout.** `DOStorageRelayClient` (`packages/workers-server/src/plugins/relay-client.ts:69`) writes one entry per envelope at `relay:0000000042` (10-digit zero-padded so `storage.list({prefix:'relay:'})` is lex-sorted) plus a `relay:tip` integer. `publish()` writes exactly two values per envelope independent of log length (`:127-132`); the previous "single `'relay'` array key, re-`put` on every publish" shape was O(n) write-amplification and the scar that pushed this design. Bodies are run through `validateRelayBody(type, data)` *before* an index is assigned (`:108-122`) so unknown types and bad shapes never get a tip-bump.

**Visibility filter.** One predicate, `isVisible(env, viewer, opts)` (`packages/workers-server/src/plugins/relay-client.ts:182-210`):

- `viewer.kind === 'admin'` → everything.
- `scope.kind === 'all'` → everyone.
- `'spectator'` / `'replay'` viewers → only `'all'`.
- `'player'` / `'bot'` → DMs they sent or received (matched on both `playerId` and resolved handle), team chat for their team, plus `'all'`.

Both `visibleTo` (full history) and `since(index, viewer)` (delta) run the same predicate (`:138, :153`). Bots and players take the same path; there is no `kind: 'bot'` shortcut in `isVisible`.

**The cursor — three layers, each does one thing.**

```
┌────────────┐  GET /api/player/state?sinceIdx=N
│   server   │  → buildSpectatorPayload clamps N to [0, relayTip],
│ (stateless)│    returns visible envelopes, echoes meta.sinceIdx
└────────────┘    = next-cursor (highest+1 included, or relayTip if empty)
       ↓
┌────────────┐  ApiClient.relayCursor: number
│    CLI     │  hydrate from disk before each fetch,
│  (owner)   │  advance from response.meta.sinceIdx,
└────────────┘  persist back to disk after success
       ↓
┌────────────┐  pipeline.execute() over response.relayMessages
│  pipeline  │  no cursor of its own — runs over whatever it's handed
└────────────┘
       ↓
┌────────────┐  agent envelope: never sees a cursor
│   agent    │  (flattenStateEnvelope strips meta.sinceIdx;
└────────────┘   game-client strips raw relayMessages after pipeline)
```

- **Server: stateless and clamping.** `buildSpectatorPayload` (`packages/workers-server/src/plugins/spectator-payload.ts:175`) accepts an optional `sinceIdx` query param and runs `clampSinceIdx(claim, relayTip)` (`:167-173`): negatives → 0, `> relayTip` → `relayTip`, non-finite → 0. The clamp is the trust boundary — a malicious client claiming `sinceIdx=999` against a tip of 100 gets zero envelopes, not an error. The returned `meta.sinceIdx` is `lastIncludedIndex + 1` when something was returned, or `relayTip` when the relay was empty for this viewer (`:189-192`); either way, `next call with sinceIdx = meta.sinceIdx` is correct. No cursor state lives on the server — every call carries the complete claim.
- **CLI: cursor owner.** `ApiClient.relayCursor` (`packages/cli/src/api-client.ts:154`) starts at 0, rides every state-returning request as `?sinceIdx=N` (`:428, :455, :488`), and advances from the response's `meta.sinceIdx` via `advanceCursor` (`:282-287`) which only ever moves forward. `setAuthToken` resets to 0 (`:191-194`) — new session, no assumed history.
- **CLI: persistence.** Two separate `coga state` shell processes need to dedup against each other. `ApiClient.setScope(agent, scopeId)` (`:206`) binds the cursor to a `(agentAddress, scopeId)` key on `~/.coordination/agent-state.json`; `loadPersistedCursor` runs at the entry of every state-returning method (`:244-255, :426, :452, :484`), and `persistCursor` writes the new value on success (`:261-280`). Persistence is best-effort — a disk error logs to stderr and the next call eats one round-trip of stale-cursor work, never fails the user. Persistence is **scope-bound**: unscoped commands (`coga lobbies`, `coga wallet`, identity flows) deliberately do not call `setScope` so they don't poison the persisted cursor of an active game (`:207-220`).
- **Pipeline: stateless.** `runPipeline` (`packages/cli/src/pipeline.ts:38`) seeds a `Map<string, unknown>` with `relay-messages` and walks the topo-sorted steps (see `wiki/architecture/plugin-pipeline.md`). Whatever it gets handed it processes — empty array → empty output, full history → full output, delta → delta. No bookkeeping inside the pipeline.
- **Agent: cursor-free.** MCP tools (`state`, `wait`, `tool`) have no `sinceIdx` in their signatures or returns. `flattenStateEnvelope` (`packages/cli/src/api-client.ts:37`) strips `meta.sinceIdx` on the way out; `GameClient.processResponse` (`packages/cli/src/game-client.ts:444`) strips raw `relayMessages` after the pipeline consumes them. The agent reads `newMessages` (the chat plugin's `agentEnvelopeKeys` projection) which is already a delta because the relay below it was a delta.

Net effect: first call → full visible history, every subsequent call → only what's new. First-read-after-auth always gets the full picture; after that, every call ships only what moved.

**WebSocket as notification.** `coga state` is one-shot. `coga wait` (and the MCP `wait` tool) is the long-running path — it blocks until the server signals "something changed," then returns a fresh `state`. The signal goes over a WebSocket. The data does not.

`ApiClient.waitForUpdate` (`packages/cli/src/api-client.ts:451-459`) trades the bearer token for a single-use 30-second WS ticket via `POST /api/player/ws-ticket` (auth-only — see `wiki/architecture/identity-and-auth.md`), opens `/ws/player?ticket=…&sinceIdx=N&knownStateVersion=V`, awaits a frame, and immediately calls `getState()` over HTTP. The WS frame's payload is discarded — `waitForWsWakeup` (`:91-129`) only inspects `meta.sinceIdx` to detect "the server already had pending deltas before we connected" (the initial-frame-is-pure-catchup case at `:113-122`) and otherwise ignores body content. HTTP is the authoritative delta source; the WS is the doorbell.

The DO side mirrors this:

- `webSocketMessage` (`packages/workers-server/src/do/GameRoomDO.ts:539-542`) is a no-op stub — clients never send anything over WS.
- `acceptWebSocket(server, [tag])` (`:881, :891`) tags the connection by playerId or `'spectator'`. Hibernatable WS lets the DO sleep with thousands of idle sockets attached at near-zero cost.
- `broadcastUpdates` (`:1513-1544`) and `broadcastSpectatorPayload` (`:1553-1574`) push fresh payloads on state mutations; on the spectator side, push happens **only when `publicSnapshotIndex` advances** (`:1519-1528`) so push cadence cannot leak hidden-action timing — see `wiki/architecture/spectator-system.md`.

**Why HTTP-on-wake instead of pushing the state on the WS itself.** Cloudflare bills hibernatable DO WebSockets per CPU-active second, not per minute attached. A WS that pushes full state envelopes on every change runs DO CPU for every push to every connection; the DO never gets to hibernate while clients are watching. A WS that only emits a small wake frame keeps the DO close to idle and pushes the bandwidth + serialisation cost onto HTTP requests, which are pay-per-request and amortised against the work the agent was already going to do (the follow-up `getState`). A long-poll architecture would be the worst of both — billing DO wall-clock for every held request *and* serialising state at the end. The wake-only WS is what gets the platform's per-game runtime cost down to "near zero between events," which is the regime the platform's economics assume.

There is one secondary benefit to the WS-then-HTTP shape: the server doesn't have to know which pending state changes the client cares about. The wake frame is "something happened — re-fetch and you'll see what." The HTTP fetch then runs the full ETag + relay-delta pipeline (`?knownStateVersion=V&sinceIdx=N`), so a CLI that already has the latest state version pays for a near-empty response. The two cursors compose: `knownStateVersion` short-circuits state, `sinceIdx` short-circuits relay, and the WS ticked the doorbell for both.

**Visibility on the WS path.** Both `/ws/player` and `/ws/game/:id` send an initial snapshot frame on connect — fog-filtered for player tags, public-delayed for spectator tags — built by the same `buildSpectatorPayload` HTTP uses (`packages/workers-server/src/do/GameRoomDO.ts:879-899`). The initial frame honours `?sinceIdx=N` and `?knownStateVersion=N` so a CLI reconnecting with a warm cache doesn't replay history. After connect, only `broadcastUpdates` / `broadcastSpectatorPayload` push frames; the CLI ignores the body and re-fetches anyway.

## Edge cases & gotchas

- **`sinceIdx` is envelope-index space, not progress space.** Chat may publish several envelopes between two progress ticks. Don't try to derive `sinceIdx` from `progressCounter` or vice versa — they advance independently (`packages/workers-server/src/plugins/spectator-payload.ts:18-20`).
- **`Number.isFinite` is the only validation; `clampSinceIdx` swallows the rest.** `NaN`, `Infinity`, negatives, over-tip — all clamp to a legal value and proceed. There is no 4xx for a bad `sinceIdx`. If you want to assert a malicious client can't read forbidden history, the test is "claim 999 against tip 100, get zero envelopes back" — this is the explicit policy at `packages/workers-server/src/__tests__/spectator-payload.test.ts:121`.
- **Persistence skipped without a scope.** `setScope(agent, scopeId)` is a both-or-neither switch (`packages/cli/src/api-client.ts:206-209`); when unset, the in-memory cursor still works but never round-trips through disk. This is *required* for unscoped commands so they don't clobber the active game's persisted cursor — but it also means a long-lived `coga serve` MCP process and a separate `coga state` shell *for the same scope* dedup against each other, while a `coga lobbies` call from the same shell does not (`:160-165`). If you want shell parity with MCP for a new state-shaped command, scope it.
- **`fresh: true` wipes both layers.** `GameClient.getState({fresh:true})` and `waitForUpdate({fresh:true})` (`packages/cli/src/game-client.ts:234-246, :264-275`) reset in-memory cursors, the differ, AND the on-disk `(agent, scope)` entry. Without the disk wipe, the next call would immediately re-hydrate the old cursor from `loadPersistedCursor`. The first call after `fresh` will be a full snapshot; that is by design.
- **The CLI's `waitForUpdate` opens a fresh WS per call, then `.terminate()`s it.** Node's built-in `WebSocket.close()` is a graceful close that leaves the socket in `CLOSE_WAIT` for up to 30 seconds — long enough to keep the event loop alive and stall CLI process exit. The CLI uses the `ws` npm package and calls `.terminate()` on wake (`packages/cli/src/api-client.ts:101`) to force-destroy the socket immediately. If you migrate off `ws` to the built-in, preserve force-terminate semantics or every `coga wait` will hang for half a minute after returning.
- **The first WS frame is sometimes a full snapshot, sometimes a delta.** On connect the DO sends `buildSpectatorPayload(viewer, sinceIdx, knownStateVersion)` (`packages/workers-server/src/do/GameRoomDO.ts:884, :894`). If both cursors are stale, that's a full snapshot; if both match, that's an empty `state: null` ETag-hit. `waitForWsWakeup` reads only `meta.sinceIdx` to decide whether to settle immediately (server already had pending deltas) or wait for the next push (`packages/cli/src/api-client.ts:113-124`). It never trusts the body for state.
- **Player WS broadcasts go per-recipient, spectator broadcasts go to one tag.** `broadcastRelayMessage` (`GameRoomDO.ts:1019-1031`) computes the recipient set from the envelope's scope (DM → sender + recipient, team → all members of that team, all → all players) and only builds a per-player envelope for those — the spectator side gets one `'spectator'`-tagged broadcast (`broadcastSpectatorPayload` at `:1553`). Don't add a player-tag broadcast inside chat-only paths; it'd thunder the DO when only one DM recipient cares.
- **Lobbies don't have a spectator-delay window.** `LobbyDO.buildLobbySpectatorPayload` (`packages/workers-server/src/do/LobbyDO.ts:800`) hard-codes `publicSnapshotIndex: 0` (`:864`) because lobby state is always public-safe — there's no fog and nothing hidden. The relay cursor still applies (chat in lobby is the standard delta-driven path), but progress-based gating is a `GameRoomDO`-only concern.
- **Lobby → game handoff closes spectator WSes deliberately.** When `LobbyDO` flips to `in_progress`, it `ws.close(1000, 'Handoff to game')` on every spectator WS (`packages/workers-server/src/do/LobbyDO.ts:768-772`) so clients re-route via `/ws/player` and land on the new GameRoomDO with a fresh cursor. Without that close, a CLI that raced past the D1 routing flip lands on GameRoomDO with a `sinceIdx` from the lobby's namespace and hangs on the idle socket until the next progress tick (~30s for `turn_timeout`). The cursor is per-DO; there's no shared namespace across the lobby/game boundary.
- **WS auth uses single-use tickets, not the bearer token.** Native browser WS can't set `Authorization`. `POST /api/player/ws-ticket` (`packages/workers-server/src/auth.ts:234`) trades a Bearer token for a 30-second UUID ticket; the WS URL carries `?ticket=…`; `consumeWsTicket` (`:248`) deletes the row unconditionally on lookup so a leaked URL can't be replayed. The long-lived bearer never appears in WS access logs.

## Pointers

- `packages/engine/src/types.ts:43-70` — `RelayScope`, `RelayEnvelope`. The wire shape both halves of the system agree on.
- `packages/workers-server/src/plugins/capabilities.ts:20-46` — `SpectatorViewer`, the `RelayClient` interface (`publish`, `visibleTo`, `since`, `getTip`).
- `packages/workers-server/src/plugins/relay-client.ts` — `DOStorageRelayClient` (line 69), padded-key storage layout (line 41), `isVisible` predicate (line 182).
- `packages/workers-server/src/plugins/spectator-payload.ts` — unified payload builder (line 175), `clampSinceIdx` (line 167), the `meta.sinceIdx` next-cursor rule (lines 186-192).
- `packages/workers-server/src/do/GameRoomDO.ts` — `webSocketMessage` no-op (line 539), WS upgrade with cursor honour (line 859), `broadcastUpdates` (line 1513), `broadcastSpectatorPayload` index-advance gate (line 1519), `buildPlayerPayload` (line 1395), `buildSpectatorPayload` (line 1470).
- `packages/workers-server/src/do/LobbyDO.ts:800-886` — lobby-side payload builder, no spectator-delay window.
- `packages/cli/src/api-client.ts` — `relayCursor` (line 154), `loadPersistedCursor` (line 244), `advanceCursor` (line 282), `getState` (line 425), `waitForUpdate` (line 451), `waitForWsWakeup` (line 91), `flattenStateEnvelope` (line 37).
- `packages/cli/src/agent-persistence.ts` — `~/.coordination/agent-state.json` schema, `proper-lockfile` invariants, atomic-write rule.
- `packages/cli/src/game-client.ts:444` — `processResponse`, the only caller of the pipeline on the live path; strips raw `relayMessages` after pipeline consumes them.
- `packages/workers-server/src/__tests__/spectator-payload.test.ts` — `sinceIdx` clamping, malicious-client claim, empty-relay echo-tip behaviour.
- `wiki/architecture/agent-envelope.md` — what `newMessages` (the chat plugin's projection) is and how it composes with this cursor.
- `wiki/architecture/plugin-pipeline.md` — what runs over `relayMessages` between the wire and the agent.
- `wiki/architecture/spectator-system.md` — the spectator-delay window, why broadcasts gate on `publicSnapshotIndex`.
- `wiki/architecture/identity-and-auth.md` — `POST /api/player/ws-ticket`, single-use ticket lifecycle.
