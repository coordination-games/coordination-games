import { describe, it, expect, beforeEach } from 'vitest';
import { GameRelay } from '../typed-relay.js';

describe('GameRelay', () => {
  let relay: GameRelay;

  beforeEach(() => {
    relay = new GameRelay([
      { id: 'a1', team: 'A' },
      { id: 'a2', team: 'A' },
      { id: 'b1', team: 'B' },
      { id: 'b2', team: 'B' },
    ]);
  });

  describe('send', () => {
    it('stamps sender, turn, timestamp, and index', () => {
      const msg = relay.send('a1', 3, {
        type: 'messaging',
        data: { body: 'hello' },
        scope: 'team',
        pluginId: 'basic-chat',
      });

      expect(msg.sender).toBe('a1');
      expect(msg.turn).toBe(3);
      expect(msg.timestamp).toBeGreaterThan(0);
      expect(msg.index).toBe(0);
      expect(msg.type).toBe('messaging');
      expect(msg.pluginId).toBe('basic-chat');
    });

    it('increments index for each message', () => {
      const m1 = relay.send('a1', 1, { type: 'messaging', data: {}, scope: 'all', pluginId: 'chat' });
      const m2 = relay.send('a2', 1, { type: 'messaging', data: {}, scope: 'all', pluginId: 'chat' });
      expect(m1.index).toBe(0);
      expect(m2.index).toBe(1);
    });
  });

  describe('scope routing', () => {
    it('all scope: delivers to everyone except sender', () => {
      relay.send('a1', 1, { type: 'messaging', data: { body: 'hi all' }, scope: 'all', pluginId: 'chat' });

      expect(relay.receive('a1')).toHaveLength(0); // sender doesn't get own message
      expect(relay.receive('a2')).toHaveLength(1);
      expect(relay.receive('b1')).toHaveLength(1);
      expect(relay.receive('b2')).toHaveLength(1);
    });

    it('team scope: delivers only to teammates', () => {
      relay.send('a1', 1, { type: 'messaging', data: { body: 'team only' }, scope: 'team', pluginId: 'chat' });

      expect(relay.receive('a2')).toHaveLength(1); // same team
      expect(relay.receive('b1')).toHaveLength(0); // different team
      expect(relay.receive('b2')).toHaveLength(0); // different team
    });

    it('DM scope: delivers only to target agent', () => {
      relay.send('a1', 1, { type: 'messaging', data: { body: 'psst' }, scope: 'b1', pluginId: 'chat' });

      expect(relay.receive('b1')).toHaveLength(1); // target
      expect(relay.receive('b2')).toHaveLength(0); // not target
      expect(relay.receive('a2')).toHaveLength(0); // not target
    });
  });

  describe('cursor tracking', () => {
    it('returns only new messages since last receive', () => {
      relay.send('a1', 1, { type: 'messaging', data: { body: 'first' }, scope: 'all', pluginId: 'chat' });
      const batch1 = relay.receive('b1');
      expect(batch1).toHaveLength(1);

      // Second call returns nothing (cursor advanced)
      const batch2 = relay.receive('b1');
      expect(batch2).toHaveLength(0);

      // New message after cursor
      relay.send('a2', 2, { type: 'messaging', data: { body: 'second' }, scope: 'all', pluginId: 'chat' });
      const batch3 = relay.receive('b1');
      expect(batch3).toHaveLength(1);
      expect((batch3[0].data as any).body).toBe('second');
    });

    it('cursors are per-agent', () => {
      relay.send('a1', 1, { type: 'messaging', data: {}, scope: 'all', pluginId: 'chat' });

      relay.receive('b1'); // advances b1's cursor
      expect(relay.receive('b2')).toHaveLength(1); // b2 hasn't read yet
    });
  });

  describe('hasNewMessages', () => {
    it('returns true when there are unread messages', () => {
      relay.send('a1', 1, { type: 'messaging', data: {}, scope: 'all', pluginId: 'chat' });
      expect(relay.hasNewMessages('b1')).toBe(true);
    });

    it('returns false after reading', () => {
      relay.send('a1', 1, { type: 'messaging', data: {}, scope: 'all', pluginId: 'chat' });
      relay.receive('b1');
      expect(relay.hasNewMessages('b1')).toBe(false);
    });

    it('returns false for own messages', () => {
      relay.send('a1', 1, { type: 'messaging', data: {}, scope: 'all', pluginId: 'chat' });
      expect(relay.hasNewMessages('a1')).toBe(false);
    });

    it('respects scope filtering', () => {
      relay.send('a1', 1, { type: 'messaging', data: {}, scope: 'team', pluginId: 'chat' });
      expect(relay.hasNewMessages('a2')).toBe(true);  // same team
      expect(relay.hasNewMessages('b1')).toBe(false);  // different team
    });
  });

  describe('spectator view', () => {
    it('returns all messages up to a turn regardless of scope', () => {
      relay.send('a1', 1, { type: 'messaging', data: { body: 'team msg' }, scope: 'team', pluginId: 'chat' });
      relay.send('b1', 2, { type: 'messaging', data: { body: 'all msg' }, scope: 'all', pluginId: 'chat' });
      relay.send('a1', 3, { type: 'messaging', data: { body: 'dm' }, scope: 'b1', pluginId: 'chat' });

      const turn2 = relay.getSpectatorMessages(2);
      expect(turn2).toHaveLength(2); // turn 1 and 2, not turn 3

      const turn3 = relay.getSpectatorMessages(3);
      expect(turn3).toHaveLength(3); // all messages, all scopes
    });
  });

  describe('type agnostic', () => {
    it('routes different types the same way — by scope only', () => {
      relay.send('a1', 1, { type: 'messaging', data: {}, scope: 'team', pluginId: 'chat' });
      relay.send('a1', 1, { type: 'vision-update', data: {}, scope: 'team', pluginId: 'shared-vision' });
      relay.send('a1', 1, { type: 'wiki-post', data: {}, scope: 'all', pluginId: 'wiki' });

      const teamA = relay.receive('a2');
      expect(teamA).toHaveLength(3); // gets all — messaging, vision, wiki
      expect(teamA.map(m => m.type)).toEqual(['messaging', 'vision-update', 'wiki-post']);

      const teamB = relay.receive('b1');
      expect(teamB).toHaveLength(1); // only the 'all' scoped wiki-post
      expect(teamB[0].type).toBe('wiki-post');
    });
  });

  describe('getAllMessages', () => {
    it('returns complete log', () => {
      relay.send('a1', 1, { type: 'messaging', data: {}, scope: 'all', pluginId: 'chat' });
      relay.send('b1', 2, { type: 'messaging', data: {}, scope: 'team', pluginId: 'chat' });

      const all = relay.getAllMessages();
      expect(all).toHaveLength(2);
    });
  });
});
