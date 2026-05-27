import type { AgentInfo, LobbyPhase, PhaseActionResult, PhaseResult } from '../types.js';

export interface OpenQueueState {
  playerIds: string[];
  /** Lobby-time target; phase completes once playerIds.length >= target. */
  target: number;
}

/**
 * Single-phase FFA queue. Completes the moment `playerIds.length` reaches
 * the lobby's `target` (sourced from `init()`'s `config.teamSize`, falling
 * back to the constructor `defaultTarget`).
 *
 * The instance is a module-level singleton shared across every lobby for
 * a given game type, so per-lobby sizing must live in state — not on
 * `this`. The constructor only declares a default.
 */
export class OpenQueuePhase implements LobbyPhase<OpenQueueState> {
  readonly id = 'open-queue';
  readonly name = 'Open Queue';
  readonly acceptsJoins = true;
  readonly timeout = null;

  constructor(private readonly defaultTarget: number = 4) {}

  init(players: AgentInfo[], config: Record<string, unknown>): OpenQueueState {
    const raw = config?.teamSize;
    const fromConfig = typeof raw === 'number' && raw >= 2 ? Math.floor(raw) : null;
    const target = fromConfig ?? this.defaultTarget;
    return { playerIds: players.map((p) => p.id), target };
  }

  handleAction(
    state: OpenQueueState,
    _action: { type: string; playerId: string; payload?: unknown },
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
      target: state.target,
    };
    if (updated.playerIds.length >= state.target) {
      return {
        state: updated,
        completed: { groups: [allPlayers], metadata: {} },
      };
    }
    return { state: updated };
  }

  handleTimeout(state: OpenQueueState, players: AgentInfo[]): PhaseResult | null {
    if (state.playerIds.length >= state.target) {
      return { groups: [players], metadata: {} };
    }
    return null;
  }

  getView(state: OpenQueueState): { playerCount: number; target: number } {
    return { playerCount: state.playerIds.length, target: state.target };
  }

  capacity(state: OpenQueueState): number {
    return state.target;
  }
}
