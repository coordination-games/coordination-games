/**
 * Server-side tool-collision detector — release-blocking.
 *
 * Exercises the collision check in `registry.registerGame()`. See
 * `docs/plans/unified-tool-surface.md` — "Collision detector" — the fourth
 * drift invariant.
 *
 * Scope:
 *  - A single plugin naming the same tool in both gameTools and a lobby phase
 *    throws `ToolCollisionError` with a formatted multi-declarer message.
 *  - A clean plugin registers successfully.
 *  - Two *separate* game plugins can each independently name "move" — they
 *    live in different MCP sessions, so this is NOT a collision.
 *  - Re-registering the same gameType throws the "already registered" error.
 */

import { describe, expect, it } from 'vitest';
import {
  type AgentInfo,
  type CoordinationGame,
  getAllGames,
  type LobbyPhase,
  type PhaseActionResult,
  type PhaseResult,
  registerGame,
  ToolCollisionError,
  type ToolDefinition,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fake LobbyPhase factory
// ---------------------------------------------------------------------------

function fakePhase(id: string, tools: ToolDefinition[]): LobbyPhase {
  return {
    id,
    name: id,
    tools,
    timeout: null,
    acceptsJoins: true,
    init(_players: AgentInfo[]) {
      return {};
    },
    handleAction(state, _action, _players): PhaseActionResult {
      return { state };
    },
    handleTimeout(_state, _players): PhaseResult | null {
      return null;
    },
    getView(_state) {
      return {};
    },
  };
}

// ---------------------------------------------------------------------------
// Fake CoordinationGame factory — only the fields `registerGame` reads.
// ---------------------------------------------------------------------------

type AnyGame = CoordinationGame<unknown, unknown, unknown, unknown>;

function fakeGame(options: {
  gameType: string;
  gameTools?: ToolDefinition[];
  phases?: LobbyPhase[];
}): AnyGame {
  return {
    gameType: options.gameType,
    version: '0.0.0-test',
    entryCost: 0n,
    gameTools: options.gameTools,
    lobby: options.phases
      ? {
          queueType: 'open',
          phases: options.phases,
          matchmaking: {
            minPlayers: 2,
            maxPlayers: 4,
            teamSize: 1,
            numTeams: 2,
            queueTimeoutMs: 60000,
          },
        }
      : undefined,
    // Stubs — not exercised by registerGame's collision check.
    createInitialState: () => ({}),
    validateAction: () => false,
    applyAction: (state: unknown) => ({ state }),
    getVisibleState: () => ({}),
    isOver: () => true,
    getOutcome: () => ({}),
    computePayouts: () => new Map(),
    buildSpectatorView: () => ({}),
    // Phase 4.7 required methods.
    getSummaryFromSpectator: () => ({}),
    getReplayChrome: () => ({ isFinished: false, statusVariant: 'in_progress' as const }),
  } as unknown as AnyGame;
}

const chatTool = (): ToolDefinition => ({
  name: 'chat',
  description: 'test chat',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

const moveTool = (): ToolDefinition => ({
  name: 'move',
  description: 'test move',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

// ---------------------------------------------------------------------------
// Isolation — each test uses a fresh game name so the singleton registry
// doesn't carry state between tests.
// ---------------------------------------------------------------------------

let testIx = 0;
function uniq(prefix: string): string {
  testIx += 1;
  return `${prefix}-${testIx}-${Date.now().toString(36)}`;
}

describe('ToolCollisionError — server-side', () => {
  it('throws when gameTools and a lobby phase both name "chat"', () => {
    const plugin = fakeGame({
      gameType: uniq('collision-same'),
      gameTools: [chatTool()],
      phases: [fakePhase('lobby-phase-a', [chatTool()])],
    });

    let thrown: unknown;
    try {
      registerGame(plugin);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolCollisionError);
    const err = thrown as ToolCollisionError;
    expect(err.toolName).toBe('chat');
    expect(err.declarers).toHaveLength(2);
    // Message includes both declarers in a human-readable form.
    expect(err.message).toMatch(/GamePhase of game/);
    expect(err.message).toMatch(/LobbyPhase "lobby-phase-a"/);
    // The game was NOT added to the registry on failure.
    expect(getAllGames().has(plugin.gameType)).toBe(false);
  });

  it('throws when two lobby phases both declare the same tool name', () => {
    const plugin = fakeGame({
      gameType: uniq('collision-cross-phase'),
      phases: [fakePhase('phase-a', [chatTool()]), fakePhase('phase-b', [chatTool()])],
    });

    expect(() => registerGame(plugin)).toThrow(ToolCollisionError);
  });

  it('accepts a clean plugin with distinct tool names', () => {
    const plugin = fakeGame({
      gameType: uniq('collision-clean'),
      gameTools: [moveTool()],
      phases: [fakePhase('phase-a', [chatTool()])],
    });

    expect(() => registerGame(plugin)).not.toThrow();
    expect(getAllGames().has(plugin.gameType)).toBe(true);
  });

  it('allows the SAME tool name across SEPARATE game plugins (different sessions)', () => {
    // Per the plan: "GamePhase vs LobbyPhase collisions count (same MCP
    // namespace), even though temporally exclusive." But two different games
    // each declaring "move" is fine — they never share an MCP session.
    const pluginA = fakeGame({
      gameType: uniq('collision-separate-a'),
      gameTools: [moveTool()],
    });
    const pluginB = fakeGame({
      gameType: uniq('collision-separate-b'),
      gameTools: [moveTool()],
    });

    expect(() => registerGame(pluginA)).not.toThrow();
    expect(() => registerGame(pluginB)).not.toThrow();
    expect(getAllGames().has(pluginA.gameType)).toBe(true);
    expect(getAllGames().has(pluginB.gameType)).toBe(true);
  });

  it('re-registering the same gameType is rejected (independent of tools)', () => {
    const gameType = uniq('collision-dup-game');
    const plugin1 = fakeGame({ gameType, gameTools: [moveTool()] });
    const plugin2 = fakeGame({ gameType, gameTools: [moveTool()] });

    expect(() => registerGame(plugin1)).not.toThrow();
    expect(() => registerGame(plugin2)).toThrow(/already registered/);
  });

  it('ToolCollisionError message ends with resolution suggestions', () => {
    const plugin = fakeGame({
      gameType: uniq('collision-msg-format'),
      gameTools: [chatTool()],
      phases: [fakePhase('phase-x', [chatTool()])],
    });
    let thrown: Error | undefined;
    try {
      registerGame(plugin);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toMatch(/Resolve by:/);
    expect(thrown?.message).toMatch(/renaming one of the conflicting tools/);
  });
});
