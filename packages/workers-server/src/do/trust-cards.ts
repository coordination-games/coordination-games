import type { TrustCardV1 } from '@coordination-games/engine';
import {
  projectTrustCards,
  type TragedyBehaviorReputationInput,
  type TrustProjectionArtifacts,
} from '@coordination-games/plugin-trust-projector-tragedy';

export interface TrustCardGameMeta {
  readonly gameId: string;
  readonly gameType: string;
  readonly handleMap: Record<string, string>;
  readonly finished: boolean;
}

export type VisibleTrustArtifacts = TrustProjectionArtifacts;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildBehaviorReputationInput(input: {
  readonly gameId: string;
  readonly previousPublicSnapshot: unknown;
  readonly postRevealSnapshot: unknown;
  readonly snapshotIndex: number;
  readonly observedAt: string;
}): TragedyBehaviorReputationInput | undefined {
  if (!isRecord(input.postRevealSnapshot) || !('lastRoundReveal' in input.postRevealSnapshot))
    return undefined;
  const digest = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
  return {
    gameId: input.gameId,
    revealArtifact: {
      id: `${input.gameId}:reveal:${input.snapshotIndex}`,
      digest,
      observedAt: input.observedAt,
    },
    postRevealArtifact: {
      id: `${input.gameId}:snapshot:${input.snapshotIndex}`,
      digest,
      observedAt: input.observedAt,
    },
    previousSnapshotArtifact: {
      id: `${input.gameId}:snapshot:${input.snapshotIndex - 1}`,
      digest,
      observedAt: input.observedAt,
    },
    reveal: input.postRevealSnapshot.lastRoundReveal,
    postRevealSnapshot: input.postRevealSnapshot,
    previousPublicSnapshot: input.previousPublicSnapshot,
  };
}

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
  behaviorReputation?: TragedyBehaviorReputationInput,
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
    ...(behaviorReputation ? { behaviorReputation } : {}),
  });
}
