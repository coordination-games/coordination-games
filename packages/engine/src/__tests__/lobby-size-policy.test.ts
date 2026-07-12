import { describe, expect, it } from 'vitest';
import {
  defineLobbySizePolicy,
  LobbySizeError,
  LobbySizePolicyError,
  resolveLobbySize,
} from '../lobby-size-policy.js';
import { OpenQueuePhase } from '../phases/open-queue.js';

const TEAM_SIZE_POLICY = defineLobbySizePolicy({
  min: 2,
  max: 6,
  default: 2,
  unit: 'team-size',
});

describe('lobby size policy', () => {
  it('freezes a valid policy without changing its wire semantics', () => {
    // Given / When
    const policy = defineLobbySizePolicy({
      min: 4,
      max: 20,
      default: 4,
      unit: 'player-count',
    });

    // Then
    expect(policy).toEqual({ min: 4, max: 20, default: 4, unit: 'player-count' });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each([
    { min: 0, max: 6, default: 2, unit: 'team-size' as const },
    { min: 2.5, max: 6, default: 3, unit: 'team-size' as const },
    { min: 7, max: 6, default: 7, unit: 'team-size' as const },
    { min: 2, max: 6, default: 1, unit: 'team-size' as const },
    { min: 2, max: 6, default: 7, unit: 'team-size' as const },
  ])('rejects invalid policy invariants for $min/$max/$default', (policy) => {
    // Given / When / Then
    expect(() => defineLobbySizePolicy(policy)).toThrowError(LobbySizePolicyError);
  });

  it.each([
    { raw: undefined, expected: 2 },
    { raw: 2, expected: 2 },
    { raw: 6, expected: 6 },
  ])('resolves governed value $raw to $expected', ({ raw, expected }) => {
    // Given / When
    const size = resolveLobbySize(raw, TEAM_SIZE_POLICY);

    // Then
    expect(size).toBe(expected);
  });

  it.each([
    '2',
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2.5,
    1,
    7,
  ])('rejects unsupported governed value %s', (raw) => {
    // Given / When / Then
    expect(() => resolveLobbySize(raw, TEAM_SIZE_POLICY)).toThrowError(LobbySizeError);
  });

  it('preserves the generic 1-20 policy and caller default when no policy is declared', () => {
    // Given / When
    const defaultSize = resolveLobbySize(undefined, undefined, 3);
    const minimum = resolveLobbySize(1, undefined, 3);
    const maximum = resolveLobbySize(20, undefined, 3);

    // Then
    expect({ defaultSize, minimum, maximum }).toEqual({ defaultSize: 3, minimum: 1, maximum: 20 });
    expect(() => resolveLobbySize(0, undefined, 3)).toThrowError(LobbySizeError);
    expect(() => resolveLobbySize(21, undefined, 3)).toThrowError(LobbySizeError);
  });
});

describe('OpenQueuePhase governed initialization', () => {
  const phase = new OpenQueuePhase(2, TEAM_SIZE_POLICY);

  it.each([2, 6])('accepts exact team-size policy bound %d', (teamSize) => {
    // Given / When
    const state = phase.init([], { teamSize });

    // Then
    expect(state.target).toBe(teamSize);
    expect(phase.capacity(state)).toBe(teamSize);
  });

  it.each([1, 7, 2.5])('fails closed for invalid governed team size %d', (teamSize) => {
    // Given / When / Then
    expect(() => phase.init([], { teamSize })).toThrowError(LobbySizeError);
  });

  it('uses the policy default when the wire size is omitted', () => {
    // Given / When
    const state = phase.init([], {});

    // Then
    expect(state.target).toBe(TEAM_SIZE_POLICY.default);
  });
});
