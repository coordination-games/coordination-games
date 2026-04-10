# Generic Lobby Phase Runner

**Status: PROPOSED** (2026-04-10)

## Problem

The LobbyDO reimplements lobby logic inline instead of using the engine's `LobbyPhase` pipeline. It hardcodes:
- 2-team A/B structure (`PreGamePlayer.team: 'A' | 'B'`, `chatA`/`chatB`)
- CtL-specific routes (`/team/propose`, `/team/accept`, `/class`)
- A `forming → pre_game → starting → game` state machine that only fits CtL
- `hasPhases` boolean that special-cases OATHBREAKER as "no phases"

Meanwhile, the engine already defines `LobbyPhase`, `PhaseContext`, `PhaseResult`, and `GameLobbyConfig.phases[]`. CtL already has `TeamFormationPhase` and `ClassSelectionPhase` implementations. None of this is used on the server.

The game-time `GameRoomDO` is clean — fully plugin-driven, no game-specific code. The lobby is the remaining architectural debt.

### Additional issues discovered in review (addressed by this plan)
- **Security:** Lobby endpoints (`/team/propose`, `/chat`, `/class`, etc.) have no auth — anyone can POST with a fabricated `agentId` and impersonate players
- **Security:** `/api/lobbies/create` and `/api/games/create` are unauthenticated
- **Security:** `/api/games/:id` catch-all forwards to GameRoomDO without auth, leaking fog-of-war state
- **Hardcoded game list** in `index.ts:68` — `games: ['capture-the-lobster', 'oathbreaker']` should use registry
- **Lobby chat** is inline, not routed through ToolPlugin system
- **Dead code:** `handlePlayerGuide` returns placeholder text, `GIT_SHA = 'phase-6'`, root `package.json` scripts reference deleted `packages/server`
- **Type safety:** 25+ `let body: any` across workers-server, unsafe `as any` spreads
- **Duplication:** JSON body parsing repeated ~12 times, `validateBearerToken` called identically 9 times

## Design Decisions

### Every game declares at least one lobby phase

No empty `phases: []`. A lobby always has phases to run. OATHBREAKER's lobby is a single `OpenQueuePhase` — a built-in engine phase that collects players until `minPlayers` is met, then completes. This eliminates the `hasPhases` boolean and all special-casing.

**Why not empty phases?** An empty array means "no lobby behavior at all" — but every game needs *some* lobby behavior (collecting players, chat, countdown). Making it explicit means the phase runner has one code path, not two. The `OpenQueuePhase` is ~30 lines: wait for `minPlayers`, auto-advance. Games that want chat during waiting just include `basic-chat` in `requiredPlugins` — chat works the same in lobby and game phases via the typed relay.

### No phase registry — phases are instances on the lobby config

The architecture review correctly identified that a global mutable phase registry (like the game registry) is over-engineering. Phases are only referenced by the game that declares them. There's no cross-game phase reuse scenario.

Instead, `GameLobbyConfig.phases` contains phase **instances** directly:

```typescript
// In capture-the-lobster plugin.ts
import { TeamFormationPhase } from './phases/team-formation.js';
import { ClassSelectionPhase } from './phases/class-selection.js';

lobby: {
  queueType: 'open',
  phases: [
    new TeamFormationPhase({ autoMergeOnTimeout: true }),
    new ClassSelectionPhase({ defaultRotation: ['rogue', 'knight', 'mage'] }),
  ],
  matchmaking: { ... },
}
```

```typescript
// In oathbreaker plugin.ts
import { OpenQueuePhase } from '@coordination-games/engine';

lobby: {
  queueType: 'open',
  phases: [new OpenQueuePhase()],
  matchmaking: { ... },
}
```

The `OpenQueuePhase` is a plain export from the engine — no registry needed. Game plugins import their own phases directly. The LobbyDO reads `plugin.lobby.phases` and gets live instances.

**Why this is better:** No global state, no side-effect imports for phases, no string-ID lookup, no risk of forgetting to register. The phase IS the config.

### Lobby tools use the same ToolPlugin system as games

Currently lobby chat is hardcoded (`_chat`, `chatA`, `chatB` arrays, inline `/chat` endpoint). This should go through the typed relay just like game chat:

1. Agent calls `chat({ message, scope })` via MCP or CLI
2. CLI POSTs to `POST /api/lobbies/:id/tool` with `{ pluginId: "basic-chat", tool: "chat", args }`
3. LobbyDO looks up the plugin, calls `handleCall()`, gets back `{ relay: { type, data, scope, pluginId } }`
4. LobbyDO stores relay message, routes by scope, broadcasts to spectators
5. Other agents pick up messages via `GET /state` or WS

**Team-scoped chat during team formation:** The phase owns team membership. When the relay routes a `scope: "team"` message, the LobbyDO needs to know which players are on which team. Solution: `LobbyPhase` has an optional `getTeamForPlayer(state, playerId): string | null` method. If the phase implements it, team-scoped relay uses it. If not (e.g. `OpenQueuePhase`), team scope falls back to "all". This keeps team knowledge in the phase, not the DO.

**Phase-specific tools:** Each `LobbyPhase` declares `tools?: ToolDefinition[]`. These are tools that only exist during that phase. Example: `TeamFormationPhase` declares `propose_team`, `accept_team`, `leave_team`. `ClassSelectionPhase` declares `choose_class`. The LobbyDO exposes only the tools from the current phase + always-on plugin tools (chat).

### Keep separate DOs for lobby and game

- **Different lifecycles.** Lobby: minutes of player accumulation, then done. Game: potentially long, different state shape.
- **Different tool sets.** Lobby phases have formation tools; games have action tools.
- **Clean handoff.** LobbyDO collects accumulated `PhaseResult.metadata` from all phases, passes to `plugin.createConfig(players, seed)`, creates GameRoomDO. One POST.
- **Independent cleanup.** Lobby D1 rows can be cleaned up when the game starts.

### Phase state lives in DO storage, not in-memory

Each phase's state is serialized to DO storage so phases survive DO eviction/restart. The phase runner loads current phase + state on every request via `blockConcurrencyWhile` in `ensureLoaded()` — same pattern as the current LobbyDO. This guarantees no concurrent request races on phase state (DOs are single-threaded per request within a `blockConcurrencyWhile` block, but hibernation can cause concurrent wake-ups without it).

## Architecture

### Engine changes (packages/engine/src/)

#### Evolve `LobbyPhase` to be request-driven (not `async run()`)

The current `LobbyPhase.run()` is a long-running async function — it awaits player actions. This doesn't work in a Durable Object where each HTTP request is a separate invocation. Instead, phases need to be request-driven:

```typescript
/** A single phase in the lobby pipeline (request-driven). */
export interface LobbyPhase<TPhaseState = any> {
  readonly id: string;
  readonly name: string;

  /** Tools available during this phase (beyond always-on plugin tools). */
  readonly tools?: ToolDefinition[];

  /** Timeout in seconds. null = no timeout (rely on lobby-level timeout). */
  readonly timeout?: number | null;

  /**
   * Does this phase accept new players mid-phase?
   * true = handleJoin() will be called. false = joins rejected during this phase.
   * Default: false.
   */
  readonly acceptsJoins?: boolean;

  /** Create initial state for this phase. */
  init(players: AgentInfo[], config: Record<string, any>): TPhaseState;

  /**
   * Handle a player action during this phase.
   * Returns updated state + optional phase completion signal.
   *
   * Errors should be returned via the `error` field, not thrown.
   * The LobbyDO translates `error` into an HTTP 400/409 response.
   */
  handleAction(
    state: TPhaseState,
    action: { playerId: string; tool: string; args: Record<string, any> },
    players: AgentInfo[],
  ): PhaseActionResult<TPhaseState>;

  /**
   * Handle a player joining mid-phase.
   * Only called if `acceptsJoins` is true.
   */
  handleJoin?(
    state: TPhaseState,
    player: AgentInfo,
    allPlayers: AgentInfo[],
  ): PhaseActionResult<TPhaseState>;

  /**
   * Handle timeout expiry.
   * Must produce a PhaseResult (possibly with removed players) or null to fail the lobby.
   */
  handleTimeout(state: TPhaseState, players: AgentInfo[]): PhaseResult | null;

  /**
   * Build the lobby state view for a given player (or spectator if null).
   * This is what gets returned in GET /state under `currentPhase.view`.
   */
  getView(state: TPhaseState, playerId: string | null): unknown;

  /**
   * Optional: resolve team membership for relay routing.
   * If omitted, team-scoped messages fall back to "all" scope.
   */
  getTeamForPlayer?(state: TPhaseState, playerId: string): string | null;
}

/** Result of handling an action within a phase. */
export interface PhaseActionResult<TPhaseState = any> {
  /** Updated phase state. */
  state: TPhaseState;
  /** If set, this phase is complete. Advance to next or start game. */
  completed?: PhaseResult;
  /** Relay messages to broadcast (chat, team updates, etc.). */
  relay?: Array<{ type: string; data: unknown; scope: string; pluginId: string }>;
  /** If set, the action failed. LobbyDO returns this as an HTTP error response. */
  error?: { message: string; status?: number };
}

/** Result when a phase completes. */
export interface PhaseResult {
  /** Players grouped for next phase or game start.
   *  For team games: each group = a team.
   *  For FFA: single group with all players.
   */
  groups: AgentInfo[][];
  /**
   * Data collected during the phase.
   * MUST include player-level assignments that createConfig() needs.
   * E.g. TeamFormation: { teams: [{ id, members }] }
   * E.g. ClassSelection: { classPicks: { [playerId]: 'rogue' | 'knight' | 'mage' } }
   */
  metadata: Record<string, any>;
  /** Players removed during this phase. */
  removed?: AgentInfo[];
}
```

**Delete:** The existing `PhaseContext`, `RelayAccess`, old `LobbyPhase.run()`, `LobbyPipeline` class, and `lobby-pipeline.test.ts` — all dead code.

**Update `GameLobbyConfig`:**
```typescript
export interface GameLobbyConfig {
  queueType: 'open' | 'stake-tiered' | 'invite';
  /** Phase instances. Every game must have at least one. */
  phases: LobbyPhase[];  // Changed from LobbyPhaseConfig[] to LobbyPhase[]
  matchmaking: MatchmakingConfig;
}
```

No more `LobbyPhaseConfig` with string `phaseId` + generic `config` bag. Phases are instances with their config baked in at construction time.

#### Built-in `OpenQueuePhase`

```typescript
// packages/engine/src/phases/open-queue.ts

interface OpenQueueState {
  minPlayers: number;
  maxPlayers: number;
}

export class OpenQueuePhase implements LobbyPhase<OpenQueueState> {
  readonly id = 'open-queue';
  readonly name = 'Open Queue';
  readonly tools = [];
  readonly acceptsJoins = true;

  constructor(private config: { minPlayers?: number; maxPlayers?: number } = {}) {}

  init(players: AgentInfo[]) {
    return {
      minPlayers: this.config.minPlayers ?? 4,
      maxPlayers: this.config.maxPlayers ?? 20,
    };
  }

  handleAction(state: OpenQueueState) {
    return { state };  // No phase-specific actions
  }

  handleJoin(state: OpenQueueState, player: AgentInfo, allPlayers: AgentInfo[]) {
    if (allPlayers.length >= state.minPlayers) {
      return {
        state,
        completed: {
          groups: [allPlayers],
          metadata: {},
        },
      };
    }
    return { state };
  }

  handleTimeout(state: OpenQueueState, players: AgentInfo[]) {
    if (players.length >= state.minPlayers) {
      return { groups: [players], metadata: {} };
    }
    return null;  // Not enough players — lobby fails
  }

  getView(state: OpenQueueState) {
    return { minPlayers: state.minPlayers, maxPlayers: state.maxPlayers };
  }
}
```

### LobbyDO rewrite (packages/workers-server/src/do/LobbyDO.ts)

The LobbyDO becomes a **generic phase runner**. It doesn't know about teams, classes, or any game-specific concepts.

#### Storage shape

```typescript
interface LobbyMeta {
  lobbyId: string;
  gameType: string;
  /** Index into the game plugin's lobby.phases array. */
  currentPhaseIndex: number;
  /** Accumulated metadata from completed phases. Merged into createConfig() at game start. */
  accumulatedMetadata: Record<string, any>;
  /** High-level state: running phases, creating game, game started, or failed. */
  phase: 'running' | 'starting' | 'game' | 'failed';
  createdAt: string;
  deadlineMs: number | null;
  gameId: string | null;
  error: string | null;
  noTimeout: boolean;
}
```

Phase instances come from `getGame(gameType).lobby.phases[currentPhaseIndex]` — not stored, resolved live from the plugin. Only the opaque `phaseState: any` (serialized JSON) is stored in DO storage.

No `PreGamePlayer`, no `TeamEntry`, no `chatA`/`chatB`. Phase-specific state is opaque to the DO.

#### Routes

| Old (hardcoded) | New (generic) |
|---|---|
| `POST /team/propose` | `POST /action` — `{ playerId, tool, args }` |
| `POST /team/accept` | `POST /action` — dispatched to `currentPhase.handleAction()` |
| `POST /team/leave` | `POST /action` |
| `POST /class` | `POST /action` |
| `POST /chat` | `POST /tool` — `{ pluginId: "basic-chat", tool: "chat", args }` |
| `POST /join` | `POST /join` — unchanged, but calls `phase.handleJoin()` if `acceptsJoins` |
| `GET /state` | `GET /state` — returns `phase.getView()` under `currentPhase` key |

Final route set:
- `POST /` — create (resolve plugin, init first phase from `plugin.lobby.phases[0]`)
- `POST /join` — add player. If `currentPhase.acceptsJoins`, call `handleJoin()`. Otherwise reject.
- `POST /action` — validate playerId is in lobby, call `currentPhase.handleAction()`, handle phase completion
- `POST /tool` — plugin tool call (chat, etc.) via typed relay. Uses `currentPhase.getTeamForPlayer()` for team routing.
- `GET /state` — returns `{ lobbyId, gameType, agents, currentPhase: { id, name, view }, gameId?, error? }`
- `DELETE /` — disband
- `WS /` — spectator feed

#### Phase transition logic

```
on PhaseActionResult with completed set:
  1. Merge completed.metadata into accumulatedMetadata
  2. Remove completed.removed players from agent list
  3. If currentPhaseIndex + 1 < phases.length:
     - currentPhaseIndex++
     - nextPhase = plugin.lobby.phases[currentPhaseIndex]
     - phaseState = nextPhase.init(playersFromGroups, accumulatedMetadata)
     - Set alarm for nextPhase.timeout (if set)
     - Save state, broadcast update
  4. Else (all phases done):
     - doCreateGame()
```

#### `doCreateGame()` — metadata → player entries

The plan must transform accumulated metadata into the `{ id, handle, team?, role? }[]` format that `plugin.createConfig()` expects. This is where phase metadata gets unpacked:

```typescript
private buildPlayerEntries(): PlayerEntry[] {
  // accumulatedMetadata.teams = [{ id: 'team-1', members: ['p1', 'p2'] }, ...]
  // accumulatedMetadata.classPicks = { p1: 'rogue', p2: 'knight', ... }
  const teamMap = new Map<string, string>();
  for (const team of (this._accumulatedMetadata.teams ?? [])) {
    for (const memberId of team.members) {
      teamMap.set(memberId, team.id);
    }
  }
  const classPicks = this._accumulatedMetadata.classPicks ?? {};

  return this._agents.map(a => ({
    id: a.id,
    handle: a.handle,
    team: teamMap.get(a.id),
    role: classPicks[a.id],
  }));
}
```

This is still generic — the LobbyDO doesn't know what "teams" or "classPicks" mean. It just passes `accumulatedMetadata` through. The convention is that `createConfig()` knows what keys to expect from its own phases' metadata output.

#### Error handling from phases

When `handleAction()` returns an `error`, the LobbyDO translates it:
```typescript
const result = currentPhase.handleAction(phaseState, action, players);
if (result.error) {
  return Response.json({ error: result.error.message }, { status: result.error.status ?? 400 });
}
```

This preserves the current UX where `propose_team` with a full team returns 409, etc.

#### Concurrency

The existing `blockConcurrencyWhile` pattern in `ensureLoaded()` carries forward unchanged. All phase state mutations happen within a single request after `ensureLoaded()` completes, same as today.

### CLI changes (packages/cli/) — MUST ship with LobbyDO rewrite

The CLI currently hardcodes lobby tools as fixed MCP tools with dedicated REST calls:

```
packages/cli/src/mcp-tools.ts:211 — propose_team → client.proposeTeam()
packages/cli/src/mcp-tools.ts:225 — accept_team → client.acceptTeam()
packages/cli/src/mcp-tools.ts:239 — leave_team → client.leaveTeam()
packages/cli/src/mcp-tools.ts:253 — choose_class → client.chooseClass()
```

```
packages/cli/src/game-client.ts:175 — proposeTeam() → POST /api/player/team/propose
packages/cli/src/game-client.ts:181 — acceptTeam() → POST /api/player/team/accept
packages/cli/src/game-client.ts:187 — leaveTeam() → POST /api/player/team/leave
packages/cli/src/game-client.ts:193 — chooseClass() → POST /api/player/class
```

**Replace with dynamic lobby tools:**

1. `GameClient` gets a new method: `lobbyAction(tool: string, args: Record<string, any>)` → `POST /api/lobbies/:id/action`
2. `GameClient` gets: `lobbyTool(pluginId: string, tool: string, args: Record<string, any>)` → `POST /api/lobbies/:id/tool`
3. MCP tool registration becomes dynamic: when in lobby phase, the CLI fetches `GET /api/lobbies/:id/state` which includes `currentPhase.tools[]`. The CLI registers these as MCP tools, routing through `lobbyAction()`.
4. Delete `proposeTeam()`, `acceptTeam()`, `leaveTeam()`, `chooseClass()` and their hardcoded MCP tool registrations.

### Scripts (scripts/) — MUST update

**`scripts/run-game.ts`** — `completeLobbyPhases()` (line 185-241) uses hardcoded endpoints:
- `POST /api/player/team/propose` → becomes `POST /api/lobbies/:id/action` with `{ tool: 'propose_team', args: { target } }`
- `POST /api/player/team/accept` → becomes `POST /api/lobbies/:id/action` with `{ tool: 'accept_team', args: { teamId } }`
- `POST /api/player/class` → becomes `POST /api/lobbies/:id/action` with `{ tool: 'choose_class', args: { unitClass } }`
- Phase polling (`waitForPhase`) needs to check `state.currentPhase.id` instead of `state.phase`

**`scripts/spawn-bots.sh`** — Uses `/api/player/lobby/join` (ok) but needs a token for lobby creation once auth is added.

### Worker routing changes (packages/workers-server/src/index.ts)

1. **Auth on lobby routes:** All `POST /api/lobbies/:id/*` routes go through Bearer validation before forwarding. Inject `X-Player-Id` header — same pattern as GameRoomDO player routes.
2. **Auth on create routes:** `POST /api/lobbies/create` requires a valid session. Remove `POST /api/games/create` as a public endpoint — games are only created by LobbyDO internally.
3. **Remove `dispatchLobbyAction()` switch.** All lobby actions go to the generic `/action` route.
4. **Add `/api/lobbies/:id/tool`** for plugin tools during lobby.
5. **Fix hardcoded game list:** Replace `games: ['capture-the-lobster', 'oathbreaker']` with `getRegisteredGames()`.
6. **Fix game catch-all:** The `/api/games/:id` catch-all (line 123-129) must NOT forward authenticated player paths (`/state?playerId=`) without auth. Only forward unauthenticated spectator paths.
7. **Extract `parseJsonBody<T>()`** helper — kills ~12 repetitions.
8. **Extract auth middleware** — `requireAuth(request, env)` returns `{ playerId }` or 401.

### Frontend changes (packages/web/) — MUST ship with LobbyDO rewrite

The frontend hard-codes the current state shape throughout and **cannot be deployed separately from the LobbyDO rewrite**:

- `LobbyPage.tsx:16-29` — `LobbyState` type with `phase: 'forming' | 'pre_game' | ...`, `teams`, `preGame`, `chatA`/`chatB`
- `LobbyPage.tsx:168, 176, 246, 289, 294, 302, 316, 323` — `state.phase` comparisons against old phase strings
- `LobbiesPage.tsx:90` — filters by `l.phase !== 'game'` using old phase strings
- `LobbiesPage.tsx:262-285` — `lobbyPhaseBadge()` hardcodes `'forming'` and `'pre_game'`

**New lobby state shape:**
```typescript
interface LobbyState {
  lobbyId: string;
  gameType: string;
  agents: AgentInfo[];
  currentPhase: {
    id: string;     // e.g. 'team-formation', 'open-queue'
    name: string;   // e.g. 'Team Formation', 'Open Queue'
    view: unknown;  // Phase-specific view data
  };
  relay: RelayMessage[];  // Chat and other relay data
  gameId?: string;        // Set when game starts
  error?: string;
  deadlineMs?: number;
}
```

**Frontend renders based on `currentPhase.id`:**
- `team-formation` → `TeamPanel` component (already exists)
- `class-selection` → `ClassSelectionPanel` component (new, extracted from current pre-game UI)
- `open-queue` → just `PlayerList` + `ChatPanel`

**D1 phase values:** The `lobbies.phase` column currently stores `'forming'` / `'pre_game'`. This changes to `'running'` (all active phases) / `'starting'` / `'game'` / `'failed'`. The `LobbiesPage` filter query and the `lobbyPhaseBadge()` function must update accordingly.

**WS message format:** `broadcastUpdate()` sends `{ type: 'lobby_update', data: LobbyState }`. The shape changes, so the `LobbyPage` WS handler must be updated to parse the new format.

### Cleanup (bundled in same PR)

- **Dead code:** Remove `GIT_SHA = 'phase-6'` placeholder, fix `handlePlayerGuide` stub, remove stale `packages/server` references from root `package.json` scripts
- **Dead engine code:** Remove `LobbyPipeline` class, `PhaseContext`, `RelayAccess`, `LobbyPhaseConfig`, and `lobby-pipeline.test.ts`
- **Type safety pass:** Replace `let body: any` with typed interfaces for each endpoint's expected body shape
- **Unsafe spreads:** Remove `...(visible as any)` in GameRoomDO, type properly
- **Frontend `api.ts`:** Type return values (`fetchLobbies(): Promise<LobbySummary[]>`, etc.)

## Implementation Order

Because the LobbyDO rewrite, frontend, CLI, and scripts all depend on the same state shape change, they must ship as an atomic unit. The commits are ordered for reviewability, not independent deployability.

### Commit 1: Engine — request-driven LobbyPhase + OpenQueuePhase

Files: `packages/engine/src/types.ts`, new `packages/engine/src/phases/open-queue.ts`, engine barrel export

- Replace `LobbyPhase` interface with request-driven version (`init`/`handleAction`/`handleJoin`/`handleTimeout`/`getView`/`getTeamForPlayer`)
- Add `PhaseActionResult` type with `error` field
- Change `GameLobbyConfig.phases` from `LobbyPhaseConfig[]` to `LobbyPhase[]`
- Delete dead types: `PhaseContext`, `RelayAccess`, `LobbyPhaseConfig`
- Delete `LobbyPipeline` class and its tests
- Implement `OpenQueuePhase` as a class export

### Commit 2: Game plugins — rewrite phases, update lobby configs

Files: `packages/games/capture-the-lobster/src/phases/team-formation.ts`, `.../class-selection.ts`, `.../plugin.ts`, `packages/games/oathbreaker/src/plugin.ts`

- Rewrite `TeamFormationPhase` as a class implementing request-driven `LobbyPhase`:
  - Move team propose/accept/leave logic from LobbyDO into `handleAction()` dispatch
  - Handle-to-ID resolution in `handleAction()` using `players` param
  - `getView()` returns teams, invites, pending state
  - `getTeamForPlayer()` returns team ID for relay routing
  - `acceptsJoins = true` (players can join during formation)
  - Completion condition: `numTeams` full teams
- Rewrite `ClassSelectionPhase` similarly:
  - `handleAction()` handles `choose_class` tool
  - `acceptsJoins = false` (no new players during class selection)
  - Completion condition: all players have chosen
- Update CtL `lobby.phases` to `[new TeamFormationPhase(...), new ClassSelectionPhase(...)]`
- Update OATHBREAKER `lobby.phases` to `[new OpenQueuePhase()]`

### Commit 3: LobbyDO + index.ts + CLI + frontend + scripts (atomic)

This is the big commit — all consumers of the lobby API change together.

**LobbyDO.ts:**
- Replace all game-specific state with `LobbyMeta` + opaque `phaseState`
- Replace hardcoded routes with `/action`, `/tool`, `/join`, `/state`
- Phase transition logic reading from `plugin.lobby.phases[]` directly
- Relay buffer for plugin tool calls (same pattern as GameRoomDO)
- `getTeamForPlayer()` for team-scoped relay routing
- Error propagation from `PhaseActionResult.error`

**index.ts:**
- Auth on all lobby mutation endpoints (inject `X-Player-Id`)
- Remove `dispatchLobbyAction()` switch
- Add `/api/lobbies/:id/tool` route
- Fix game catch-all auth bypass
- Extract `parseJsonBody<T>()` and `requireAuth()` helpers
- Fix hardcoded game list → `getRegisteredGames()`

**CLI (mcp-tools.ts, game-client.ts):**
- Replace hardcoded lobby tools with dynamic `lobbyAction()`/`lobbyTool()` methods
- MCP tools for lobby phases come from `state.currentPhase.tools`

**Frontend (LobbyPage.tsx, LobbiesPage.tsx, api.ts):**
- Update `LobbyState` type to new shape with `currentPhase: { id, name, view }`
- Update all phase comparisons
- Update `lobbyPhaseBadge()` for new phase strings
- Update WS handler for new message format
- Type API return values

**Scripts (run-game.ts, spawn-bots.sh):**
- Update `completeLobbyPhases()` to use generic `/action` endpoint
- Update phase polling to check `currentPhase.id`

### Commit 4: Cleanup

- Dead code removal (GIT_SHA, handlePlayerGuide, stale package.json scripts)
- Type safety pass on remaining `any` types
- Unsafe spread removal in GameRoomDO

## What Does NOT Change

- **GameRoomDO** — already clean, no game-specific code
- **CoordinationGame interface** — `createConfig`, `applyAction`, etc. unchanged
- **Client-side plugin pipeline** — CLI processes relay messages the same way
- **On-chain contracts** — settlement, attestations, balance unchanged
- **Spectator plugin architecture** — per-game SpectatorView components unchanged
- **D1 schema** — tables unchanged (only stored phase string values change)

## Critique Log

This plan was reviewed by two sub-agents and revised:

**Architecture critique:** (1) `handleAction` needs `error` field for proper HTTP error responses — added. (2) Phase registry is over-engineering — eliminated, phases are now instances on the config. (3) `acceptsJoins` must be explicit per-phase to prevent joins during wrong phases — added as a boolean. (4) `OpenQueuePhase` needs countdown/waiting semantics, not instant-complete — the forming timeout alarm on the LobbyDO handles this (it's lobby-level, not phase-level). (5) Team-scoped relay needs `getTeamForPlayer()` on phases — added. (6) Simpler alternative (extract pure functions, keep LobbyDO shell) considered but rejected: it's 80% of the benefit but doesn't solve the core problem of making lobbies work for N games without touching the DO.

**Feasibility critique:** (1) Frontend hard-codes state shape — cannot ship LobbyDO separately from frontend. Fixed: commits 3 is atomic. (2) D1 `lobbies.phase` column values change — covered in frontend section. (3) `run-game.ts` and `spawn-bots.sh` use hardcoded endpoints — covered in scripts section. (4) `accumulatedMetadata → createConfig()` mapping under-specified — added `buildPlayerEntries()` section. (5) CLI MCP tools are hardcoded — covered in CLI section. (6) WS spectator format changes — covered in frontend section. (7) `LobbyPipeline` and tests become dead code — covered in commit 1 cleanup.
