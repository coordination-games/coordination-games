/**
 * Team Formation Phase — wraps existing LobbyManager team formation logic
 * as a LobbyPhase for the plugin pipeline.
 */

import type { LobbyPhase, PhaseContext, PhaseResult, AgentInfo } from '@coordination-games/engine';
import { LobbyManager } from '../lobby.js';

export const TeamFormationPhase: LobbyPhase = {
  id: 'team-formation',
  name: 'Team Formation',
  timeout: 60,

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const teamSize = ctx.gameConfig.teamSize ?? 2;
    const lobby = new LobbyManager(undefined, teamSize);

    // Add all players to the lobby
    for (const player of ctx.players) {
      lobby.addAgent({ id: player.id, handle: player.handle, elo: 1000 });
    }

    // Auto-merge into teams (the simplest path — bots will negotiate via chat)
    const result = lobby.autoMergeTeams(teamSize);

    // Build groups from completed teams
    const groups: AgentInfo[][] = result.teams.map((team) =>
      team.members.map((id) => {
        const player = ctx.players.find((p) => p.id === id);
        return player ?? { id, handle: id };
      }),
    );

    // Orphans are removed
    const removed = result.orphans.map((id) => {
      const player = ctx.players.find((p) => p.id === id);
      return player ?? { id, handle: id };
    });

    return {
      groups,
      metadata: {
        teamAssignments: result.teams.map((t) => ({
          teamId: t.id,
          members: t.members,
        })),
      },
      removed: removed.length > 0 ? removed : undefined,
    };
  },
};
