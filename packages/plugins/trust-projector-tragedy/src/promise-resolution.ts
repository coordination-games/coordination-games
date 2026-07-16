import { deriveTournamentRoomName, keccak256CanonicalJson } from '@coordination-games/engine';
import {
  isTragedyPromiseActionType,
  TRAGEDY_PROMISE_COMMITMENT_VERSION,
  TRAGEDY_PUBLIC_ACTION_VERSION,
  TRAGEDY_PUBLIC_PROMISE_VERSION,
  type TragedyPromiseCommitment,
  type TragedyPromiseCommitmentResult,
  type TragedyPromiseResolution,
  type TragedyPublicActionObservation,
  type TragedyPublicPromise,
} from './promise-resolution-types.js';

type RecordValue = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function bytes32(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
}

export function parseTragedyPublicPromise(value: unknown): TragedyPublicPromise | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'version',
      'visibility',
      'promiseId',
      'tournamentId',
      'gameIndex',
      'gameId',
      'round',
      'promisorPlayerId',
      'expectedActionType',
    ]) ||
    value.version !== TRAGEDY_PUBLIC_PROMISE_VERSION ||
    value.visibility !== 'public' ||
    !text(value.promiseId) ||
    !text(value.tournamentId) ||
    !nonnegativeInteger(value.gameIndex) ||
    !text(value.gameId) ||
    value.gameId !== deriveTournamentRoomName(value.tournamentId, value.gameIndex) ||
    !positiveInteger(value.round) ||
    !text(value.promisorPlayerId) ||
    !isTragedyPromiseActionType(value.expectedActionType)
  ) {
    return null;
  }
  return {
    version: TRAGEDY_PUBLIC_PROMISE_VERSION,
    visibility: 'public',
    promiseId: value.promiseId,
    tournamentId: value.tournamentId,
    gameIndex: value.gameIndex,
    gameId: value.gameId,
    round: value.round,
    promisorPlayerId: value.promisorPlayerId,
    expectedActionType: value.expectedActionType,
  };
}

export function parseTragedyPublicActionObservation(
  value: unknown,
): TragedyPublicActionObservation | null {
  return isRecord(value) &&
    hasOnlyKeys(value, [
      'version',
      'visibility',
      'gameId',
      'playerId',
      'round',
      'actionType',
      'botDecisionEventIndex',
      'actionResultEventIndex',
      'sourceEventHash',
    ]) &&
    value.version === TRAGEDY_PUBLIC_ACTION_VERSION &&
    value.visibility === 'public' &&
    text(value.gameId) &&
    text(value.playerId) &&
    positiveInteger(value.round) &&
    isTragedyPromiseActionType(value.actionType) &&
    nonnegativeInteger(value.botDecisionEventIndex) &&
    nonnegativeInteger(value.actionResultEventIndex) &&
    bytes32(value.sourceEventHash)
    ? {
        version: TRAGEDY_PUBLIC_ACTION_VERSION,
        visibility: 'public',
        gameId: value.gameId,
        playerId: value.playerId,
        round: value.round,
        actionType: value.actionType,
        botDecisionEventIndex: value.botDecisionEventIndex,
        actionResultEventIndex: value.actionResultEventIndex,
        sourceEventHash: value.sourceEventHash,
      }
    : null;
}

function commitmentFor(promise: TragedyPublicPromise): TragedyPromiseCommitment {
  const version = TRAGEDY_PROMISE_COMMITMENT_VERSION;
  return {
    version,
    promise,
    digest: keccak256CanonicalJson({ version, promise }),
  };
}

export function commitTragedyPublicPromises(
  values: readonly unknown[],
): TragedyPromiseCommitmentResult {
  const commitments: TragedyPromiseCommitment[] = [];
  const promiseIds = new Set<string>();
  const targets = new Set<string>();
  for (const value of values) {
    const promise = parseTragedyPublicPromise(value);
    if (promise === null) return { kind: 'rejected', reason: 'invalid-promise' };
    if (promiseIds.has(promise.promiseId))
      return { kind: 'rejected', reason: 'duplicate-promise-id' };
    const target = `${promise.gameId}:${promise.round}:${promise.promisorPlayerId}`;
    if (targets.has(target)) return { kind: 'rejected', reason: 'duplicate-promise-target' };
    promiseIds.add(promise.promiseId);
    targets.add(target);
    commitments.push(commitmentFor(promise));
  }
  return { kind: 'committed', commitments };
}

export function resolveTragedyPublicPromise(
  promiseValue: unknown,
  observationValue: unknown,
): TragedyPromiseResolution {
  const promise = parseTragedyPublicPromise(promiseValue);
  if (promise === null) return { kind: 'rejected', reason: 'invalid-promise' };
  const observation = parseTragedyPublicActionObservation(observationValue);
  if (observation === null) return { kind: 'rejected', reason: 'invalid-observation' };
  if (
    observation.gameId !== promise.gameId ||
    observation.playerId !== promise.promisorPlayerId ||
    observation.round !== promise.round
  ) {
    return { kind: 'rejected', reason: 'observation-mismatch' };
  }
  return {
    kind: 'resolved',
    outcome: observation.actionType === promise.expectedActionType ? 'kept' : 'broken',
  };
}

export * from './promise-resolution-types.js';
