# Remaining Game-Specific Server Code

**Status: COMPLETED**

## Summary

The `createConfig()` method was added to `CoordinationGame` and implemented by both CtL and OATHBREAKER plugins. The server now calls `plugin.createConfig(players, seed, options)` instead of constructing game-specific configs inline. All game-specific imports have been removed from `api.ts` except `LobbyManager`, which is used by `LobbyRunner` and deferred to the LobbyRunner genericization effort.

### What was done

1. **Added `createConfig()` to `CoordinationGame`** in engine `types.ts` (via `GameSetup` interface):
   ```typescript
   createConfig(
     players: { id: string; handle: string; team?: string; role?: string }[],
     seed: string,
     options?: Record<string, any>,
   ): TConfig;
   ```

2. **Implemented `createConfig()` in both game plugins** — each plugin builds its own config from players, seed, and options. CtL handles team structure, map sizing, turn limits, and unit classes internally. OATHBREAKER handles its default config internally.

3. **Server `api.ts` is now game-agnostic** — `promoteWaitingRoom()`, `createBotGame()`, and `createGameFromLobby()` all use `plugin.createConfig()`. Zero game-specific config construction in the server.

### Eliminated imports

All of these are gone from the server:
- `CtlConfig`, `UnitClass` types
- `DEFAULT_OATH_CONFIG`
- `CaptureTheLobsterPlugin` (direct reference)
- `createCtlGameRoom` (factory function)
- `getMapRadiusForTeamSize`, `getTurnLimitForRadius` (game helpers)

### What remains (deferred)

- **`LobbyManager`** — still imported by `lobby-runner.ts` and `mcp-http.ts` for CtL-specific lobby orchestration. This will be genericized when LobbyRunner is refactored to use the engine's `LobbyPipeline` for all games, not just CtL. Tracked separately.
