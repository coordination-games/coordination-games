/**
 * Kibitzer plugin acceptance tests (Phase 5.4).
 *
 * Two layers:
 *  1. Server: handleRelay reacts to chat envelopes and emits a kibitzer
 *     comment every Nth message. handleCall('comment') forces an emit.
 *     Schema rejects malformed bodies before they reach the wire.
 *  2. Web: selectCommentary dedupes by `seq` and orders ascending.
 *
 * No DOM is exercised here — `selectCommentary` is the pure data slice;
 * the React component is a thin wrapper that the smoke test (manual)
 * covers when wrangler dev is running.
 */

import {
  clearRelayRegistry,
  type RelayEnvelope,
  RelayUnknownTypeError,
  RelayValidationError,
  registerPluginRelayTypes,
  validateRelayBody,
} from '@coordination-games/engine';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KIBITZER_COMMENT_TYPE,
  KIBITZER_PLUGIN_ID,
  KibitzerCommentSchema,
  renderCommentary,
} from '../index.js';
import { createKibitzerServerPlugin, type KibitzerRelayCap } from '../server.js';
import { selectCommentary } from '../web/CommentaryFeed.js';

// Reset and re-register the schema between tests — the relay registry is
// process-global, and `clearRelayRegistry` wipes it.
afterEach(() => {
  clearRelayRegistry();
  registerPluginRelayTypes({
    id: KIBITZER_PLUGIN_ID,
    relayTypes: { [KIBITZER_COMMENT_TYPE]: KibitzerCommentSchema },
  });
});

/** Minimal in-memory RelayClient stand-in. Captures publishes for inspection. */
function makeFakeRelay(): KibitzerRelayCap & { published: RelayEnvelope[] } {
  const published: RelayEnvelope[] = [];
  let idx = 0;
  return {
    published,
    async publish(env) {
      // Validate against the registry exactly like DOStorageRelayClient does
      // — proves end-to-end that kibitzer envelopes pass the same gate.
      validateRelayBody(env.type, env.data);
      published.push({
        ...env,
        index: idx++,
        timestamp: Date.now(),
      } as RelayEnvelope);
    },
  };
}

function chatEnv(turn: number): RelayEnvelope {
  return {
    index: turn,
    type: 'messaging',
    pluginId: 'basic-chat',
    sender: `player-${turn}`,
    scope: { kind: 'all' },
    turn,
    timestamp: 1_000_000 + turn,
    data: { body: `hello ${turn}` },
  };
}

describe('kibitzer schema', () => {
  it('accepts a well-formed comment body', () => {
    const parsed = validateRelayBody<{ text: string; seq: number }>(KIBITZER_COMMENT_TYPE, {
      text: 'hi there',
      seq: 0,
    });
    expect(parsed.text).toBe('hi there');
    expect(parsed.seq).toBe(0);
  });

  it('rejects bodies missing required fields', () => {
    expect(() => validateRelayBody(KIBITZER_COMMENT_TYPE, { text: 'no seq' })).toThrow(
      RelayValidationError,
    );
  });

  it('rejects extra keys (strict schema)', () => {
    expect(() =>
      validateRelayBody(KIBITZER_COMMENT_TYPE, { text: 'hi', seq: 0, extra: 'nope' }),
    ).toThrow(RelayValidationError);
  });

  it('throws RelayUnknownTypeError after the registry is cleared', () => {
    clearRelayRegistry();
    expect(() => validateRelayBody(KIBITZER_COMMENT_TYPE, { text: 'hi', seq: 0 })).toThrow(
      RelayUnknownTypeError,
    );
  });
});

describe('renderCommentary', () => {
  it('cycles through templates by seq', () => {
    const a = renderCommentary(0, 1);
    const b = renderCommentary(1, 1);
    expect(a).not.toBe(b);
  });

  it('substitutes {n} with the message count', () => {
    // template index 2 contains `{n}` per the COMMENTARY_TEMPLATES list
    const out = renderCommentary(2, 42);
    expect(out).toContain('42');
  });
});

describe('createKibitzerServerPlugin', () => {
  it('emits a comment after every Nth chat envelope', async () => {
    const relay = makeFakeRelay();
    const plugin = createKibitzerServerPlugin({ commentEvery: 3 });
    await plugin.init({ relay }, { gameId: 'g-test' });

    await plugin.handleRelay(chatEnv(1));
    await plugin.handleRelay(chatEnv(2));
    expect(relay.published).toHaveLength(0);
    await plugin.handleRelay(chatEnv(3));
    expect(relay.published).toHaveLength(1);

    const env = relay.published[0];
    if (!env) throw new Error('expected published envelope');
    expect(env.type).toBe(KIBITZER_COMMENT_TYPE);
    expect(env.scope).toEqual({ kind: 'all' });
    expect(env.sender).toBe('kibitzer');
    expect(env.pluginId).toBe(KIBITZER_PLUGIN_ID);
    expect((env.data as { seq: number }).seq).toBe(0);

    await plugin.handleRelay(chatEnv(4));
    await plugin.handleRelay(chatEnv(5));
    await plugin.handleRelay(chatEnv(6));
    expect(relay.published).toHaveLength(2);
    const env2 = relay.published[1];
    if (!env2) throw new Error('expected second published envelope');
    expect((env2.data as { seq: number }).seq).toBe(1);
  });

  it('ignores non-chat envelopes', async () => {
    const relay = makeFakeRelay();
    const plugin = createKibitzerServerPlugin({ commentEvery: 1 });
    await plugin.init({ relay }, { gameId: 'g-test' });

    // Settlement-shaped envelope — kibitzer should NOT count it.
    const settlement: RelayEnvelope = {
      index: 0,
      type: 'settlement:tick',
      pluginId: 'settlement',
      sender: 'system',
      scope: { kind: 'all' },
      turn: 1,
      timestamp: 0,
      data: {},
    };
    await plugin.handleRelay(settlement);
    expect(relay.published).toHaveLength(0);
  });

  it('handleCall("comment") forces an emit', async () => {
    const relay = makeFakeRelay();
    const plugin = createKibitzerServerPlugin({ commentEvery: 0 });
    await plugin.init({ relay }, { gameId: 'g-test' });

    const result = (await plugin.handleCall('comment', { text: 'manual', turn: 7 })) as {
      ok: boolean;
      seq: number;
    };
    expect(result.ok).toBe(true);
    expect(relay.published).toHaveLength(1);
    const env = relay.published[0];
    if (!env) throw new Error('expected published envelope');
    expect(env.type).toBe(KIBITZER_COMMENT_TYPE);
    expect((env.data as { text: string }).text).toBe('manual');
    expect(env.turn).toBe(7);
  });

  it('handleCall("state") returns chatCount + seq', async () => {
    const relay = makeFakeRelay();
    const plugin = createKibitzerServerPlugin({ commentEvery: 2 });
    await plugin.init({ relay }, { gameId: 'g-test' });

    await plugin.handleRelay(chatEnv(1));
    await plugin.handleRelay(chatEnv(2));
    const state = (await plugin.handleCall('state', {})) as { chatCount: number; seq: number };
    expect(state.chatCount).toBe(2);
    expect(state.seq).toBe(1);
  });

  it('declares ["relay"] as its only required cap', () => {
    const plugin = createKibitzerServerPlugin();
    expect(plugin.requires).toEqual(['relay']);
  });

  it('dispose() clears state for re-registration', async () => {
    const relay = makeFakeRelay();
    const plugin = createKibitzerServerPlugin({ commentEvery: 2 });
    await plugin.init({ relay }, { gameId: 'g-test' });

    await plugin.handleRelay(chatEnv(1));
    await plugin.handleRelay(chatEnv(2));
    expect(relay.published).toHaveLength(1);

    await plugin.dispose();
    // After dispose the plugin shouldn't publish — relay cap is null and
    // would throw if `handleRelay` somehow tried to emit. Since the
    // counter resets to 0 after dispose, two more chat envelopes won't
    // hit the modulo boundary either.
    await plugin.handleRelay(chatEnv(3)); // counter 1
    expect(relay.published).toHaveLength(1);
  });
});

describe('selectCommentary (web slice)', () => {
  it('returns [] for empty / undefined relay', () => {
    expect(selectCommentary(undefined)).toEqual([]);
    expect(selectCommentary([])).toEqual([]);
  });

  it('filters out non-kibitzer envelopes', () => {
    const items = selectCommentary([
      { type: 'messaging', data: { body: 'hi' }, timestamp: 1 },
      { type: KIBITZER_COMMENT_TYPE, data: { seq: 0, text: 'one' }, timestamp: 2 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('one');
  });

  it('dedupes by seq, keeping the last-seen entry', () => {
    const items = selectCommentary([
      { type: KIBITZER_COMMENT_TYPE, data: { seq: 0, text: 'first' }, timestamp: 1 },
      { type: KIBITZER_COMMENT_TYPE, data: { seq: 0, text: 'second' }, timestamp: 2 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('second');
  });

  it('caps at 5 visible lines', () => {
    const envs = Array.from({ length: 12 }, (_, i) => ({
      type: KIBITZER_COMMENT_TYPE,
      data: { seq: i, text: `line ${i}` },
      timestamp: i,
    }));
    const items = selectCommentary(envs);
    expect(items).toHaveLength(5);
    expect(items[0]?.seq).toBe(7);
    expect(items[4]?.seq).toBe(11);
  });

  it('drops malformed entries silently', () => {
    const items = selectCommentary([
      { type: KIBITZER_COMMENT_TYPE, data: { text: 'no seq' }, timestamp: 1 },
      { type: KIBITZER_COMMENT_TYPE, data: { seq: 'bad', text: 'wrong type' }, timestamp: 2 },
      { type: KIBITZER_COMMENT_TYPE, data: { seq: 3, text: 'good' }, timestamp: 3 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('good');
  });
});
