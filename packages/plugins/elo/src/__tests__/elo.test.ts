import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEloPlugin, EloTracker } from '../index.js';
import type { AgentInfo } from '@coordination-games/engine';

describe('EloPlugin', () => {
  let plugin: ReturnType<typeof createEloPlugin>;

  beforeEach(() => {
    plugin = createEloPlugin(':memory:');
  });

  afterEach(() => {
    plugin.tracker.close();
  });

  it('has correct plugin metadata', () => {
    expect(plugin.id).toBe('elo');
    expect(plugin.purity).toBe('stateful');
    expect(plugin.tools).toHaveLength(2);
    expect(plugin.tools![0].name).toBe('get_leaderboard');
    expect(plugin.tools![1].name).toBe('get_my_stats');
  });

  it('get_leaderboard returns players', () => {
    const p1 = plugin.tracker.getOrCreatePlayer('alice');
    const p2 = plugin.tracker.getOrCreatePlayer('bob');

    plugin.tracker.recordMatch('m1', 'seed', 10, 'A', [
      { id: p1.id, team: 'A', unitClass: 'rogue' },
      { id: p2.id, team: 'B', unitClass: 'knight' },
    ]);

    const caller: AgentInfo = { id: p1.id, handle: 'alice' };
    const result = plugin.handleCall!('get_leaderboard', { limit: 10 }, caller) as any;
    expect(result.leaderboard).toHaveLength(2);
    expect(result.leaderboard[0].elo).toBeGreaterThan(result.leaderboard[1].elo);
  });

  it('get_my_stats returns player info and matches', () => {
    const p1 = plugin.tracker.getOrCreatePlayer('alice');
    const p2 = plugin.tracker.getOrCreatePlayer('bob');

    plugin.tracker.recordMatch('m1', 'seed', 10, 'A', [
      { id: p1.id, team: 'A', unitClass: 'rogue' },
      { id: p2.id, team: 'B', unitClass: 'knight' },
    ]);

    const caller: AgentInfo = { id: p1.id, handle: 'alice' };
    const result = plugin.handleCall!('get_my_stats', {}, caller) as any;
    expect(result.player.handle).toBe('alice');
    expect(result.player.elo).toBeGreaterThan(1200);
    expect(result.recentMatches).toHaveLength(1);
  });

  it('get_my_stats returns error for unknown player', () => {
    const caller: AgentInfo = { id: 'unknown', handle: 'nobody' };
    const result = plugin.handleCall!('get_my_stats', {}, caller) as any;
    expect(result.error).toBe('Player not found');
  });

  it('handleData returns leaderboard', () => {
    plugin.tracker.getOrCreatePlayer('alice');
    const data = plugin.handleData('stats', new Map());
    expect(data.has('leaderboard')).toBe(true);
  });

  it('rejects unknown tool', () => {
    const caller: AgentInfo = { id: '1', handle: 'test' };
    const result = plugin.handleCall!('unknown', {}, caller) as any;
    expect(result.error).toContain('Unknown tool');
  });
});

// Also verify the EloTracker itself still works (moved from server tests)
describe('EloTracker', () => {
  let tracker: EloTracker;

  beforeEach(() => {
    tracker = new EloTracker();
  });

  afterEach(() => {
    tracker.close();
  });

  it('calculateEloChange: equal ELOs', () => {
    expect(EloTracker.calculateEloChange(1200, 1200, 'win')).toBe(16);
    expect(EloTracker.calculateEloChange(1200, 1200, 'loss')).toBe(-16);
    expect(EloTracker.calculateEloChange(1200, 1200, 'draw')).toBe(0);
  });

  it('creates and retrieves players', () => {
    const player = tracker.getOrCreatePlayer('alice');
    expect(player.handle).toBe('alice');
    expect(player.elo).toBe(1200);

    const same = tracker.getOrCreatePlayer('alice');
    expect(same.id).toBe(player.id);
  });

  it('records match and updates ELOs', () => {
    const p1 = tracker.getOrCreatePlayer('alice');
    const p2 = tracker.getOrCreatePlayer('bob');

    tracker.recordMatch('m1', 'seed', 10, 'A', [
      { id: p1.id, team: 'A', unitClass: 'rogue' },
      { id: p2.id, team: 'B', unitClass: 'knight' },
    ]);

    const alice = tracker.getPlayer(p1.id)!;
    const bob = tracker.getPlayer(p2.id)!;
    expect(alice.elo).toBeGreaterThan(1200);
    expect(bob.elo).toBeLessThan(1200);
    expect(alice.gamesPlayed).toBe(1);
    expect(alice.wins).toBe(1);
  });

  it('leaderboard is sorted by ELO desc', () => {
    const p1 = tracker.getOrCreatePlayer('alice');
    const p2 = tracker.getOrCreatePlayer('bob');

    tracker.recordMatch('m1', 'seed', 10, 'A', [
      { id: p1.id, team: 'A', unitClass: 'rogue' },
      { id: p2.id, team: 'B', unitClass: 'knight' },
    ]);

    const board = tracker.getLeaderboard();
    expect(board[0].handle).toBe('alice');
    expect(board[1].handle).toBe('bob');
  });
});
