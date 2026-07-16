import { describe, expect, it } from 'vitest';
import { mapSettledTragedyPromiseOutcomes, projectTragedyPromiseTrust } from '../portable-trust.js';

const DID_BY_PLAYER_ID = {
  keeper: 'did:plc:abcdefghijklmnopqrstuvwx',
  breaker: 'did:plc:zyxwvutsrqponmlkjihgfedc',
} as const;

const evidenceFor = (sequence: number) => ({
  uri: `at://did:plc:abcdefghijklmnopqrstuvwx/app.coordination-games.tragedy-settlement/trust-fixture-${sequence}`,
  cid: `bafybeigdyrzt6ic3b7q4tf6h3y2x4cn27lu5ps5h7izngyztby6cd3k6d${sequence === 1 ? 'pa' : 'qa'}`,
});

const input = {
  gameType: 'tragedy-of-the-commons',
  didByPlayerId: DID_BY_PLAYER_ID,
  resolutions: [
    {
      resolutionVersion: 'tragedy-promise-resolution/v1',
      visibility: 'public',
      gameId: 'trust-fixture',
      sequence: 1,
      actorPlayerId: 'keeper',
      subjectPlayerId: 'keeper',
      outcome: 'kept',
      observedAt: '2026-07-16T12:00:00.000Z',
      evidence: evidenceFor(1),
    },
    {
      resolutionVersion: 'tragedy-promise-resolution/v1',
      visibility: 'public',
      gameId: 'trust-fixture',
      sequence: 2,
      actorPlayerId: 'breaker',
      subjectPlayerId: 'breaker',
      outcome: 'broken',
      observedAt: '2026-07-16T12:00:00.000Z',
      evidence: evidenceFor(2),
    },
  ],
} as const;

describe('portable Tragedy promise trust', () => {
  it('maps only public settled-rule kept or broken resolutions through injected DID mappings', () => {
    const mapped = mapSettledTragedyPromiseOutcomes(input);

    expect(mapped).toMatchObject({ kind: 'mapped' });
    if (mapped.kind !== 'mapped') return;
    expect(mapped.events.map((event) => event.outcome)).toEqual(['kept', 'broken']);
    expect(mapped.events.map((event) => event.subjectDid)).toEqual([
      DID_BY_PLAYER_ID.keeper,
      DID_BY_PLAYER_ID.breaker,
    ]);
    expect(mapped.events[0]?.evidence).toEqual(evidenceFor(1));
  });

  it('rejects pending, ambiguous, private, malformed, and unmapped inputs before an attestation exists', () => {
    const cases: readonly unknown[] = [
      { ...input, resolutions: [{ ...input.resolutions[0], outcome: 'pending' }] },
      { ...input, resolutions: [{ ...input.resolutions[0], outcome: 'ambiguous' }] },
      { ...input, resolutions: [{ ...input.resolutions[0], visibility: 'private' }] },
      {
        ...input,
        resolutions: [{ ...input.resolutions[0], evidence: { uri: 'bad', cid: 'bad' } }],
      },
      { ...input, didByPlayerId: { keeper: DID_BY_PLAYER_ID.keeper } },
    ];

    for (const candidate of cases) {
      expect(mapSettledTragedyPromiseOutcomes(candidate)).toMatchObject({ kind: 'rejected' });
    }
  });

  it('deduplicates stable event identities and fails closed on event identity or subject drift', () => {
    const mapped = mapSettledTragedyPromiseOutcomes(input);
    if (mapped.kind !== 'mapped') throw new Error('fixture must map');
    const keeper = mapped.events[0];
    const breaker = mapped.events[1];
    if (keeper === undefined || breaker === undefined) throw new Error('fixture events missing');

    expect(
      projectTragedyPromiseTrust({ subjectDid: DID_BY_PLAYER_ID.keeper, events: [keeper, keeper] }),
    ).toMatchObject({
      kind: 'projected',
      result: {
        outcomes: { kept: 1, broken: 0 },
        reliability: { representation: 'ratio', value: 1 },
      },
    });
    expect(
      projectTragedyPromiseTrust({
        subjectDid: DID_BY_PLAYER_ID.keeper,
        events: [keeper, breaker],
      }),
    ).toMatchObject({ kind: 'rejected', reason: 'subject-drift' });
    expect(
      projectTragedyPromiseTrust({
        subjectDid: DID_BY_PLAYER_ID.keeper,
        events: [keeper, { ...keeper, evidence: evidenceFor(2) }],
      }),
    ).toMatchObject({ kind: 'rejected', reason: 'event-identity-collision' });
  });

  it('returns the versioned unavailable result when a subject has no outcomes', () => {
    expect(projectTragedyPromiseTrust({ subjectDid: DID_BY_PLAYER_ID.keeper, events: [] })).toEqual(
      {
        kind: 'projected',
        result: {
          projectionVersion: 'trust-projection/v1',
          eventSchemaVersion: 'promise-outcome/v1',
          algorithmVersion: 'reliability/v1',
          subjectDid: DID_BY_PLAYER_ID.keeper,
          outcomes: { kept: 0, broken: 0 },
          reliability: { representation: 'unavailable' },
        },
      },
    );
  });
});
