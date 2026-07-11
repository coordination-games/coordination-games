import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  computeTournamentPolicyHash,
  createHiddenHorizonPublicConfig,
  parseBytes32Hex,
  serializeHiddenHorizonPublicConfig,
  type TournamentPolicy,
} from '../index.js';

const SECRET = parseBytes32Hex(`0x${'11'.repeat(32)}`);
const DIGEST = parseBytes32Hex(`0x${'22'.repeat(32)}`);
const COMMITMENT = parseBytes32Hex(`0x${'33'.repeat(32)}`);
const FAKE_POLICY_HASH = parseBytes32Hex(`0x${'44'.repeat(32)}`);
const POLICY: TournamentPolicy = {
  seriesLength: 3,
  baseEntryCost: 12_500_000n,
  carryBps: 2_500,
  slashBps: 500,
  minRounds: 2,
  maxRounds: 9,
  hazardNumerator: 1,
  hazardDenominator: 4,
};
const POLICY_HASH = computeTournamentPolicyHash(POLICY);

describe('hidden-horizon public serialization', () => {
  it('returns a frozen plain object with an explicit stable key order', () => {
    // Given a public commitment and validated distribution policy
    // When the agent-visible config is created
    const config = createHiddenHorizonPublicConfig(COMMITMENT, POLICY);

    // Then only the declared public fields exist, in protocol order
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.keys(config)).toEqual([
      'commitment',
      'policyHash',
      'minRounds',
      'maxRounds',
      'hazardNumerator',
      'hazardDenominator',
    ]);
    expect(config).toEqual({
      commitment: COMMITMENT,
      policyHash: POLICY_HASH,
      minRounds: 2,
      maxRounds: 9,
      hazardNumerator: 1,
      hazardDenominator: 4,
    });
  });

  it('reprojects adversarial spread and nested inputs so private aliases cannot leak', () => {
    // Given policy-shaped input polluted through object spread and nested private aliases
    const adversarialPolicy = {
      ...POLICY,
      policyHash: FAKE_POLICY_HASH,
      secret: SECRET,
      prfDigest: DIGEST,
      stopRound: 6,
      realizedEndpoint: 6,
      hiddenHorizon: {
        seed: SECRET,
        result: 6,
      },
      privatePayload: {
        digest: DIGEST,
      },
    };

    // When both the public object and canonical bytes are serialized
    const config = createHiddenHorizonPublicConfig(COMMITMENT, adversarialPolicy);
    const canonicalJson = canonicalizeJson(config);
    const jsonSerialized = JSON.stringify(config);
    const serializedJson = new TextDecoder().decode(
      serializeHiddenHorizonPublicConfig(COMMITMENT, adversarialPolicy),
    );

    // Then neither values nor key aliases for hidden state survive explicit reprojection
    for (const publicOutput of [canonicalJson, jsonSerialized, serializedJson]) {
      expect(publicOutput).not.toContain(SECRET);
      expect(publicOutput).not.toContain(DIGEST);
      expect(publicOutput).not.toContain(FAKE_POLICY_HASH);
      expect(publicOutput).not.toMatch(
        /secret|prf|digest|stopRound|realized|endpoint|hiddenHorizon|seed|result|privatePayload/i,
      );
    }
    expect(serializedJson).toBe(canonicalJson);
  });

  it('changes canonical serialized bytes when the public policy changes', () => {
    // Given two valid public policies
    const changedPolicy = {
      ...POLICY,
      seriesLength: 4,
    };

    // When each public config is serialized
    const baseline = serializeHiddenHorizonPublicConfig(COMMITMENT, POLICY);
    const changed = serializeHiddenHorizonPublicConfig(COMMITMENT, changedPolicy);

    // Then canonical public bytes bind the visible policy
    expect(changed).not.toEqual(baseline);
  });

  it('ignores an injected policyHash and publishes the internally computed hash', () => {
    // Given a full policy polluted by an object-spread hash that does not match it
    const injectedPolicy = { ...POLICY, policyHash: FAKE_POLICY_HASH };

    // When the public config and canonical bytes are created
    const config = createHiddenHorizonPublicConfig(COMMITMENT, injectedPolicy);
    const serialized = new TextDecoder().decode(
      serializeHiddenHorizonPublicConfig(COMMITMENT, injectedPolicy),
    );

    // Then the injected hash is discarded and the full-policy hash is published
    expect(config.policyHash).toBe(computeTournamentPolicyHash(POLICY));
    expect(config.policyHash).not.toBe(FAKE_POLICY_HASH);
    expect(serialized).not.toContain(FAKE_POLICY_HASH);
  });

  it.each([
    ['commitment', 'bad', POLICY],
    ['seriesLength', COMMITMENT, { ...POLICY, seriesLength: 0 }],
    ['maxRounds', COMMITMENT, { ...POLICY, maxRounds: 65_536 }],
  ])('rejects malformed public field %s at runtime', (field, commitment, policy) => {
    expect(() =>
      Reflect.apply(createHiddenHorizonPublicConfig, undefined, [commitment, policy]),
    ).toThrow(expect.objectContaining({ field }));
  });
});
