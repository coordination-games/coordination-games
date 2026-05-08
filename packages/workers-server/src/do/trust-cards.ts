import type { TrustCardV1 } from '@coordination-games/engine';
import {
  projectTrustCards,
  type TrustProjectionArtifacts,
} from '@coordination-games/plugin-trust-projector-tragedy';

export interface TrustCardGameMeta {
  readonly gameId: string;
  readonly gameType: string;
  readonly handleMap: Record<string, string>;
  readonly finished: boolean;
}

export type VisibleTrustArtifacts = TrustProjectionArtifacts;

export function buildVisibleTrustCards(
  state: unknown,
  meta: TrustCardGameMeta,
  progressCounter: number | null,
  relayMessages: readonly unknown[] = [],
): TrustCardV1[] {
  return buildVisibleTrustArtifacts(state, meta, progressCounter, relayMessages).cards;
}

export function buildVisibleTrustArtifacts(
  state: unknown,
  meta: TrustCardGameMeta,
  progressCounter: number | null,
  relayMessages: readonly unknown[] = [],
): VisibleTrustArtifacts {
  return projectTrustCards({
    state,
    meta: {
      gameId: meta.gameId,
      gameType: meta.gameType,
      handleMap: meta.handleMap,
      finished: meta.finished,
      progressCounter,
    },
    relayMessages,
  });
}
