/**
 * Class Selection Phase — request-driven LobbyPhase implementation.
 *
 * Players pick their unit class (rogue/knight/mage). No new joins allowed.
 * On timeout, unassigned players get classes via round-robin from validClasses.
 */

import type {
  LobbyPhase,
  PhaseActionResult,
  PhaseResult,
  AgentInfo,
  ToolDefinition,
} from '@coordination-games/engine';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ClassSelectionState {
  /** playerId -> chosen class */
  classPicks: Record<string, string>;
  /** All player IDs that need to pick */
  playerIds: string[];
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

export class ClassSelectionPhase implements LobbyPhase<ClassSelectionState> {
  readonly id = 'class-selection';
  readonly name = 'Class Selection';
  readonly acceptsJoins = false;
  readonly timeout = 600;

  readonly tools: ToolDefinition[] = [
    {
      name: 'choose_class',
      description: 'Pick your unit class for the game.',
      inputSchema: {
        type: 'object',
        properties: {
          unitClass: {
            type: 'string',
            description: 'The class to play as.',
          },
        },
        required: ['unitClass'],
      },
      mcpExpose: true,
    },
  ];

  private readonly validClasses: string[];

  constructor(config: { validClasses: string[] }) {
    this.validClasses = config.validClasses;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(players: AgentInfo[], _config: Record<string, any>): ClassSelectionState {
    return {
      classPicks: {},
      playerIds: players.map((p) => p.id),
    };
  }

  handleAction(
    state: ClassSelectionState,
    action: { type: string; playerId: string; payload?: any },
    players: AgentInfo[],
  ): PhaseActionResult<ClassSelectionState> {
    if (action.type !== 'choose_class') {
      return {
        state,
        error: { message: `Unknown action type: ${action.type}`, status: 400 },
      };
    }

    const { playerId, payload } = action;
    const unitClass: string | undefined = payload?.unitClass;

    // Validate player is in this phase
    if (!state.playerIds.includes(playerId)) {
      return {
        state,
        error: { message: 'Player not in class selection', status: 404 },
      };
    }

    // Validate class name
    if (!unitClass || !this.validClasses.includes(unitClass)) {
      return {
        state,
        error: {
          message: `Invalid class. Valid classes: ${this.validClasses.join(', ')}`,
          status: 400,
        },
      };
    }

    // Record pick (allows changing pick)
    const newState: ClassSelectionState = {
      ...state,
      classPicks: { ...state.classPicks, [playerId]: unitClass },
    };

    // Check completion
    const allPicked = newState.playerIds.every((id) => id in newState.classPicks);
    if (allPicked) {
      return {
        state: newState,
        completed: this.buildResult(newState, players),
      };
    }

    return { state: newState };
  }

  // No handleJoin — acceptsJoins is false

  handleTimeout(
    state: ClassSelectionState,
    players: AgentInfo[],
  ): PhaseResult | null {
    // Auto-assign round-robin for anyone who hasn't picked
    const filled: Record<string, string> = { ...state.classPicks };
    let idx = 0;
    for (const id of state.playerIds) {
      if (!(id in filled)) {
        filled[id] = this.validClasses[idx % this.validClasses.length];
        idx++;
      }
    }

    const filledState: ClassSelectionState = {
      ...state,
      classPicks: filled,
    };

    return this.buildResult(filledState, players);
  }

  getView(state: ClassSelectionState, _playerId?: string): unknown {
    return {
      validClasses: this.validClasses,
      classPicks: state.classPicks,
      playerIds: state.playerIds,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildResult(
    state: ClassSelectionState,
    players: AgentInfo[],
  ): PhaseResult {
    // Single flat group — team assignments persist from previous phase metadata
    const allPlayers = state.playerIds
      .map((id) => players.find((p) => p.id === id))
      .filter((p): p is AgentInfo => p != null);

    return {
      groups: [allPlayers],
      metadata: {
        classPicks: state.classPicks,
      },
    };
  }
}
