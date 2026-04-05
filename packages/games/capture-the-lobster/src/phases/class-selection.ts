/**
 * Class Selection Phase — wraps existing LobbyManager pre-game logic
 * as a LobbyPhase for the plugin pipeline.
 */

import type { LobbyPhase, PhaseContext, PhaseResult, AgentInfo } from '@coordination-games/engine';
import type { UnitClass } from '../movement.js';

export interface ClassPick {
  playerId: string;
  unitClass: UnitClass;
}

export const ClassSelectionPhase: LobbyPhase = {
  id: 'class-selection',
  name: 'Class Selection',
  timeout: 30,

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    // In the automated flow, assign default classes
    // The real interactive flow would wait for player input via relay
    const classPicks: ClassPick[] = [];
    const classes: UnitClass[] = ['rogue', 'knight', 'mage'];

    for (let i = 0; i < ctx.players.length; i++) {
      const player = ctx.players[i];
      // Check if a class was pre-assigned via gameConfig
      const preAssigned = ctx.gameConfig.classPicks?.[player.id] as
        | UnitClass
        | undefined;
      const unitClass = preAssigned ?? classes[i % classes.length];
      classPicks.push({ playerId: player.id, unitClass });
    }

    return {
      groups: [ctx.players],
      metadata: {
        classPicks: classPicks.reduce(
          (acc, pick) => {
            acc[pick.playerId] = pick.unitClass;
            return acc;
          },
          {} as Record<string, UnitClass>,
        ),
      },
    };
  },
};
