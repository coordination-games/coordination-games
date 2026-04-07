/**
 * Game plugin registry — games register themselves, server discovers them generically.
 */

import type { CoordinationGame } from './types.js';

const games: Map<string, CoordinationGame<any, any, any, any>> = new Map();

export function registerGame(plugin: CoordinationGame<any, any, any, any>): void {
  if (games.has(plugin.gameType)) {
    throw new Error(`Game "${plugin.gameType}" already registered`);
  }
  games.set(plugin.gameType, plugin);
}

export function getGame(gameType: string): CoordinationGame<any, any, any, any> | undefined {
  return games.get(gameType);
}

export function getRegisteredGames(): string[] {
  return Array.from(games.keys());
}

export function getAllGames(): Map<string, CoordinationGame<any, any, any, any>> {
  return games;
}
