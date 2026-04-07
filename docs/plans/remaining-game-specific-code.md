# Remaining Game-Specific Server Code

**Status: IN PROGRESS**

## The Problem

After the unification refactor, ALL runtime game interaction goes through the generic plugin interface. But game *creation* still has game-specific code in the server:

### Three functions with hardcoded game knowledge

1. **`promoteWaitingRoom()`** (line ~1757) — Builds config when waiting room fills:
   ```typescript
   if (gameType === 'oathbreaker') {
     config = { ...DEFAULT_OATH_CONFIG, playerIds, seed };
   }
   ```

2. **`createBotGame()`** (line ~1578) — Creates CtL bot games. Hardcodes:
   - Unit classes: `['rogue', 'knight', 'mage']`
   - Team structure: `'A' | 'B'`
   - Map sizing: `getMapRadiusForTeamSize()`
   - Turn limits: `getTurnLimitForRadius()`
   - Full `CtlConfig` construction

3. **`createGameFromLobby()`** (line ~2026) — Called by LobbyRunner. Same CtL-specific config construction.

### Remaining imports from game packages

- `CtlConfig` type (CtL config shape)
- `UnitClass` type (rogue/knight/mage)
- `DEFAULT_OATH_CONFIG` (OATHBREAKER defaults)
- `CaptureTheLobsterPlugin` (direct reference for room.plugin)
- `createCtlGameRoom` (CtL factory function)
- `getMapRadiusForTeamSize`, `getTurnLimitForRadius` (CtL game helpers)
- `LobbyManager as EngineLobbyManager` (CtL lobby — used by LobbyRunner)

## The Fix

Add `createConfig()` to `CoordinationGame`:
```typescript
createConfig?(
  players: { id: string; handle: string; team?: string; role?: string }[],
  seed: string,
  options?: Record<string, any>,  // teamSize, etc.
): TConfig;
```

Each plugin builds its own config. Server becomes:
```typescript
const plugin = getGame(gameType);
const config = plugin.createConfig(players, gameId, options);
const game = GameRoom.create(plugin, config, gameId, playerIds);
```

This eliminates ALL game-specific imports from the server except `LobbyManager` (which is deferred until LobbyRunner genericization).
