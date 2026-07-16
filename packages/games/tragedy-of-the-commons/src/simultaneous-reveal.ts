import type { TragedyV2Action } from './types.js';

export interface TragedyV2RevealedAction {
  readonly playerId: string;
  readonly action: TragedyV2Action;
}

export interface TragedyV2RoundReveal {
  readonly round: number;
  readonly actions: readonly TragedyV2RevealedAction[];
}

export function buildV2RoundReveal(
  round: number,
  actions: readonly TragedyV2RevealedAction[],
): TragedyV2RoundReveal {
  return {
    round,
    actions: actions.map((item) => ({ playerId: item.playerId, action: { ...item.action } })),
  };
}

export function cloneV2RoundReveal(reveal: TragedyV2RoundReveal): TragedyV2RoundReveal {
  return buildV2RoundReveal(reveal.round, reveal.actions);
}
