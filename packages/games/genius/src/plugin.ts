import type {
  CoordinationGame,
  GamePhaseKind,
  GameSetup,
  SpectatorContext,
  ToolDefinition,
} from '@coordination-games/engine';
import { credits, OpenQueuePhase, registerGame } from '@coordination-games/engine';
import { normalizeGeniusConfig } from './config.js';
import { applyAction, createInitialState, validateAction } from './game.js';
import { GENIUS_GUIDE } from './guide.js';
import { computeGeniusPayouts, getGeniusLadderPlacements } from './ranking.js';
import { getGeniusOutcome } from './replay.js';
import type { GeniusAction, GeniusConfig, GeniusOutcome, GeniusState } from './types.js';
import {
  buildGeniusVisibleState,
  geniusReplayChrome,
  geniusSummary,
  geniusSummaryFromSnapshot,
} from './views.js';

export const GENIUS_GAME_ID = 'genius' as const;
export const GENIUS_SYSTEM_ACTION_TYPES: readonly string[] = Object.freeze([]);

const PRESS_COLOR_TOOL: ToolDefinition = {
  name: 'press_color',
  description: 'Press the next visible sequence color on your current turn.',
  mcpExpose: true,
  inputSchema: {
    type: 'object',
    properties: {
      color: { type: 'string', enum: ['red', 'blue', 'green', 'yellow'] },
    },
    required: ['color'],
    additionalProperties: false,
  },
};

export const GeniusPlugin: CoordinationGame<
  GeniusConfig,
  GeniusState,
  GeniusAction,
  GeniusOutcome
> = {
  gameType: GENIUS_GAME_ID,
  version: '0.1.0',
  entryCost: credits(1),
  spectatorDelay: 0,
  progressUnit: 'round',
  chatScopes: ['all', 'dm'],
  guide: GENIUS_GUIDE,
  lobby: { phases: [new OpenQueuePhase(3)] },
  gameTools: [PRESS_COLOR_TOOL],
  requiredPlugins: ['basic-chat'],

  createInitialState,
  validateAction,
  applyAction,

  getVisibleState(state: GeniusState): unknown {
    return buildGeniusVisibleState(state);
  },

  buildSpectatorView(
    state: GeniusState,
    _previous: GeniusState | null,
    _context: SpectatorContext,
  ): unknown {
    return buildGeniusVisibleState(state);
  },

  isOver(state: GeniusState): boolean {
    return state.phase === 'finished';
  },

  getCurrentPhaseKind(state: GeniusState): GamePhaseKind {
    return state.phase === 'finished' ? 'finished' : 'in_progress';
  },

  getTeamForPlayer(_state: GeniusState, playerId: string): string {
    return playerId;
  },

  getProgressCounter(state: GeniusState): number {
    return state.round;
  },

  getOutcome: getGeniusOutcome,
  getLadderPlacements: getGeniusLadderPlacements,
  computePayouts: computeGeniusPayouts,

  getCurrentGameTools(state: GeniusState, playerId: string | null): ToolDefinition[] {
    return state.phase === 'playing' && playerId === state.currentPlayerId
      ? [PRESS_COLOR_TOOL]
      : [];
  },

  getPlayersNeedingAction(state: GeniusState): string[] {
    return state.phase === 'playing' && state.currentPlayerId !== null
      ? [state.currentPlayerId]
      : [];
  },

  getPlayerStatus(state: GeniusState, playerId: string): string {
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (player === undefined) return '\n## Your Status\n- Unknown player';
    return `\n## Your Status\n- **Phase:** ${state.phase}\n- **Round:** ${state.round}/${state.maxRounds}\n- **Score:** ${player.score}\n- **Active:** ${player.active}`;
  },

  getSummary(state: GeniusState): Record<string, unknown> {
    return geniusSummary(buildGeniusVisibleState(state));
  },

  getSummaryFromSpectator: geniusSummaryFromSnapshot,
  getReplayChrome: geniusReplayChrome,

  createConfig(
    players: { id: string; handle: string; team?: string; role?: string }[],
    seed: string,
    options?: Record<string, unknown>,
  ): GameSetup<GeniusConfig> {
    const maxRounds = options?.maxRounds;
    const config = normalizeGeniusConfig({
      playerIds: players.map((player) => player.id),
      seed,
      ...(typeof maxRounds === 'number' ? { maxRounds } : {}),
    });
    return {
      config,
      players: players.map((player) => ({ id: player.id, team: player.id })),
    };
  },
};

registerGame(GeniusPlugin);
