import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@coordination-games/engine';
import type { LocalTournamentResult } from '@coordination-games/game-tragedy-of-the-commons';
import {
  hashTragedyActionSource,
  hashTragedyTranscriptProof,
  isTragedyPromiseActionType,
  resolveTragedyPublicPromise,
  TRAGEDY_PROMISE_DERIVATION_VERSION,
  TRAGEDY_PROMISE_EVIDENCE_VERSION,
  TRAGEDY_PROMISE_TRANSCRIPT_VERSION,
  TRAGEDY_PUBLIC_ACTION_VERSION,
  type TragedyActionResultSource,
  type TragedyBotDecisionSource,
  type TragedyPromiseActionType,
  type TragedyPromiseCommitment,
  type TragedyPromiseEvidence,
  type TragedySettlementSource,
} from '@coordination-games/plugin-trust-projector-tragedy';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567' as const;
const SETTLEMENT_DID = 'did:plc:abcdefghijklmnopqrstuvwx' as const;
type RecordValue = Readonly<Record<string, unknown>>;

export class TragedyTrustEvidenceError extends Error {
  readonly name = 'TragedyTrustEvidenceError';

  constructor(readonly reason: string) {
    super(`Tragedy trust evidence failed: ${reason}`);
  }
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32[(value << (5 - bits)) & 31] ?? '';
  return result;
}

export function cidForCanonicalArtifact(artifact: unknown): string {
  const digest = createHash('sha256').update(canonicalizeJson(artifact)).digest();
  return `b${base32(Uint8Array.from([1, 0x55, 0x12, 32, ...digest]))}`;
}

function actionType(event: RecordValue): TragedyPromiseActionType | null {
  if (!isRecord(event.action) || !isTragedyPromiseActionType(event.action.type)) return null;
  return event.action.type;
}

function sourceFor(
  tournament: LocalTournamentResult,
  commitment: TragedyPromiseCommitment,
): Readonly<{
  readonly botDecision: TragedyBotDecisionSource;
  readonly actionResult: TragedyActionResultSource;
  readonly settlement: TragedySettlementSource;
}> {
  const target = commitment.promise;
  const botDecisionEventIndex = tournament.transcript.findIndex(
    (candidate) =>
      candidate.kind === 'bot_decision' &&
      candidate.gameId === target.gameId &&
      candidate.playerId === target.promisorPlayerId &&
      candidate.round === target.round &&
      actionType(candidate) !== null,
  );
  const botEvent = tournament.transcript[botDecisionEventIndex];
  const botActionType = botEvent === undefined ? null : actionType(botEvent);
  if (botEvent === undefined || botActionType === null) {
    throw new TragedyTrustEvidenceError(`missing bot_decision for ${target.promiseId}`);
  }
  const actionResultEventIndex = botDecisionEventIndex + 1;
  const resultEvent = tournament.transcript[actionResultEventIndex];
  const resultActionType = resultEvent === undefined ? null : actionType(resultEvent);
  if (
    resultEvent === undefined ||
    resultEvent.kind !== 'action_result' ||
    resultEvent.gameId !== target.gameId ||
    resultEvent.playerId !== target.promisorPlayerId ||
    resultActionType !== botActionType ||
    (resultEvent.phase !== 'waiting' &&
      resultEvent.phase !== 'playing' &&
      resultEvent.phase !== 'finished')
  ) {
    throw new TragedyTrustEvidenceError(`missing matching action_result for ${target.promiseId}`);
  }
  const settlementEventIndex = tournament.transcript.findIndex(
    (candidate, index) =>
      index > actionResultEventIndex &&
      candidate.kind === 'settlement' &&
      candidate.gameId === target.gameId &&
      typeof candidate.treasuryDelta === 'string',
  );
  const settlementEvent = tournament.transcript[settlementEventIndex];
  if (settlementEvent === undefined || typeof settlementEvent.treasuryDelta !== 'string') {
    throw new TragedyTrustEvidenceError(`missing settlement for ${target.promiseId}`);
  }
  return {
    botDecision: {
      eventIndex: botDecisionEventIndex,
      kind: 'bot_decision',
      gameId: target.gameId,
      playerId: target.promisorPlayerId,
      round: target.round,
      actionType: botActionType,
    },
    actionResult: {
      eventIndex: actionResultEventIndex,
      kind: 'action_result',
      gameId: target.gameId,
      playerId: target.promisorPlayerId,
      actionType: resultActionType,
      phase: resultEvent.phase,
    },
    settlement: {
      eventIndex: settlementEventIndex,
      kind: 'settlement',
      gameId: target.gameId,
      treasuryDelta: settlementEvent.treasuryDelta,
    },
  };
}

export function buildTragedyPromiseEvidence(
  tournament: LocalTournamentResult,
  commitment: TragedyPromiseCommitment,
) {
  const source = sourceFor(tournament, commitment);
  const sourceEventHash = hashTragedyActionSource(source.botDecision, source.actionResult);
  const observation = {
    version: TRAGEDY_PUBLIC_ACTION_VERSION,
    visibility: 'public',
    gameId: commitment.promise.gameId,
    playerId: commitment.promise.promisorPlayerId,
    round: commitment.promise.round,
    actionType: source.botDecision.actionType,
    botDecisionEventIndex: source.botDecision.eventIndex,
    actionResultEventIndex: source.actionResult.eventIndex,
    sourceEventHash,
  } as const;
  const resolved = resolveTragedyPublicPromise(commitment.promise, observation);
  if (resolved.kind !== 'resolved') {
    throw new TragedyTrustEvidenceError(`resolution rejected: ${resolved.reason}`);
  }
  const transcript = {
    version: TRAGEDY_PROMISE_TRANSCRIPT_VERSION,
    ...source,
    digest: hashTragedyTranscriptProof(source.botDecision, source.actionResult, source.settlement),
  } as const;
  const artifact: TragedyPromiseEvidence = {
    version: TRAGEDY_PROMISE_EVIDENCE_VERSION,
    derivationVersion: TRAGEDY_PROMISE_DERIVATION_VERSION,
    commitment,
    observation,
    transcript,
    resolvedOutcome: resolved.outcome,
  };
  return {
    artifact,
    uri: `at://${SETTLEMENT_DID}/app.coordination-games.tragedy-settlement/${commitment.promise.gameId}-${commitment.promise.round}`,
    cid: cidForCanonicalArtifact(artifact),
  } as const;
}
