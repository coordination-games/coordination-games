/**
 * Client-side tool-collision detector — release-blocking.
 *
 * Exercises the collision check at the top of
 * `packages/cli/src/mcp-tools.ts:registerGameTools()`, which builds the full
 * client-side surface (game.gameTools ∪ LobbyPhase.tools ∪ ToolPlugin.tools
 * with mcpExpose:true) and fails fast on name collisions — including against
 * the static CLI command list.
 *
 * See `docs/plans/unified-tool-surface.md` — "Testing — drift invariants",
 * fourth invariant.
 *
 * NOTE: The module-internal `buildFullSurface` and `checkSurfaceCollisions`
 * are not exported, so we exercise them through `registerGameTools()` with a
 * minimal stub McpServer. The collision check runs BEFORE any `server.tool()`
 * call, so the stub never needs real MCP behaviour.
 */

import type { CoordinationGame, ToolDefinition, ToolPlugin } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import { ClientToolCollisionError, registerGameTools, STATIC_CLI_COMMANDS } from '../mcp-tools.js';

// ---------------------------------------------------------------------------
// Stub McpServer — `registerGameTools` calls `server.tool(name, desc, shape, fn)`.
// The stub collects registrations so tests can assert post-collision success.
// ---------------------------------------------------------------------------

function makeStubServer() {
  const registered: string[] = [];
  return {
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    tool: (name: string, _desc: string, _shape: any, _fn: any) => {
      registered.push(name);
    },
    registered,
  };
}

// Minimal GameClient — only `client.getGuide`/`getState`/etc. are called from
// the static tool handlers, which run only when a tool is INVOKED. The
// collision check and registration never call them. Cast as any to avoid
// dragging the real class into tests.
// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
const stubClient: any = {};

// ---------------------------------------------------------------------------
// Fake factory helpers
// ---------------------------------------------------------------------------

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    ...extra,
  };
}

function fakeGame(
  gameType: string,
  opts: { gameTools?: ToolDefinition[]; phaseTools?: Record<string, ToolDefinition[]> } = {},
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
): CoordinationGame<any, any, any, any> {
  return {
    gameType,
    version: '0.0.0-test',
    entryCost: 0,
    gameTools: opts.gameTools,
    lobby: opts.phaseTools
      ? {
          queueType: 'open',
          phases: Object.entries(opts.phaseTools).map(([id, tools]) => ({
            id,
            name: id,
            tools,
            timeout: null,
            acceptsJoins: true,
            init: () => ({}),
            // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
            handleAction: (state: any) => ({ state }),
            handleTimeout: () => null,
            getView: () => ({}),
          })),
          matchmaking: {
            minPlayers: 2,
            maxPlayers: 4,
            teamSize: 1,
            numTeams: 2,
            queueTimeoutMs: 60000,
          },
        }
      : undefined,
    createInitialState: () => ({}),
    validateAction: () => false,
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    applyAction: (state: any) => ({ state }),
    getVisibleState: () => ({}),
    isOver: () => true,
    getOutcome: () => ({}),
    computePayouts: () => new Map(),
    buildSpectatorView: () => ({}),
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  } as unknown as CoordinationGame<any, any, any, any>;
}

function fakePlugin(id: string, tools: ToolDefinition[]): ToolPlugin {
  return {
    id,
    version: '0.0.0-test',
    modes: [{ name: 'default', consumes: [], provides: [] }],
    purity: 'pure',
    tools,
    handleData: () => new Map(),
    handleCall: () => ({ ok: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientToolCollisionError — client-side surface', () => {
  it('ToolPlugin named "state" collides with a static CLI command', () => {
    const plugin = fakePlugin('@cg/plugin-stateful', [tool('state', { mcpExpose: true })]);
    const server = makeStubServer();

    let thrown: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      registerGameTools(server as any, stubClient, { plugins: [plugin] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClientToolCollisionError);
    const err = thrown as ClientToolCollisionError;
    expect(err.toolName).toBe('state');
    expect(err.declarers).toContain('static CLI command');
    // No tools registered after collision.
    expect(server.registered).toEqual([]);
  });

  it('ToolPlugin tool name colliding with a gameTool throws', () => {
    const plugin = fakePlugin('@cg/plugin-chatter', [tool('chat', { mcpExpose: true })]);
    const game = fakeGame('fake-game-with-chat', {
      gameTools: [tool('chat')],
    });
    const server = makeStubServer();

    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    let thrown: any;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      registerGameTools(server as any, stubClient, { plugins: [plugin], games: [game] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClientToolCollisionError);
    expect(thrown.toolName).toBe('chat');
    // Both declarers surface in the error.
    const declarers = (thrown as ClientToolCollisionError).declarers.join('|');
    expect(declarers).toMatch(/GamePhase of game "fake-game-with-chat"/);
    expect(declarers).toMatch(/ToolPlugin "@cg\/plugin-chatter"/);
    expect(server.registered).toEqual([]);
  });

  it('clean config registers without throwing (static tools + game tool + plugin tool)', () => {
    const game = fakeGame('clean-game', {
      gameTools: [tool('move')],
    });
    const plugin = fakePlugin('clean-plugin', [tool('chit_chat', { mcpExpose: true })]);
    const server = makeStubServer();

    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      registerGameTools(server as any, stubClient, { games: [game], plugins: [plugin] }),
    ).not.toThrow();
    // Both dynamic tools end up registered on the server, plus the fixed
    // built-ins. We only assert on the dynamic ones being present.
    expect(server.registered).toContain('move');
    expect(server.registered).toContain('chit_chat');
  });

  it('plugin tool with mcpExpose:false is ignored by the collision check', () => {
    // mcpExpose:false means the plugin tool is NOT surfaced as an MCP tool,
    // so it's NOT part of the client-side collision scope.
    const plugin = fakePlugin('hidden-plugin', [tool('state', { mcpExpose: false })]);
    const server = makeStubServer();

    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    expect(() => registerGameTools(server as any, stubClient, { plugins: [plugin] })).not.toThrow();
  });

  it('collision between two lobby phases throws with both LobbyPhase declarers', () => {
    const game = fakeGame('game-with-dup-lobby-tool', {
      phaseTools: {
        'phase-a': [tool('go')],
        'phase-b': [tool('go')],
      },
    });
    const server = makeStubServer();

    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    let thrown: any;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      registerGameTools(server as any, stubClient, { games: [game] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClientToolCollisionError);
    expect(thrown.toolName).toBe('go');
    const declarers = (thrown as ClientToolCollisionError).declarers.join('|');
    expect(declarers).toMatch(/phase-a/);
    expect(declarers).toMatch(/phase-b/);
  });

  it('STATIC_CLI_COMMANDS list is exported and non-empty (contract with mcp-tools)', () => {
    expect(STATIC_CLI_COMMANDS.length).toBeGreaterThan(0);
    // A sanity anchor — if this constant is gutted, tests that rely on the
    // static collision check would silently stop catching anything.
    expect(STATIC_CLI_COMMANDS).toContain('state');
    expect(STATIC_CLI_COMMANDS).toContain('tool');
  });

  it('re-exported ClientToolCollisionError message ends with resolution suggestions', () => {
    const plugin = fakePlugin('colliding', [tool('state', { mcpExpose: true })]);
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    let thrown: any;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      registerGameTools(makeStubServer() as any, stubClient, { plugins: [plugin] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown?.message).toMatch(/Resolve by:/);
    expect(thrown?.message).toMatch(/renaming one of the conflicting tools/);
  });
});
