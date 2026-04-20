/**
 * Game plugin registry — games register themselves, server discovers them generically.
 *
 * registerGame() also enforces the tool-name collision invariant: across
 * `gameTools ∪ lobby.phases[*].tools`, every tool name must be unique. A
 * duplicate is a hard error at plugin load time.
 *
 * Plugin tools (ToolPlugin.tools) are client-side and outside the server's
 * responsibility — their collisions are checked by the CLI (R3).
 */

import type { CoordinationGame } from './types.js';

// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
const games: Map<string, CoordinationGame<any, any, any, any>> = new Map();

/** Declarer of a tool within a game plugin. */
interface ToolDeclarer {
  kind: 'game' | 'lobby-phase';
  /** For lobby-phase: the LobbyPhase.id. For game: undefined. */
  phaseId?: string;
}

/**
 * Find tool-name collisions within a single game's declared surface.
 * Returns a map of colliding name → declarers. Empty map means no collisions.
 */
function findToolCollisions(
  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  plugin: CoordinationGame<any, any, any, any>,
): Map<string, ToolDeclarer[]> {
  const byName = new Map<string, ToolDeclarer[]>();

  for (const tool of plugin.gameTools ?? []) {
    if (!byName.has(tool.name)) byName.set(tool.name, []);
    byName.get(tool.name)?.push({ kind: 'game' });
  }

  for (const phase of plugin.lobby?.phases ?? []) {
    for (const tool of phase.tools ?? []) {
      if (!byName.has(tool.name)) byName.set(tool.name, []);
      byName.get(tool.name)?.push({ kind: 'lobby-phase', phaseId: phase.id });
    }
  }

  const collisions = new Map<string, ToolDeclarer[]>();
  for (const [name, declarers] of byName.entries()) {
    if (declarers.length > 1) collisions.set(name, declarers);
  }
  return collisions;
}

/**
 * Error thrown when a game plugin declares the same tool name in multiple
 * places within its own surface (gameTools × lobby phases).
 */
export class ToolCollisionError extends Error {
  readonly toolName: string;
  readonly declarers: string[];

  constructor(gameType: string, toolName: string, declarers: ToolDeclarer[]) {
    const declarerLabels = declarers.map((d) =>
      d.kind === 'game'
        ? `GamePhase of game "${gameType}"`
        : `LobbyPhase "${d.phaseId}" of game "${gameType}"`,
    );
    const message =
      `Tool name collision: "${toolName}" is declared by:\n` +
      declarerLabels.map((l) => `  - ${l}`).join('\n') +
      `\n\nResolve by:\n` +
      `  - renaming one of the conflicting tools, or\n` +
      `  - removing the duplicate declaration from the game plugin.`;
    super(message);
    this.name = 'ToolCollisionError';
    this.toolName = toolName;
    this.declarers = declarerLabels;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
export function registerGame(plugin: CoordinationGame<any, any, any, any>): void {
  if (games.has(plugin.gameType)) {
    throw new Error(`Game "${plugin.gameType}" already registered`);
  }

  const collisions = findToolCollisions(plugin);
  if (collisions.size > 0) {
    // Throw on the first collision (predictable error for plugin authors).
    const [name, declarers] = collisions.entries().next().value as [string, ToolDeclarer[]];
    throw new ToolCollisionError(plugin.gameType, name, declarers);
  }

  games.set(plugin.gameType, plugin);
}

// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
export function getGame(gameType: string): CoordinationGame<any, any, any, any> | undefined {
  return games.get(gameType);
}

export function getRegisteredGames(): string[] {
  return Array.from(games.keys());
}

// biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
export function getAllGames(): Map<string, CoordinationGame<any, any, any, any>> {
  return games;
}
