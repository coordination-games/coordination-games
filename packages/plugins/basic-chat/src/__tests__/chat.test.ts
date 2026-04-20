import { describe, expect, it } from 'vitest';
import {
  BasicChatPlugin,
  extractMessages,
  formatChatMessage,
  type RelayMessage,
} from '../index.js';

function makeRelayMessage(overrides: Partial<RelayMessage> = {}): RelayMessage {
  return {
    type: 'messaging',
    data: { body: 'hello' },
    scope: { kind: 'team', teamId: 'A' },
    pluginId: 'basic-chat',
    sender: 'agent_1',
    turn: 1,
    timestamp: Date.now(),
    index: 0,
    ...overrides,
  };
}

describe('formatChatMessage', () => {
  it('formats as team scope during gameplay', () => {
    const msg = formatChatMessage('rush flag', 'in_progress');
    expect(msg.type).toBe('messaging');
    expect(msg.scope).toBe('team');
    expect(msg.data.body).toBe('rush flag');
    expect(msg.pluginId).toBe('basic-chat');
  });

  it('formats as team scope during pre-game', () => {
    const msg = formatChatMessage('pick mage', 'pre_game');
    expect(msg.scope).toBe('team');
  });

  it('formats as all scope during lobby', () => {
    const msg = formatChatMessage('hey everyone', 'lobby');
    expect(msg.scope).toBe('all');
  });

  it('formats as all scope during forming', () => {
    const msg = formatChatMessage('hi', 'forming');
    expect(msg.scope).toBe('all');
  });
});

describe('extractMessages', () => {
  it('converts relay messages to Message format', () => {
    const relay = [makeRelayMessage({ sender: '42', data: { body: 'test' }, turn: 3 })];
    const messages = extractMessages(relay);

    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe('42');
    expect(messages[0].body).toBe('test');
    expect(messages[0].turn).toBe(3);
    expect(messages[0].scope).toBe('team');
    expect(messages[0].tags.source).toBe('basic-chat');
    expect(messages[0].tags.sender).toBe('42');
  });

  it('filters to only messaging type', () => {
    const relay = [
      makeRelayMessage({ type: 'messaging', data: { body: 'chat' } }),
      makeRelayMessage({ type: 'vision-update', data: { tiles: [] } }),
      makeRelayMessage({ type: 'messaging', data: { body: 'another' } }),
    ];
    const messages = extractMessages(relay);
    expect(messages).toHaveLength(2);
  });

  it('handles missing body gracefully', () => {
    const relay = [makeRelayMessage({ data: {} })];
    const messages = extractMessages(relay);
    expect(messages[0].body).toBe('');
  });

  it('preserves existing tags from relay data', () => {
    const relay = [makeRelayMessage({ data: { body: 'hi', tags: { trust: 0.9 } } })];
    const messages = extractMessages(relay);
    expect(messages[0].tags.trust).toBe(0.9);
    expect(messages[0].tags.source).toBe('basic-chat');
  });

  it('handles DM scope by treating as all', () => {
    const relay = [makeRelayMessage({ scope: { kind: 'dm', recipientHandle: 'agent_5' } })];
    const messages = extractMessages(relay);
    expect(messages[0].scope).toBe('all');
  });
});

describe('BasicChatPlugin', () => {
  it('has correct metadata', () => {
    expect(BasicChatPlugin.id).toBe('basic-chat');
    expect(BasicChatPlugin.version).toBe('0.3.0');
    expect(BasicChatPlugin.purity).toBe('pure');
    expect(BasicChatPlugin.modes).toHaveLength(1);
    expect(BasicChatPlugin.modes[0].consumes).toEqual([]);
    expect(BasicChatPlugin.modes[0].provides).toEqual(['messaging']);
  });

  it('produces messaging capability from relay messages', () => {
    const relayMessages = [
      makeRelayMessage({ sender: '1', data: { body: 'hello' }, turn: 1 }),
      makeRelayMessage({ sender: '2', data: { body: 'world' }, turn: 2 }),
    ];

    const inputs = new Map([['relay-messages', relayMessages]]);
    const outputs = BasicChatPlugin.handleData('messaging', inputs);

    const messages = outputs.get('messaging');
    expect(messages).toHaveLength(2);
    expect(messages[0].body).toBe('hello');
    expect(messages[1].body).toBe('world');
  });

  it('returns empty when no relay messages', () => {
    const outputs = BasicChatPlugin.handleData('messaging', new Map());
    expect(outputs.get('messaging')).toEqual([]);
  });

  it('ignores non-messaging relay types', () => {
    const relayMessages = [makeRelayMessage({ type: 'wiki-post', data: { title: 'test' } })];
    const inputs = new Map([['relay-messages', relayMessages]]);
    const outputs = BasicChatPlugin.handleData('messaging', inputs);
    expect(outputs.get('messaging')).toEqual([]);
  });
});
