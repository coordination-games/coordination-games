/**
 * Type-level + runtime tests for the canonical `RelayEnvelope` engine type.
 *
 * Phase 4.1 collapses the three local `RelayMessage` definitions in LobbyDO,
 * GameRoomDO, and basic-chat into this single shape. The discriminated
 * `RelayScope` union replaces the old `string` scope (where 'all'/'team'
 * were sentinels and any other value was a recipient handle).
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RelayEnvelope, RelayScope } from '../types.js';

describe('RelayEnvelope shape', () => {
  it('sender is a string', () => {
    expectTypeOf<RelayEnvelope['sender']>().toEqualTypeOf<string>();
  });

  it('scope is the discriminated RelayScope union', () => {
    expectTypeOf<RelayEnvelope['scope']>().toEqualTypeOf<RelayScope>();
  });

  it('turn is number | null (null in lobby)', () => {
    expectTypeOf<RelayEnvelope['turn']>().toEqualTypeOf<number | null>();
  });

  it('default body type is unknown', () => {
    expectTypeOf<RelayEnvelope['data']>().toEqualTypeOf<unknown>();
  });

  it('TBody narrows the data field', () => {
    type ChatBody = { body: string };
    expectTypeOf<RelayEnvelope<ChatBody>['data']>().toEqualTypeOf<ChatBody>();
  });
});

describe('RelayScope union narrowing', () => {
  it("kind: 'all' has no payload", () => {
    const s: RelayScope = { kind: 'all' };
    expect(s.kind).toBe('all');
  });

  it("kind: 'team' carries teamId", () => {
    const s: RelayScope = { kind: 'team', teamId: 'A' };
    if (s.kind === 'team') {
      expectTypeOf(s.teamId).toEqualTypeOf<string>();
      expect(s.teamId).toBe('A');
    }
  });

  it("kind: 'dm' carries recipientHandle", () => {
    const s: RelayScope = { kind: 'dm', recipientHandle: 'Clawdia' };
    if (s.kind === 'dm') {
      expectTypeOf(s.recipientHandle).toEqualTypeOf<string>();
      expect(s.recipientHandle).toBe('Clawdia');
    }
  });
});

describe('Constructable envelope', () => {
  it('builds a canonical lobby chat envelope', () => {
    const env: RelayEnvelope<{ body: string }> = {
      index: 0,
      type: 'messaging',
      pluginId: 'basic-chat',
      sender: 'p1',
      scope: { kind: 'all' },
      turn: null,
      timestamp: Date.now(),
      data: { body: 'hello' },
    };
    expect(env.scope.kind).toBe('all');
    expect(env.turn).toBeNull();
  });

  it('builds a canonical game DM envelope', () => {
    const env: RelayEnvelope<{ body: string }> = {
      index: 17,
      type: 'messaging',
      pluginId: 'basic-chat',
      sender: 'p3',
      scope: { kind: 'dm', recipientHandle: 'Clawdia' },
      turn: 5,
      timestamp: Date.now(),
      data: { body: 'pledge 30?' },
    };
    expect(env.scope.kind).toBe('dm');
    expect(env.turn).toBe(5);
  });
});
