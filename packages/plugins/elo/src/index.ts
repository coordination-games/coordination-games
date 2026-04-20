/**
 * ELO Plugin — wraps EloTracker as a ToolPlugin.
 *
 * Provides leaderboard and stats tools. Hooks into game completion
 * to update player ratings.
 */

import type { AgentInfo, ToolPlugin } from '@coordination-games/engine';
import { EloTracker } from './tracker.js';

export { EloTracker, type Player } from './tracker.js';

export function createEloPlugin(dbPath?: string): ToolPlugin & { tracker: EloTracker } {
  const tracker = new EloTracker(dbPath);

  return {
    id: 'elo',
    version: '0.1.0',
    modes: [{ name: 'stats', consumes: [], provides: ['leaderboard'] }],
    purity: 'stateful',

    tools: [
      {
        name: 'get_leaderboard',
        description: 'Get the top players by ELO rating',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max players to return', default: 20 },
          },
        },
      },
      {
        name: 'get_my_stats',
        description: 'Get your ELO rating and match history',
        inputSchema: { type: 'object', properties: {} },
      },
    ],

    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    handleData(_mode: string, _inputs: Map<string, any>): Map<string, any> {
      const leaderboard = tracker.getLeaderboard(10);
      return new Map([['leaderboard', leaderboard]]);
    },

    handleCall(tool: string, args: unknown, caller: AgentInfo): unknown {
      if (tool === 'get_leaderboard') {
        // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
        const { limit = 20 } = (args as any) ?? {};
        return { leaderboard: tracker.getLeaderboard(limit) };
      }

      if (tool === 'get_my_stats') {
        const player = tracker.getPlayer(caller.id);
        if (!player) return { error: 'Player not found' };
        const matches = tracker.getPlayerMatches(caller.id, 10);
        return { player, recentMatches: matches };
      }

      return { error: `Unknown tool: ${tool}` };
    },

    tracker,
  };
}

/** Singleton-compatible export. */
export const EloPlugin = createEloPlugin();
