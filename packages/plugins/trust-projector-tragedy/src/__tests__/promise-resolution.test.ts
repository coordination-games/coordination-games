import { deriveTournamentRoomName, keccak256CanonicalJson } from '@coordination-games/engine';
import { TragedyOfTheCommonsV2Plugin } from '@coordination-games/game-tragedy-of-the-commons';
import { describe, expect, it } from 'vitest';
import {
  TRAGEDY_ACTION_SOURCE_VERSION,
  TRAGEDY_PROMISE_EVIDENCE_VERSION,
  TRAGEDY_PROMISE_TRANSCRIPT_VERSION,
  verifyTragedyPromiseEvidence,
} from '../promise-evidence.js';
import {
  commitTragedyPublicPromises,
  resolveTragedyPublicPromise,
  TRAGEDY_PROMISE_ACTION_TYPES,
  TRAGEDY_PROMISE_DERIVATION_VERSION,
  TRAGEDY_PUBLIC_ACTION_VERSION,
  TRAGEDY_PUBLIC_PROMISE_VERSION,
} from '../promise-resolution.js';

const TOURNAMENT_ID = 'task-15-trust-demo';
const GAME_ID = deriveTournamentRoomName(TOURNAMENT_ID, 0);

function promise(expectedActionType: 'build_road' | 'pass' = 'pass') {
  return {
    version: TRAGEDY_PUBLIC_PROMISE_VERSION,
    visibility: 'public',
    promiseId: 'promise-game-zero-mint-round-one',
    tournamentId: TOURNAMENT_ID,
    gameIndex: 0,
    gameId: GAME_ID,
    round: 1,
    promisorPlayerId: 'mint-mediator',
    expectedActionType,
  } as const;
}

function committedPromise() {
  const result = commitTragedyPublicPromises([promise()]);
  if (result.kind !== 'committed') throw new Error('promise fixture must commit');
  const commitment = result.commitments[0];
  if (commitment === undefined) throw new Error('promise fixture commitment missing');
  return commitment;
}

function evidenceFixture() {
  const commitment = committedPromise();
  const botDecision = {
    eventIndex: 11,
    kind: 'bot_decision',
    gameId: GAME_ID,
    playerId: 'mint-mediator',
    round: 1,
    actionType: 'pass',
  } as const;
  const actionResult = {
    eventIndex: 12,
    kind: 'action_result',
    gameId: GAME_ID,
    playerId: 'mint-mediator',
    actionType: 'pass',
    phase: 'playing',
  } as const;
  const settlement = {
    eventIndex: 30,
    kind: 'settlement',
    gameId: GAME_ID,
    treasuryDelta: '75',
  } as const;
  const sourceEventHash = keccak256CanonicalJson({
    version: TRAGEDY_ACTION_SOURCE_VERSION,
    botDecision,
    actionResult,
  });
  const observation = {
    version: TRAGEDY_PUBLIC_ACTION_VERSION,
    visibility: 'public',
    gameId: GAME_ID,
    playerId: 'mint-mediator',
    round: 1,
    actionType: 'pass',
    botDecisionEventIndex: botDecision.eventIndex,
    actionResultEventIndex: actionResult.eventIndex,
    sourceEventHash,
  } as const;
  const resolved = resolveTragedyPublicPromise(commitment.promise, observation);
  if (resolved.kind !== 'resolved') throw new Error('evidence fixture must resolve');
  const transcript = {
    version: TRAGEDY_PROMISE_TRANSCRIPT_VERSION,
    botDecision,
    actionResult,
    settlement,
    digest: keccak256CanonicalJson({
      version: TRAGEDY_PROMISE_TRANSCRIPT_VERSION,
      botDecision,
      actionResult,
      settlement,
    }),
  } as const;
  return {
    version: TRAGEDY_PROMISE_EVIDENCE_VERSION,
    derivationVersion: TRAGEDY_PROMISE_DERIVATION_VERSION,
    commitment,
    observation,
    transcript,
    resolvedOutcome: resolved.outcome,
  } as const;
}

describe('Tragedy public promise resolution', () => {
  it('uses exactly the public Tragedy V2 game action types', () => {
    const gameTools = TragedyOfTheCommonsV2Plugin.gameTools ?? [];
    expect(Object.keys(TRAGEDY_PROMISE_ACTION_TYPES).sort()).toEqual(
      gameTools.map((tool) => tool.name).sort(),
    );
  });

  it('rejects post-hoc, private, extra-key, and arbitrary-action promise terms', () => {
    const invalidPromises: readonly unknown[] = [
      { ...promise(), observedActionType: 'pass' },
      { ...promise(), visibility: 'private' },
      { ...promise(), privateReasoning: 'pass looked likely' },
      { ...promise(), expectedActionType: 'invented_action' },
    ];

    for (const candidate of invalidPromises) {
      expect(commitTragedyPublicPromises([candidate])).toEqual({
        kind: 'rejected',
        reason: 'invalid-promise',
      });
    }
  });

  it('rejects duplicate promise identities and deterministic targets', () => {
    expect(commitTragedyPublicPromises([promise(), promise('build_road')])).toEqual({
      kind: 'rejected',
      reason: 'duplicate-promise-id',
    });
    expect(
      commitTragedyPublicPromises([
        promise(),
        { ...promise('build_road'), promiseId: 'different-promise-id' },
      ]),
    ).toEqual({ kind: 'rejected', reason: 'duplicate-promise-target' });
  });

  it('resolves one kept and one broken result only from matching public observations', () => {
    const keptCommitment = committedPromise();
    const observation = evidenceFixture().observation;
    const brokenCommitment = commitTragedyPublicPromises([
      { ...promise('build_road'), promiseId: 'different-promise-id' },
    ]);
    if (brokenCommitment.kind !== 'committed') throw new Error('broken fixture must commit');

    expect(resolveTragedyPublicPromise(keptCommitment.promise, observation)).toMatchObject({
      kind: 'resolved',
      outcome: 'kept',
    });
    expect(
      resolveTragedyPublicPromise(brokenCommitment.commitments[0]?.promise, observation),
    ).toMatchObject({ kind: 'resolved', outcome: 'broken' });
  });

  it('rejects missing and wrong observations', () => {
    const commitment = committedPromise();
    const observation = evidenceFixture().observation;

    expect(resolveTragedyPublicPromise(commitment.promise, undefined)).toMatchObject({
      kind: 'rejected',
    });
    expect(
      resolveTragedyPublicPromise(commitment.promise, { ...observation, playerId: 'ash-builder' }),
    ).toEqual({ kind: 'rejected', reason: 'observation-mismatch' });
  });

  it('verifies an untampered evidence bundle and rejects promise, action, or source tampering', () => {
    const evidence = evidenceFixture();
    expect(verifyTragedyPromiseEvidence(evidence)).toMatchObject({ kind: 'verified' });

    const tampered = [
      {
        ...evidence,
        commitment: {
          ...evidence.commitment,
          promise: { ...evidence.commitment.promise, round: 2 },
        },
      },
      { ...evidence, observation: { ...evidence.observation, actionType: 'build_road' } },
      {
        ...evidence,
        transcript: {
          ...evidence.transcript,
          actionResult: { ...evidence.transcript.actionResult, actionType: 'build_road' },
        },
      },
    ];
    for (const candidate of tampered) {
      expect(verifyTragedyPromiseEvidence(candidate)).toMatchObject({ kind: 'rejected' });
    }
  });
});
