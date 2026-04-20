import type { AgentInfo, LobbyPhase, PhaseActionResult, PhaseResult } from '../types.js';

export interface OpenQueueState {
  playerIds: string[];
}

export class OpenQueuePhase implements LobbyPhase<OpenQueueState> {
  readonly id = 'open-queue';
  readonly name = 'Open Queue';
  readonly acceptsJoins = true;
  readonly timeout = null;

  constructor(private readonly minPlayers: number = 4) {}

  init(players: AgentInfo[]): OpenQueueState {
    return { playerIds: players.map((p) => p.id) };
  }

  handleAction(
    state: OpenQueueState,
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    _action: { type: string; playerId: string; payload?: any },
    _players: AgentInfo[],
  ): PhaseActionResult<OpenQueueState> {
    return { state, error: { message: 'No actions available during open queue phase' } };
  }

  handleJoin(
    state: OpenQueueState,
    player: AgentInfo,
    allPlayers: AgentInfo[],
  ): PhaseActionResult<OpenQueueState> {
    const updated: OpenQueueState = {
      playerIds: [...state.playerIds, player.id],
    };
    if (updated.playerIds.length >= this.minPlayers) {
      return {
        state: updated,
        completed: { groups: [allPlayers], metadata: {} },
      };
    }
    return { state: updated };
  }

  handleTimeout(state: OpenQueueState, players: AgentInfo[]): PhaseResult | null {
    if (state.playerIds.length >= this.minPlayers) {
      return { groups: [players], metadata: {} };
    }
    return null;
  }

  getView(state: OpenQueueState): { playerCount: number; minPlayers: number } {
    return { playerCount: state.playerIds.length, minPlayers: this.minPlayers };
  }
}
