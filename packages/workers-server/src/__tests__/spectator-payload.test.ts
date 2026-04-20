/**
 * Phase 7.1 — buildSpectatorPayload (unified spectator payload).
 *
 * Verifies:
 *   - Pre-window (publicSnapshotIndex === null) returns a `spectator_pending`
 *     payload (no state/relay).
 *   - In-window returns a `state_update` payload with the snapshot, the
 *     viewer-filtered relay, and the next-cursor `meta.sinceIdx`.
 *   - `sinceIdx` is clamped to `[0, relayTip]` server-side — a malicious
 *     or stale client can never read past the tip.
 *   - When no envelopes are returned (empty filter or sinceIdx === tip),
 *     `meta.sinceIdx` echoes the current tip so the next call is a no-op.
 */

import type { RelayEnvelope } from '@coordination-games/engine';
import { describe, expect, it } from 'vitest';
import type { RelayClient, SpectatorViewer } from '../plugins/capabilities.js';
import { buildSpectatorPayload, clampSinceIdx } from '../plugins/spectator-payload.js';

function makeEnv(index: number, scope: RelayEnvelope['scope']): RelayEnvelope {
  return {
    index,
    type: 'messaging',
    pluginId: 'chat',
    sender: 'p1',
    scope,
    turn: null,
    timestamp: 1000 + index,
    data: { msg: `m${index}` },
  };
}

function fakeRelay(envs: RelayEnvelope[]): RelayClient {
  return {
    async publish() {},
    async visibleTo(_viewer: SpectatorViewer) {
      // Mirror DO behavior: spectator only sees `'all'` scope.
      return envs.filter((e) => e.scope.kind === 'all');
    },
    async since(idx: number, _viewer: SpectatorViewer) {
      return envs.filter((e) => e.index >= idx && e.scope.kind === 'all');
    },
    async getTip() {
      return envs.length;
    },
  };
}

describe('clampSinceIdx', () => {
  it('returns undefined when client passes undefined', () => {
    expect(clampSinceIdx(undefined, 100)).toBeUndefined();
  });
  it('clamps negative claims to 0', () => {
    expect(clampSinceIdx(-5, 100)).toBe(0);
  });
  it('clamps over-tip claims to tip (NEVER trust the client)', () => {
    expect(clampSinceIdx(999, 100)).toBe(100);
  });
  it('passes valid claims through and floors fractional values', () => {
    expect(clampSinceIdx(50, 100)).toBe(50);
    expect(clampSinceIdx(50.7, 100)).toBe(50);
  });
  it('treats non-finite claims as 0 (NaN/Infinity both reset)', () => {
    expect(clampSinceIdx(Number.NaN, 100)).toBe(0);
    // Infinity is non-finite — collapse to 0 rather than tip. Either is
    // safe (both yield "no envelopes"), but 0 keeps the rule "non-numeric
    // input is treated as zero" simple to reason about.
    expect(clampSinceIdx(Number.POSITIVE_INFINITY, 100)).toBe(0);
  });
});

describe('buildSpectatorPayload', () => {
  it('emits spectator_pending when publicSnapshotIndex is null', async () => {
    const relay = fakeRelay([]);
    const payload = await buildSpectatorPayload({
      gameId: 'g1',
      gameType: 'capture-the-lobster',
      handles: { p1: 'alice' },
      finished: false,
      publicSnapshotIndex: null,
      state: null,
      viewer: { kind: 'spectator' },
      relay,
      relayTip: 0,
    });
    expect(payload.type).toBe('spectator_pending');
    expect(payload.meta.gameId).toBe('g1');
    expect(payload.meta.progressCounter).toBeNull();
    expect(payload.meta.sinceIdx).toBe(0);
  });

  it('emits state_update with viewer-filtered relay', async () => {
    const envs = [
      makeEnv(0, { kind: 'all' }),
      makeEnv(1, { kind: 'team', teamId: 'A' }),
      makeEnv(2, { kind: 'all' }),
    ];
    const relay = fakeRelay(envs);
    const payload = await buildSpectatorPayload({
      gameId: 'g1',
      gameType: 'capture-the-lobster',
      handles: {},
      finished: false,
      publicSnapshotIndex: 3,
      state: { tiles: [] },
      viewer: { kind: 'spectator' },
      relay,
      relayTip: 3,
    });
    expect(payload.type).toBe('state_update');
    if (payload.type !== 'state_update') return;
    expect(payload.relay.length).toBe(2);
    expect(payload.relay.map((r) => r.index)).toEqual([0, 2]);
    expect(payload.meta.progressCounter).toBe(3);
    // Next-cursor: highest included index + 1
    expect(payload.meta.sinceIdx).toBe(3);
  });

  it('clamps over-tip sinceIdx and returns empty relay with meta.sinceIdx === tip', async () => {
    const envs = [makeEnv(0, { kind: 'all' }), makeEnv(1, { kind: 'all' })];
    const relay = fakeRelay(envs);
    const payload = await buildSpectatorPayload({
      gameId: 'g1',
      gameType: 'capture-the-lobster',
      handles: {},
      finished: false,
      publicSnapshotIndex: 1,
      state: { tiles: [] },
      viewer: { kind: 'spectator' },
      relay,
      relayTip: 2,
      sinceIdx: 999, // attacker-claimed
    });
    if (payload.type !== 'state_update') throw new Error('expected state_update');
    expect(payload.relay).toEqual([]);
    expect(payload.meta.sinceIdx).toBe(2);
  });

  it('returns only envelopes since the clamped cursor', async () => {
    const envs = [
      makeEnv(0, { kind: 'all' }),
      makeEnv(1, { kind: 'all' }),
      makeEnv(2, { kind: 'all' }),
    ];
    const relay = fakeRelay(envs);
    const payload = await buildSpectatorPayload({
      gameId: 'g1',
      gameType: 'capture-the-lobster',
      handles: {},
      finished: false,
      publicSnapshotIndex: 0,
      state: { tiles: [] },
      viewer: { kind: 'spectator' },
      relay,
      relayTip: 3,
      sinceIdx: 1,
    });
    if (payload.type !== 'state_update') throw new Error('expected state_update');
    expect(payload.relay.map((r) => r.index)).toEqual([1, 2]);
    expect(payload.meta.sinceIdx).toBe(3);
  });

  it('echoes tip when filter yields nothing', async () => {
    const envs: RelayEnvelope[] = [];
    const relay = fakeRelay(envs);
    const payload = await buildSpectatorPayload({
      gameId: 'g1',
      gameType: 'capture-the-lobster',
      handles: {},
      finished: false,
      publicSnapshotIndex: 0,
      state: { tiles: [] },
      viewer: { kind: 'spectator' },
      relay,
      relayTip: 5,
    });
    if (payload.type !== 'state_update') throw new Error('expected state_update');
    expect(payload.relay).toEqual([]);
    expect(payload.meta.sinceIdx).toBe(5);
  });
});
