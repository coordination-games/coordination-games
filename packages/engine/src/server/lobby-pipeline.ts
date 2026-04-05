/**
 * Lobby Pipeline — runs a sequence of LobbyPhases in order.
 *
 * Each phase receives players from the previous phase and outputs
 * groups + metadata. The pipeline collects all metadata and produces
 * the final player groupings.
 */

import type {
  LobbyPhase,
  PhaseContext,
  PhaseResult,
  AgentInfo,
  RelayAccess,
} from '../types.js';

export class LobbyPipeline {
  private phases: LobbyPhase[];
  private currentIndex: number = 0;
  private phaseResults: PhaseResult[] = [];
  private _isComplete: boolean = false;
  private _currentPlayers: AgentInfo[] = [];
  private _gameConfig: Record<string, any> = {};

  constructor(phases: LobbyPhase[]) {
    this.phases = phases;
  }

  /** Start the pipeline with initial players. */
  async start(
    players: AgentInfo[],
    config: Record<string, any>,
    relay?: RelayAccess,
  ): Promise<void> {
    this._currentPlayers = players;
    this._gameConfig = config;
    this.currentIndex = 0;
    this.phaseResults = [];
    this._isComplete = false;

    const defaultRelay: RelayAccess = relay ?? {
      send: () => {},
      broadcast: () => {},
      receive: () => [],
    };

    // Run each phase in sequence
    for (let i = 0; i < this.phases.length; i++) {
      this.currentIndex = i;
      const phase = this.phases[i];

      const ctx: PhaseContext = {
        players: this._currentPlayers,
        gameConfig: this._gameConfig,
        relay: defaultRelay,
        onTimeout: () => ({
          groups: [this._currentPlayers],
          metadata: { timedOut: true },
        }),
      };

      let result: PhaseResult;

      if (phase.timeout && phase.timeout > 0) {
        // Race phase execution against timeout
        result = await Promise.race([
          phase.run(ctx),
          new Promise<PhaseResult>((resolve) =>
            setTimeout(() => resolve(ctx.onTimeout()), phase.timeout! * 1000),
          ),
        ]);
      } else {
        result = await phase.run(ctx);
      }

      this.phaseResults.push(result);

      // Remove dropped players
      if (result.removed?.length) {
        const removedIds = new Set(result.removed.map((p) => p.id));
        this._currentPlayers = this._currentPlayers.filter(
          (p) => !removedIds.has(p.id),
        );
      }

      // Flatten groups into players for next phase
      if (result.groups.length > 0) {
        this._currentPlayers = result.groups.flat();
      }
    }

    this._isComplete = true;
  }

  /** Get current phase info. */
  getCurrentPhase(): {
    id: string;
    name: string;
    index: number;
    total: number;
  } {
    const phase = this.phases[this.currentIndex];
    return {
      id: phase?.id ?? '',
      name: phase?.name ?? '',
      index: this.currentIndex,
      total: this.phases.length,
    };
  }

  /** Check if pipeline is complete. */
  isComplete(): boolean {
    return this._isComplete;
  }

  /** Get final result (all phase metadata merged). */
  getResult(): { groups: AgentInfo[][]; metadata: Record<string, any> } {
    if (!this._isComplete || this.phaseResults.length === 0) {
      return { groups: [], metadata: {} };
    }

    // Merge all phase metadata
    const mergedMetadata: Record<string, any> = {};
    for (const result of this.phaseResults) {
      Object.assign(mergedMetadata, result.metadata);
    }

    // Use the last phase's groups as the final grouping
    const lastResult = this.phaseResults[this.phaseResults.length - 1];
    return {
      groups: lastResult.groups,
      metadata: mergedMetadata,
    };
  }
}
