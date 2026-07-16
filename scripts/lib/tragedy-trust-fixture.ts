import { deriveTournamentRoomName } from '@coordination-games/engine';
import { parseTournamentDemoPolicy } from '@coordination-games/game-tragedy-of-the-commons';
import {
  commitTragedyPublicPromises,
  TRAGEDY_PUBLIC_PROMISE_VERSION,
} from '@coordination-games/plugin-trust-projector-tragedy';

export const TRAGEDY_TRUST_DEMO_TOURNAMENT_ID = 'task-15-trust-demo' as const;
export const TRAGEDY_TRUST_DEMO_ANCHORED_AT = '2026-07-16T12:00:00.000Z' as const;
export const TRAGEDY_PROMISE_ORDERING_VERSION = 'tragedy-promise-ordering/v1' as const;
export const TRAGEDY_TRUST_DEMO_DIDS = {
  'mint-mediator': 'did:plc:abcdefghijklmnopqrstuvwx',
  'ash-builder': 'did:plc:zyxwvutsrqponmlkjihgfedc',
  'hot-opportunist': 'did:plc:bcdefghijklmnopqrstuvwxy',
} as const;

export class TragedyTrustFixtureError extends Error {
  readonly name = 'TragedyTrustFixtureError';

  constructor(readonly reason: string) {
    super(`Tragedy trust fixture failed: ${reason}`);
  }
}

function policies() {
  return [
    parseTournamentDemoPolicy(
      {
        botName: 'mint-mediator',
        model: 'MiniMax-M2.5',
        persona: 'A consensus-first commons steward.',
        setup: { startingCamp: 'northWest' },
        roundRule: { action: { type: 'pass' } },
      },
      'trust-demo-mint-mediator.json',
    ),
    parseTournamentDemoPolicy(
      {
        botName: 'ash-builder',
        model: 'MiniMax-M2.5',
        persona: 'A disciplined public-works builder.',
        setup: { startingCamp: 'north' },
        roundRule: { action: { type: 'pass' } },
      },
      'trust-demo-ash-builder.json',
    ),
    parseTournamentDemoPolicy(
      {
        botName: 'hot-opportunist',
        model: 'MiniMax-M2.5',
        persona: 'A short-horizon resource opportunist.',
        setup: { startingCamp: 'south' },
        roundRule: { action: { type: 'pass' } },
      },
      'trust-demo-hot-opportunist.json',
    ),
  ] as const;
}

export function createTragedyTrustDemoFixture() {
  const promiseTerms = [
    {
      version: TRAGEDY_PUBLIC_PROMISE_VERSION,
      visibility: 'public',
      promiseId: 'mint-pass-game-zero-round-one',
      tournamentId: TRAGEDY_TRUST_DEMO_TOURNAMENT_ID,
      gameIndex: 0,
      gameId: deriveTournamentRoomName(TRAGEDY_TRUST_DEMO_TOURNAMENT_ID, 0),
      round: 1,
      promisorPlayerId: 'mint-mediator',
      expectedActionType: 'pass',
    },
    {
      version: TRAGEDY_PUBLIC_PROMISE_VERSION,
      visibility: 'public',
      promiseId: 'ash-road-game-one-round-one',
      tournamentId: TRAGEDY_TRUST_DEMO_TOURNAMENT_ID,
      gameIndex: 1,
      gameId: deriveTournamentRoomName(TRAGEDY_TRUST_DEMO_TOURNAMENT_ID, 1),
      round: 1,
      promisorPlayerId: 'ash-builder',
      expectedActionType: 'build_road',
    },
  ] as const;
  const committed = commitTragedyPublicPromises(promiseTerms);
  if (committed.kind !== 'committed') {
    throw new TragedyTrustFixtureError(`promise commitment rejected: ${committed.reason}`);
  }
  return {
    tournamentInput: {
      tournamentId: TRAGEDY_TRUST_DEMO_TOURNAMENT_ID,
      seed: `0x${'17'.repeat(32)}`,
      playerEntropy: `0x${'29'.repeat(32)}`,
      policies: policies(),
    },
    commitments: committed.commitments,
    ordering: {
      version: TRAGEDY_PROMISE_ORDERING_VERSION,
      promiseCommitments: committed.commitments.map((commitment, order) => ({
        order,
        promiseId: commitment.promise.promiseId,
        digest: commitment.digest,
      })),
      tournamentRunOrder: committed.commitments.length,
    },
  } as const;
}
