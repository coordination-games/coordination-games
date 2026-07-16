import type { AtprotoStrongRef, DidPlc, PromiseOutcomeEvent } from '@coordination-games/trust';
import {
  mapSettledTragedyPromiseOutcomes,
  type TragedyPromiseOutcomeMapping,
} from './portable-trust.js';

export const TRAGEDY_PUBLIC_PROMISE_VERSION = 'tragedy-public-promise/v1' as const;
export const TRAGEDY_PUBLIC_ACTION_VERSION = 'tragedy-public-action/v1' as const;
export const TRAGEDY_PROMISE_DERIVATION_VERSION = 'tragedy-action-match/v1' as const;

type RecordValue = Readonly<Record<string, unknown>>;

export type TragedyPublicPromise = Readonly<{
  readonly version: typeof TRAGEDY_PUBLIC_PROMISE_VERSION;
  readonly promiseId: string;
  readonly promisorPlayerId: string;
  readonly gameId: string;
  readonly sequence: number;
  readonly expectedActionType: string;
}>;

export type TragedyPublicActionObservation = Readonly<{
  readonly version: typeof TRAGEDY_PUBLIC_ACTION_VERSION;
  readonly gameId: string;
  readonly playerId: string;
  readonly sequence: number;
  readonly actionType: string;
}>;

export type TragedyDerivedPromiseOutcome =
  | Readonly<{ readonly kind: 'derived'; readonly events: readonly PromiseOutcomeEvent[] }>
  | Readonly<{
      readonly kind: 'rejected';
      readonly reason: 'invalid-input' | 'missing-observation';
    }>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPromise(value: unknown): value is TragedyPublicPromise {
  const sequence = isRecord(value) ? value.sequence : undefined;
  return (
    isRecord(value) &&
    value.version === TRAGEDY_PUBLIC_PROMISE_VERSION &&
    text(value.promiseId) &&
    text(value.promisorPlayerId) &&
    text(value.gameId) &&
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    text(value.expectedActionType)
  );
}

function isObservation(value: unknown): value is TragedyPublicActionObservation {
  const sequence = isRecord(value) ? value.sequence : undefined;
  return (
    isRecord(value) &&
    value.version === TRAGEDY_PUBLIC_ACTION_VERSION &&
    text(value.gameId) &&
    text(value.playerId) &&
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    text(value.actionType)
  );
}

export function deriveTragedyPromiseOutcomes(input: {
  readonly didByPlayerId: Readonly<Record<string, DidPlc>>;
  readonly promises: readonly TragedyPublicPromise[];
  readonly observations: readonly TragedyPublicActionObservation[];
  readonly evidenceByPromiseId: Readonly<Record<string, AtprotoStrongRef>>;
  readonly observedAt: string;
}): TragedyDerivedPromiseOutcome {
  const resolutions = [];
  for (const promise of input.promises) {
    if (!isPromise(promise)) return { kind: 'rejected', reason: 'invalid-input' };
    const observation = input.observations.find(
      (candidate) =>
        isObservation(candidate) &&
        candidate.gameId === promise.gameId &&
        candidate.playerId === promise.promisorPlayerId &&
        candidate.sequence === promise.sequence,
    );
    const evidence = input.evidenceByPromiseId[promise.promiseId];
    if (observation === undefined || evidence === undefined)
      return { kind: 'rejected', reason: 'missing-observation' };
    resolutions.push({
      resolutionVersion: 'tragedy-promise-resolution/v1',
      visibility: 'public',
      gameId: promise.gameId,
      sequence: promise.sequence,
      actorPlayerId: promise.promisorPlayerId,
      subjectPlayerId: promise.promisorPlayerId,
      outcome: observation.actionType === promise.expectedActionType ? 'kept' : 'broken',
      observedAt: input.observedAt,
      evidence,
    });
  }
  const mapped: TragedyPromiseOutcomeMapping = mapSettledTragedyPromiseOutcomes({
    gameType: 'tragedy-of-the-commons',
    didByPlayerId: input.didByPlayerId,
    resolutions,
  });
  return mapped.kind === 'mapped'
    ? { kind: 'derived', events: mapped.events }
    : { kind: 'rejected', reason: 'invalid-input' };
}
