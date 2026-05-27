# Sizing Bugs and Inconsistencies — Audit

**Status:** documented, not fixed. Captures repo state as of `under-construction` branch (2026-05-26).

Audit triggered by player-visible bug: CtL "4v4" lobbies actually run as 2v2 and sometimes admit a ghost 5th player. Trail led to a tangle of layered sizing config that doesn't talk to itself. Three games, three different meanings for the same `--size` flag, and every layer applies its own bounds.

## TL;DR

- `--size` is ignored by every game. CLI clamps it, server stores it, then `LobbyDO.handleCreate` destructures it out and drops it on the floor at `LobbyDO.ts:244`. Phases use hardcoded constructor args from `plugin.ts`, never lobby-time config.
- `plugin.lobby.matchmaking.{minPlayers,maxPlayers,teamSize,numTeams}` is **dead code** — read nowhere outside tests. The constructor args on `TeamFormationPhase(...)` / `OpenQueuePhase(...)` are the actual source of truth, and they duplicate the dead matchmaking values without staying in sync.
- `OpenQueuePhase(4)` triggers at *exactly* 4 players for OATH and TotC — `maxPlayers: 20` / `maxPlayers: 6` is unreachable.
- `LobbyDO.handleJoin` adds joiners to `_agents` before checking `phase.acceptsJoins`, so a 5th player who lands during CtL's `ClassSelectionPhase` becomes a ghost — visible in the lobby, can't pick a class, defaults to team A + class `rogue` when the game starts.

## 1. Per-game sizing config

### Capture the Lobster

**Matchmaking** (`packages/games/capture-the-lobster/src/plugin.ts:787-793`):
```ts
matchmaking: {
  minPlayers: 4,
  maxPlayers: 12,
  teamSize: 2,
  numTeams: 2,
  queueTimeoutMs: 120000,
},
```

**Phases** (`plugin.ts:783-786`):
```ts
phases: [
  new TeamFormationPhase({ teamSize: 2, numTeams: 2 }),
  new ClassSelectionPhase({ validClasses: ['rogue', 'knight', 'mage'] }),
],
```

`TeamFormationPhase` stores the args as instance fields (`phases/team-formation.ts:101-107`); `init(players, _config)` accepts `_config` at `:113` but never reads it. Constructor args are baked at module load.

**Board derivation** — `createConfig` (`plugin.ts:879-897`):
```ts
const teamSizeOpt = options?.teamSize;
const teamSize =
  (typeof teamSizeOpt === 'number' ? teamSizeOpt : undefined) ??
  Math.max(
    ctlPlayers.filter((p) => p.team === 'A').length,
    ctlPlayers.filter((p) => p.team === 'B').length,
  );
const radius = getMapRadiusForTeamSize(teamSize);
```

`options.teamSize` would come from `accumulatedMetadata.teamSize` — **never written by any phase**, so always `undefined`. Falls back to counting team members. Lookup table at `map.ts:40-43`: `{2→5, 3→6, 4→7, 5→8, 6→9}`.

**Engine default conflicts with plugin default**: `game.ts:179-183` has `DEFAULT_CONFIG.teamSize = 4`; plugin says 2. If `createGameState` is called without explicit `teamSize`, the two defaults disagree.

### Oathbreaker

**Matchmaking** (`packages/games/oathbreaker/src/plugin.ts:333-339`):
```ts
matchmaking: { minPlayers: 4, maxPlayers: 20, teamSize: 1, numTeams: 0, queueTimeoutMs: 300000 },
```

**Phases** (`:332`): `phases: [new OpenQueuePhase(4)]`. The `4` is hardcoded in the constructor. `OpenQueuePhase.handleJoin` auto-completes the instant `playerIds.length >= 4` (`engine/src/phases/open-queue.ts:35-40`). The advertised `maxPlayers: 20` is unreachable.

**createConfig** (`plugin.ts:443-464`): Only reads `maxRounds`. Player count = whatever joined (i.e. always 4).

### Tragedy of the Commons (V1 and V2)

V2 is the registered plugin (`plugin.ts:715`: `registerGame(TragedyOfTheCommonsV2Plugin)`); V1 is dead.

**Matchmaking** (V2, `plugin.ts:552-558`):
```ts
matchmaking: { minPlayers: 4, maxPlayers: 6, teamSize: 1, numTeams: 0, queueTimeoutMs: 300000 },
```

**Phases** (`:551`): `phases: [new OpenQueuePhase(4)]`. Same hardcoding as OATH — always starts at 4 players.

**Board**: TotC V2 has a *fully static* board — `V2_TILE_SPECS` (19 hexes) and `V2_INTERSECTION_IDS` at `game.ts:1432-1457`. Same board regardless of player count. OK as a design constant, but worth noting that "the board doesn't scale" is the intended behavior here.

## 2. CLI: one flag, three meanings

Single option, registered once: `coga create-lobby -s, --size <n>` at `packages/cli/src/commands/game.ts:271-274`.

The help text reveals the mess:
```
Team size for CtL (2-6), player count for OATHBREAKER (4-20), or player count for Tragedy (4-6)
```

One knob, three semantics, picked by `--game`.

**Wire format** (`packages/cli/src/api-client.ts:418`): `createLobby({ gameType, teamSize })`. The field is *always* named `teamSize` even when it semantically means "player count" for FFA games.

**Per-game CLI clamps** (`game-client.ts:416-430`):
- OATH: `[4, 20]`
- TotC: `[4, 6]`
- CtL: `[2, 6]`

The server then re-clamps to `[1, 20]` (`workers-server/src/index.ts:622`) — a generic clamp that disregards game.

**MCP tool diverges from the CLI** (`mcp-tools.ts:372-407`): `create_lobby` exposes BOTH `teamSize` (z.number().min(2).max(6)) AND `playerCount` (z.number().min(4).max(20)) as separate fields, handler picks one based on `gameType`. So agents and humans see different shapes.

**Cosmetic printing** (`commands/game.ts:303, 313-315`): the CLI synthesizes "Players: 4" / "Team size: 4v4" from the local `size` variable, *not* from the server response. Even if the server honored a different value, the CLI would still print whatever you typed.

**Lobby list** (`commands/game.ts:253`): `${lobby.playerCount}/${lobby.teamSize ?? '?'} players`. Prints the raw `team_size` D1 column as the denominator. For a 2v2 CtL lobby this would render "4/2 players" once seats fill — nonsensical.

## 3. Plumbing: where size leaks out

```
coga create-lobby -s 4 -g capture-the-lobster
  │
  ▼  commands/game.ts:283            parseInt(opts.size)
  ▼  game-client.ts:428              clamp [2,6] → 4
  ▼  api-client.ts:418               POST { gameType, teamSize: 4 }
  ▼
  ▼  workers-server/src/index.ts:622  re-clamp [1,20] → 4
  ▼  D1: INSERT INTO lobbies(team_size=4, ...)   index.ts:629
  ▼  fetch LobbyDO POST '/'  body={ lobbyId, gameType, teamSize: 4, noTimeout }
       │
       ▼  LobbyDO.ts:244             const { lobbyId, gameType, noTimeout } = body
       ▼                              *** teamSize DROPPED HERE ***
       ▼  _meta = { ..., accumulatedMetadata: {} }   line 288
       ▼  firstPhase = plugin.lobby.phases[0]
       ▼                              = new TeamFormationPhase({ teamSize: 2, numTeams: 2 })  // hardcoded
       ▼  TeamFormationPhase.init(players, _config)  ignores _config

[players join, phase completes, ClassSelection runs]

       ▼  Object.assign(accumulatedMetadata, phaseResult.metadata)  line 598
       ▼                              (phases never emit teamSize key)
       ▼  doCreateGame → plugin.createConfig(players, seed, accumulatedMetadata)
            ▼  options?.teamSize → undefined → falls back to counting
```

Requested size dies at three points: CLI clamp, server clamp+D1 store, and LobbyDO destructure. None reach the phase or the game logic.

The D1 `team_size` column exists purely for display (`index.ts:571, 594, 1088, 1096`).

## 4. The ghost-player bug

`LobbyDO.handleJoin` (`packages/workers-server/src/do/LobbyDO.ts:327-400`):

```ts
// :329  outer guard
if (this._meta.phase !== 'lobby') {
  return Response.json({ error: 'Lobby not accepting joins' }, { status: 409 });
}

// :374  unconditional push
const agent: AgentEntry = { id: playerId, ... };
this._agents.push(agent);

// :383  conditional phase notification
if (phase.acceptsJoins && phase.handleJoin) {
  const result = phase.handleJoin(this._phaseState, agentInfo, this.agentInfos());
  ...
}
```

`_meta.phase` only has three values: `'lobby' | 'in_progress' | 'finished'` (`LobbyDO.ts:93`). It stays `'lobby'` across all pre-game phases including `ClassSelectionPhase` — which has `readonly acceptsJoins = false` (`phases/class-selection.ts:34`).

Net effect:
1. Lobby fills 4/4, advances to ClassSelectionPhase.
2. A 5th `/join` arrives. Outer guard passes (`_meta.phase === 'lobby'`).
3. `_agents.push(agent)` adds them. Lobby now lists 5 players.
4. `phase.acceptsJoins` is false, so `phase.handleJoin` is not called. The phase's `_phaseState.playerIds` was frozen at `init()` (`class-selection.ts:65-70`) — it still has the original 4.
5. The ghost player calls `pickClass` → `handleAction` rejects with `'Player not in class selection'` (`class-selection.ts:88-93`).
6. Timeout fires (or original 4 finish picking). `doCreateGame` runs with `_agents.length === 5`.
7. CtL's `createConfig` finds the ghost has no team metadata → defaults to team A:

```ts
// plugin.ts:864-868
ctlPlayers = enrichedPlayers.map((p) => ({
  id: p.id,
  team: (p.team ? teamIdMap[p.team] : 'A') as 'A' | 'B',
  unitClass: (p.role as UnitClass) ?? classes[0],
}));
```

Game starts 2v3 (or 2v4 if a sixth arrives). Reproduces the original symptom.

## 5. Sanity checks that ARE in place

So we know what's already guarded:

1. **CLI client-side per-game clamps** — `game-client.ts:416-430`.
2. **MCP zod schema bounds** — `mcp-tools.ts:382-395`.
3. **Worker generic clamp** — `workers-server/src/index.ts:622` (`[1, 20]`, game-agnostic).
4. **TeamFormationPhase team-full check** — `phases/team-formation.ts:337-339, 348-350, 387-389` (409 if `team.members.length >= this.teamSize`).
5. **TeamFormationPhase.maybeComplete** — `:442-481` only completes when `fullTeams.length >= numTeams`.
6. **TeamFormationPhase.handleTimeout** — `:170-257` greedy auto-merge; returns `null` (lobby fails) if it can't form `numTeams` complete teams.
7. **OpenQueuePhase min** — `engine/src/phases/open-queue.ts:35, 45`.
8. **LobbyDO outer phase guard** — `LobbyDO.ts:329, 404` (`_meta.phase !== 'lobby'`). Insufficient — see bug B2.
9. **Idempotent join across credit-check await** — `LobbyDO.ts:349-351, 370-372`.
10. **CtL `createConfig` team-id mapping** — `plugin.ts:852-868` deterministic A/B mapping.

Not present:
- No check that `teamSize * numTeams <= maxPlayers`.
- No check that CLI-requested size is compatible with the game's phase config.
- No check that a player can still join during a late-stage non-joinable phase **before** pushing to `_agents`.

## 6. Bug list (severity-sorted)

### CRITICAL — player-visible breakage

**B1. `--size` is ignored everywhere.**
- CtL "4v4" runs as 2v2; OATH/TotC start at exactly 4 regardless.
- Chain: CLI clamps → Worker stores in D1 + forwards → LobbyDO destructure at `LobbyDO.ts:244` drops it → phase constructor args at module-load time are the only source of truth.
- Fix sketch: pass `teamSize` to LobbyDO meta; write into `accumulatedMetadata.teamSize` (and `.numTeams`, `.playerCount` as appropriate); make phases read it in `init()` from `_config` instead of constructor args. Or replace `new TeamFormationPhase({ teamSize: 2, numTeams: 2 })` with `new TeamFormationPhase()` and pass sizing via metadata.

**B2. Ghost-player during ClassSelection.**
- 5th joiner during ClassSelectionPhase is added to `_agents` but not to the phase's internal player list. Lobby shows them; they can't act; game starts with team A getting the freebie.
- `LobbyDO.ts:374-393`. Root cause: `_meta.phase` is too coarse (only `lobby|in_progress|finished`).
- Fix sketch: gate `_agents.push` on `phase.acceptsJoins`, OR refine `_meta.phase` to track "lobby-open" vs "lobby-closed", OR check `phase.acceptsJoins` in the outer guard at `LobbyDO.ts:329`.

**B3. OATH/TotC max-players unreachable.**
- `OpenQueuePhase(4)` completes at exactly 4. Advertised maxima of 20 (OATH) and 6 (TotC) never happen.
- `engine/src/phases/open-queue.ts:35-40`. Subsequent joins hit `_meta.phase === 'in_progress'` and 409.
- Fix sketch: `OpenQueuePhase` needs to know a *target* count (e.g. `playerCount` from lobby metadata) and complete on full, not on min. Or introduce a "queue with grace window" phase.

**B4. CtL `createConfig` silently defaults un-teamed players to team A.**
- `plugin.ts:864-868`. Any agent without team metadata gets team A. Papers over B2 by making the game *start* but with broken balance.
- Fix sketch: throw if `hasTeams && !p.team` — that's a lobby-state bug, not something to default through.

**B5. `matchmaking` config is dead code.**
- `plugin.lobby.matchmaking.{minPlayers,maxPlayers,teamSize,numTeams}` is read only by tests. The phase constructor args duplicate these values out-of-sync. Looks authoritative, isn't.
- Fix sketch: wire it into phase init (preferred) or delete and rely on phase args only.

### MEDIUM — display/info wrong

**B6. CLI prints clamped local value as truth.**
- `commands/game.ts:303, 313-315` print from the local `size` var. Doesn't reflect what the server actually used (which today is "nothing", but still).
- Fix sketch: print `result.teamSize` / a `result.capacity` field that the server actually computes.

**B7. Lobby list denominator is wrong.**
- `commands/game.ts:253`: `${playerCount}/${teamSize ?? '?'} players` — uses `team_size` (the requested team size) as capacity. For a 4-player FFA lobby, prints "4/4" (right by accident); for a 2v2 CtL lobby, would print "4/2".
- Fix sketch: add `capacity` to `/api/lobbies` response, derived server-side from the phase config.

**B8. OATH plugin guide references non-existent tools.**
- `oathbreaker/src/plugin.ts:108`: "Tools: lobbies, join_oathbreaker(gameId), create_oathbreaker(playerCount)". Actual tool: `create_lobby` with `playerCount` param.

**B9. CtL plugin guide promises 2v2-to-6v6.**
- `plugin.ts:363`: "Team sizes from 2v2 up to 6v6. Larger teams get larger maps." Promises configurability that B1 prevents.

### COSMETIC / latent

**B10. CtL `teamSize` defaults disagree.**
- `game.ts:179-183`: `DEFAULT_CONFIG.teamSize = 4`. Plugin matchmaking + phase constructor: 2. If `createGameState` is ever called without an explicit `teamSize`, the engine and plugin defaults clash.

**B11. `fill-bots.ts` derives capacity client-side, wrong for TotC.**
- `scripts/fill-bots.ts:34-36`: `gameType === 'oathbreaker' ? teamSize : teamSize * 2`. TotC is FFA — capacity should equal `teamSize`, not double it. The comment on `:33` already acknowledges "Future cleanup: add capacity to /api/lobbies".

**B12. Worker clamp `[1, 20]` is game-agnostic.**
- `workers-server/src/index.ts:622`. 1 is too low for any game; 20 is too high for CtL and TotC. No per-game validation at the API boundary.

**B13. CtL has 10+ copies of `teamSize`.**
- Plugin matchmaking field, phase constructor arg, engine `DEFAULT_CONFIG`, D1 column, CLI flag, CLI clamp, MCP schema, Worker clamp, `accumulatedMetadata` key (unused), `createConfig` derivation. Each layer applies its own bounds; none communicate.

**B14. `_meta.phase` is too coarse.**
- Only `'lobby' | 'in_progress' | 'finished'` at `LobbyDO.ts:93`. Cannot represent "in lobby, joins closed". The per-phase `acceptsJoins` flag exists but is only consulted *after* `_agents.push`.

## 7. Hardcoded sizing — full table

| File:line | Value | Configurable? |
|-----------|-------|---------------|
| `games/capture-the-lobster/src/plugin.ts:784` | `TeamFormationPhase({ teamSize: 2, numTeams: 2 })` | **YES — must derive from create-body** |
| `games/capture-the-lobster/src/plugin.ts:790-791` | `matchmaking.teamSize: 2, numTeams: 2` | YES, or delete (dead code) |
| `games/capture-the-lobster/src/phases/team-formation.ts:99` | `timeout = 600` | maybe |
| `games/capture-the-lobster/src/phases/class-selection.ts:35` | `timeout = 600` | maybe |
| `games/capture-the-lobster/src/game.ts:179-183` | `DEFAULT_CONFIG.teamSize = 4` | inconsistent with plugin default (2) |
| `games/capture-the-lobster/src/map.ts:40-43` | `{2→5, 3→6, 4→7, 5→8, 6→9}` radius table | reasonable to keep |
| `games/capture-the-lobster/src/map.ts:46-48` | `flagCount = teamSize >= 5 ? 2 : 1` | OK as a design rule |
| `games/capture-the-lobster/src/map.ts:104-106` | `radius default 8, wallDensity 0.15` | wallDensity should be exposed |
| `games/capture-the-lobster/src/game.ts:175-177` | `turnLimit = 20 + radius * 2` | should be lobby-configurable |
| `games/oathbreaker/src/plugin.ts:332` | `OpenQueuePhase(4)` | **YES** |
| `games/oathbreaker/src/plugin.ts:335-336` | `minPlayers: 4, maxPlayers: 20` (dead) | YES or delete |
| `games/tragedy-of-the-commons/src/plugin.ts:208, 551` | `OpenQueuePhase(4)` | **YES** |
| `games/tragedy-of-the-commons/src/plugin.ts:211-212, 553-554` | `minPlayers: 4, maxPlayers: 6` (dead) | YES or delete |
| `games/tragedy-of-the-commons/src/types.ts:161-166` | `DEFAULT_TRAGEDY_CONFIG.maxRounds = 12, turnTimerSeconds = 60` | could expose via CLI |
| `games/tragedy-of-the-commons/src/game.ts:1432-1457` | `V2_TILE_SPECS` 19 fixed hexes | OK (design constant) |
| `workers-server/src/index.ts:622` | clamp `[1, 20]` for teamSize | should be per-game |
| `cli/src/game-client.ts:421, 425, 428` | per-game clamps | could move server-side |
| `cli/src/mcp-tools.ts:382-395` | z.number ranges | duplicated from CLI |
| `scripts/fill-bots.ts:34-36` | per-game capacity formula | should come from server `capacity` field |

## 8. Suggested order of operations for a cleanup

If we tackle this, here's the natural sequence (cheapest → most invasive):

1. **B2** (ghost-player gate): one-line fix in `LobbyDO.handleJoin` — gate `_agents.push` on `phase.acceptsJoins && phase !== this.currentPhase`. Stops bleeding immediately.
2. **B4** (silent team-A default): throw in `createConfig` instead. Surfaces B2 if it recurs.
3. **B1** (the main one): plumb `teamSize`/`playerCount` from create-body through LobbyDO into `accumulatedMetadata` and have `TeamFormationPhase` / `OpenQueuePhase` read it from `_config` in `init()`. Several files but no architectural change.
4. **B3** (OATH/TotC unreachable max): `OpenQueuePhase` needs a target count, not just a min. Or a new phase type.
5. **B5/B13** (dead config + duplication): delete `matchmaking.{teamSize,numTeams}` from each plugin if we've fully wired phase configs; or wire matchmaking into phase init and delete the constructor args. Pick one source of truth.
6. **B6/B7/B11** (display lies): add `capacity` to `/api/lobbies` response, computed once server-side; CLI prints that. Removes `fill-bots.ts` per-game branching.
7. **B14** (refine `_meta.phase`): if B2 was solved at the outer guard level, fold `acceptsJoins` into the meta phase enum (`lobby-open | lobby-closed | in_progress | finished`).

Per the pre-launch policy (no backwards-compat shims), each of these is a single-PR rewrite, no migrations.

## 9. Open design question

The deeper inconsistency: **CtL is team-shaped, OATH/TotC are FFA-shaped**, but they share a single `teamSize` field on the wire and a single `--size` flag in the CLI. Three options:

a) **Keep one field, document the overload.** Cheap, current state, ugly.
b) **Two fields on the wire (`teamSize`/`numTeams` OR `playerCount`).** CLI/MCP already inconsistent on this — MCP has both, CLI has one. Pick MCP's shape.
c) **Generalize:** plugins declare a `lobbyShape` schema (`{ teams: [{ size }] }` or `{ ffa: { size } }`), CLI prompts based on shape. Most work, cleanest result.

`docs/plans/create-coordination-game.md` already exists for the broader plugin-isolation question — sizing belongs in that conversation.
