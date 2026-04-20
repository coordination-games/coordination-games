/**
 * Acceptance tests for Phase 5.1 — chat as a plugin.
 *
 * Two invariants under test:
 *  1. The plugin's ServerPlugin shape returns a chat relay envelope from
 *     `handleCall('chat', ...)` keyed by the same `CHAT_RELAY_TYPE` the
 *     ToolPlugin uses — consumers depend on that constant, never the
 *     literal `'messaging'`.
 *  2. If basic-chat is unloaded (relay registry cleared), no consumer can
 *     publish a chat envelope: `validateRelayBody(CHAT_RELAY_TYPE, ...)`
 *     throws `RelayUnknownTypeError`. Re-registering the plugin restores
 *     the contract.
 *
 * (1) is what gives us "chat is a real plugin"; (2) is what gives us
 * "removing the plugin removes chat — and nothing publishes silently".
 */

import {
  clearRelayRegistry,
  RelayUnknownTypeError,
  registerPluginRelayTypes,
  validateRelayBody,
} from '@coordination-games/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { BasicChatPlugin, BasicChatServerPlugin, CHAT_RELAY_TYPE } from '../index.js';

describe('Phase 5.1 — basic-chat as ServerPlugin', () => {
  afterEach(() => {
    clearRelayRegistry();
    // Re-arm the registry for the next describe block / file. The chat
    // plugin self-registered at import time; clearing the registry above
    // wipes that, so put it back so subsequent tests in the same process
    // (or a follow-up `describe` here) start from the same baseline.
    registerPluginRelayTypes(BasicChatPlugin);
  });

  it('exposes the chat tool via handleCall and emits CHAT_RELAY_TYPE', async () => {
    const result = (await BasicChatServerPlugin.handleCall('chat', {
      message: 'hello',
      scope: 'all',
    })) as { relay: { type: string; data: { body: string }; scope: string; pluginId: string } };

    expect(result.relay.type).toBe(CHAT_RELAY_TYPE);
    expect(result.relay.data.body).toBe('hello');
    expect(result.relay.scope).toBe('all');
    expect(result.relay.pluginId).toBe('basic-chat');
  });

  it('rejects unknown tool names', async () => {
    const result = (await BasicChatServerPlugin.handleCall('not-a-tool', {})) as {
      error?: string;
    };
    expect(result.error).toMatch(/Unknown tool/);
  });

  it('declares the same plugin id as the ToolPlugin half', () => {
    expect(BasicChatServerPlugin.id).toBe(BasicChatPlugin.id);
  });

  it('requires no capabilities (yet) — init runs without caps', async () => {
    expect(BasicChatServerPlugin.requires).toEqual([]);
    await BasicChatServerPlugin.init({}, { gameId: 'g1' });
  });
});

describe('Phase 5.1 acceptance — chat-removed scenario', () => {
  afterEach(() => {
    clearRelayRegistry();
    registerPluginRelayTypes(BasicChatPlugin);
  });

  it('clears the chat schema when basic-chat is unregistered', () => {
    clearRelayRegistry();
    expect(() => validateRelayBody(CHAT_RELAY_TYPE, { body: 'hi' })).toThrow(RelayUnknownTypeError);
  });

  it('re-registering the plugin restores chat', () => {
    clearRelayRegistry();
    expect(() => validateRelayBody(CHAT_RELAY_TYPE, { body: 'hi' })).toThrow(RelayUnknownTypeError);

    registerPluginRelayTypes(BasicChatPlugin);
    const parsed = validateRelayBody<{ body: string }>(CHAT_RELAY_TYPE, { body: 'hi' });
    expect(parsed.body).toBe('hi');
  });
});
