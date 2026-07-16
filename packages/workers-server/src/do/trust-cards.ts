import { keccak256CanonicalJson, type TrustCardV1 } from '@coordination-games/engine';
import {
  canonicalizeTragedyReveal,
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
  if (!isRecord(input.postRevealSnapshot) || !isRecord(input.previousPublicSnapshot))
    return undefined;
  const canonicalReveal = canonicalizeTragedyReveal(input.postRevealSnapshot.lastRoundReveal);
  if (canonicalReveal === null) return undefined;
  const priorReveal = input.previousPublicSnapshot.lastRoundReveal;
  const canonicalPrior = canonicalizeTragedyReveal(priorReveal);
  if (
    canonicalPrior !== null &&
    keccak256CanonicalJson(canonicalPrior) === keccak256CanonicalJson(canonicalReveal)
  )
    return undefined;
  return {
    gameId: input.gameId,
    revealArtifact: {
      id: `${input.gameId}:reveal:${input.snapshotIndex}`,
      digest: keccak256CanonicalJson(canonicalReveal),
      observedAt: input.observedAt,
    },
    postRevealArtifact: {
      id: `${input.gameId}:snapshot:${input.snapshotIndex}`,
      digest: keccak256CanonicalJson(input.postRevealSnapshot),
      observedAt: input.observedAt,
    },
    previousSnapshotArtifact: {
      id: `${input.gameId}:snapshot:${input.snapshotIndex - 1}`,
      digest: keccak256CanonicalJson(input.previousPublicSnapshot),
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
