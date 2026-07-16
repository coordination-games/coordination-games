import { keccak256CanonicalJson } from '@coordination-games/engine';
import {
  TRAGEDY_ACTION_SOURCE_VERSION,
  TRAGEDY_PROMISE_EVIDENCE_VERSION,
  TRAGEDY_PROMISE_TRANSCRIPT_VERSION,
  type TragedyActionResultSource,
  type TragedyBotDecisionSource,
  type TragedyPromiseEvidenceVerification,
  type TragedySettlementSource,
} from './promise-evidence-types.js';
import {
  commitTragedyPublicPromises,
  parseTragedyPublicActionObservation,
  resolveTragedyPublicPromise,
} from './promise-resolution.js';
import {
  isTragedyPromiseActionType,
  TRAGEDY_PROMISE_COMMITMENT_VERSION,
  TRAGEDY_PROMISE_DERIVATION_VERSION,
} from './promise-resolution-types.js';

type RecordValue = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export * from './promise-evidence-types.js';

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function bytes32(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
}

function parseBotDecision(value: unknown): TragedyBotDecisionSource | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['eventIndex', 'kind', 'gameId', 'playerId', 'round', 'actionType']) ||
    !nonnegativeInteger(value.eventIndex) ||
    value.kind !== 'bot_decision' ||
    !text(value.gameId) ||
    !text(value.playerId) ||
    !positiveInteger(value.round) ||
    !isTragedyPromiseActionType(value.actionType)
  ) {
    return null;
  }
  return {
    eventIndex: value.eventIndex,
    kind: 'bot_decision',
    gameId: value.gameId,
    playerId: value.playerId,
    round: value.round,
    actionType: value.actionType,
  };
}

function parseActionResult(value: unknown): TragedyActionResultSource | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['eventIndex', 'kind', 'gameId', 'playerId', 'actionType', 'phase']) ||
    !nonnegativeInteger(value.eventIndex) ||
    value.kind !== 'action_result' ||
    !text(value.gameId) ||
    !text(value.playerId) ||
    !isTragedyPromiseActionType(value.actionType) ||
    (value.phase !== 'waiting' && value.phase !== 'playing' && value.phase !== 'finished')
  ) {
    return null;
  }
  return {
    eventIndex: value.eventIndex,
    kind: 'action_result',
    gameId: value.gameId,
    playerId: value.playerId,
    actionType: value.actionType,
    phase: value.phase,
  };
}

function parseSettlement(value: unknown): TragedySettlementSource | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['eventIndex', 'kind', 'gameId', 'treasuryDelta']) ||
    !nonnegativeInteger(value.eventIndex) ||
    value.kind !== 'settlement' ||
    !text(value.gameId) ||
    typeof value.treasuryDelta !== 'string' ||
    !/^-?\d+$/.test(value.treasuryDelta)
  ) {
    return null;
  }
  return {
    eventIndex: value.eventIndex,
    kind: 'settlement',
    gameId: value.gameId,
    treasuryDelta: value.treasuryDelta,
  };
}

export function hashTragedyActionSource(
  botDecision: TragedyBotDecisionSource,
  actionResult: TragedyActionResultSource,
): `0x${string}` {
  return keccak256CanonicalJson({
    version: TRAGEDY_ACTION_SOURCE_VERSION,
    botDecision,
    actionResult,
  });
}

export function hashTragedyTranscriptProof(
  botDecision: TragedyBotDecisionSource,
  actionResult: TragedyActionResultSource,
  settlement: TragedySettlementSource,
): `0x${string}` {
  return keccak256CanonicalJson({
    version: TRAGEDY_PROMISE_TRANSCRIPT_VERSION,
    botDecision,
    actionResult,
    settlement,
  });
}

export function verifyTragedyPromiseEvidence(value: unknown): TragedyPromiseEvidenceVerification {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'version',
      'derivationVersion',
      'commitment',
      'observation',
      'transcript',
      'resolvedOutcome',
    ]) ||
    value.version !== TRAGEDY_PROMISE_EVIDENCE_VERSION ||
    value.derivationVersion !== TRAGEDY_PROMISE_DERIVATION_VERSION ||
    !isRecord(value.commitment) ||
    !hasOnlyKeys(value.commitment, ['version', 'promise', 'digest']) ||
    value.commitment.version !== TRAGEDY_PROMISE_COMMITMENT_VERSION ||
    !bytes32(value.commitment.digest)
  ) {
    return { kind: 'rejected', reason: 'invalid-evidence' };
  }
  const committed = commitTragedyPublicPromises([value.commitment.promise]);
  const expected = committed.kind === 'committed' ? committed.commitments[0] : undefined;
  if (expected === undefined || expected.digest !== value.commitment.digest)
    return { kind: 'rejected', reason: 'commitment-mismatch' };
  const observation = parseTragedyPublicActionObservation(value.observation);
  if (observation === null) return { kind: 'rejected', reason: 'observation-mismatch' };
  if (
    !isRecord(value.transcript) ||
    !hasOnlyKeys(value.transcript, [
      'version',
      'botDecision',
      'actionResult',
      'settlement',
      'digest',
    ]) ||
    value.transcript.version !== TRAGEDY_PROMISE_TRANSCRIPT_VERSION ||
    !bytes32(value.transcript.digest)
  )
    return { kind: 'rejected', reason: 'invalid-evidence' };
  const botDecision = parseBotDecision(value.transcript.botDecision);
  const actionResult = parseActionResult(value.transcript.actionResult);
  const settlement = parseSettlement(value.transcript.settlement);
  if (botDecision === null || actionResult === null || settlement === null)
    return { kind: 'rejected', reason: 'source-mismatch' };
  const sourceMatches =
    botDecision.eventIndex + 1 === actionResult.eventIndex &&
    actionResult.eventIndex < settlement.eventIndex &&
    botDecision.gameId === observation.gameId &&
    botDecision.playerId === observation.playerId &&
    botDecision.round === observation.round &&
    botDecision.actionType === observation.actionType &&
    actionResult.gameId === observation.gameId &&
    actionResult.playerId === observation.playerId &&
    actionResult.actionType === observation.actionType &&
    settlement.gameId === observation.gameId &&
    observation.botDecisionEventIndex === botDecision.eventIndex &&
    observation.actionResultEventIndex === actionResult.eventIndex &&
    observation.sourceEventHash === hashTragedyActionSource(botDecision, actionResult) &&
    value.transcript.digest === hashTragedyTranscriptProof(botDecision, actionResult, settlement);
  if (!sourceMatches) return { kind: 'rejected', reason: 'source-mismatch' };
  const resolved = resolveTragedyPublicPromise(expected.promise, observation);
  if (resolved.kind !== 'resolved') return { kind: 'rejected', reason: 'observation-mismatch' };
  if (value.resolvedOutcome !== resolved.outcome)
    return { kind: 'rejected', reason: 'outcome-mismatch' };
  return {
    kind: 'verified',
    verified: {
      promise: expected.promise,
      outcome: resolved.outcome,
      sourceEventHash: observation.sourceEventHash,
      transcriptDigest: value.transcript.digest,
      settlementEventIndex: settlement.eventIndex,
    },
  };
}
