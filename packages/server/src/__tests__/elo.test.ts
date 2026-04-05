import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EloTracker } from '../elo.js';

describe('EloTracker', () => {
  let tracker: EloTracker;

  beforeEach(() => {
    tracker = new EloTracker(); // in-memory
  });

  afterEach(() => {
    tracker.close();
  });

  describe('calculateEloChange', () => {
    it('equal ELOs win/loss gives ~+16/-16', () => {
      const winDelta = EloTracker.calculateEloChange(1200, 1200, 'win');
      const lossDelta = EloTracker.calculateEloChange(1200, 1200, 'loss');
      expect(winDelta).toBe(16);
      expect(lossDelta).toBe(-16);
    });

    it('higher ELO beats lower = small gain, large loss for lower', () => {
      const highWinDelta = EloTracker.calculateEloChange(1600, 1200, 'win');
      const lowLossDelta = EloTracker.calculateEloChange(1200, 1600, 'loss');
      // High-rated player wins: small gain (expected to win)
      expect(highWinDelta).toBeLessThan(10);
      expect(highWinDelta).toBeGreaterThan(0);
      // Low-rated player loses: large loss
      expect(lowLossDelta).toBeLessThan(0);
      expect(lowLossDelta).toBeGreaterThan(-10);
      // They should be symmetric (opposite signs)
      expect(highWinDelta).toBe(-lowLossDelta);
    });

    it('draw between equal players = 0 change', () => {
      const delta = EloTracker.calculateEloChange(1200, 1200, 'draw');
      expect(delta).toBe(0);
    });

    it('underdog win = large gain', () => {
      const underdogWin = EloTracker.calculateEloChange(1200, 1600, 'win');
      const favoriteWin = EloTracker.calculateEloChange(1600, 1200, 'win');
      expect(underdogWin).toBeGreaterThan(favoriteWin);
      expect(underdogWin).toBeGreaterThan(20);
    });
  });

  describe('getOrCreatePlayer', () => {
    it('creates new player with defaults', () => {
      const player = tracker.getOrCreatePlayer('alice');
      expect(player.handle).toBe('alice');
      expect(player.elo).toBe(1200);
      expect(player.gamesPlayed).toBe(0);
      expect(player.wins).toBe(0);
      expect(player.id).toBeTruthy();
      expect(player.createdAt).toBeTruthy();
    });

    it('returns existing player on second call', () => {
      const first = tracker.getOrCreatePlayer('bob');
      const second = tracker.getOrCreatePlayer('bob');
      expect(first.id).toBe(second.id);
      expect(first.handle).toBe(second.handle);
    });
  });

  describe('recordMatch', () => {
    it('updates ELOs correctly for all players', () => {
      const p1 = tracker.getOrCreatePlayer('alice');
      const p2 = tracker.getOrCreatePlayer('bob');
      const p3 = tracker.getOrCreatePlayer('carol');
      const p4 = tracker.getOrCreatePlayer('dave');

      tracker.recordMatch(
        'match-1',
        'seed-abc',
        25,
        'A',
        [
          { id: p1.id, team: 'A', unitClass: 'warrior' },
          { id: p2.id, team: 'A', unitClass: 'archer' },
          { id: p3.id, team: 'B', unitClass: 'warrior' },
          { id: p4.id, team: 'B', unitClass: 'mage' },
        ]
      );

      const alice = tracker.getPlayer(p1.id)!;
      const bob = tracker.getPlayer(p2.id)!;
      const carol = tracker.getPlayer(p3.id)!;
      const dave = tracker.getPlayer(p4.id)!;

      // Winners gained ELO
      expect(alice.elo).toBeGreaterThan(1200);
      expect(bob.elo).toBeGreaterThan(1200);
      // Losers lost ELO
      expect(carol.elo).toBeLessThan(1200);
      expect(dave.elo).toBeLessThan(1200);
      // Games played updated
      expect(alice.gamesPlayed).toBe(1);
      expect(alice.wins).toBe(1);
      expect(carol.gamesPlayed).toBe(1);
      expect(carol.wins).toBe(0);
      // All team members get same delta (equal starting ELO)
      expect(alice.elo).toBe(bob.elo);
      expect(carol.elo).toBe(dave.elo);
    });

    it('draw gives small adjustments', () => {
      const p1 = tracker.getOrCreatePlayer('alice');
      const p2 = tracker.getOrCreatePlayer('bob');

      tracker.recordMatch(
        'match-draw',
        'seed-xyz',
        30,
        null,
        [
          { id: p1.id, team: 'A', unitClass: 'warrior' },
          { id: p2.id, team: 'B', unitClass: 'archer' },
        ]
      );

      const alice = tracker.getPlayer(p1.id)!;
      const bob = tracker.getPlayer(p2.id)!;

      // Equal ELOs draw => no change
      expect(alice.elo).toBe(1200);
      expect(bob.elo).toBe(1200);
      expect(alice.gamesPlayed).toBe(1);
      expect(alice.wins).toBe(0);
    });
  });

  describe('getLeaderboard', () => {
    it('returns players sorted by ELO descending', () => {
      const p1 = tracker.getOrCreatePlayer('alice');
      const p2 = tracker.getOrCreatePlayer('bob');
      const p3 = tracker.getOrCreatePlayer('carol');

      // alice beats bob
      tracker.recordMatch('m1', 'seed', 10, 'A', [
        { id: p1.id, team: 'A', unitClass: 'warrior' },
        { id: p2.id, team: 'B', unitClass: 'archer' },
      ]);
      // carol beats bob
      tracker.recordMatch('m2', 'seed', 10, 'A', [
        { id: p3.id, team: 'A', unitClass: 'mage' },
        { id: p2.id, team: 'B', unitClass: 'archer' },
      ]);

      const board = tracker.getLeaderboard();
      expect(board.length).toBe(3);
      // alice and carol both won 1 game from 1200 base
      expect(board[0].elo).toBeGreaterThanOrEqual(board[1].elo);
      expect(board[1].elo).toBeGreaterThanOrEqual(board[2].elo);
      // bob should be last (lost twice)
      expect(board[2].handle).toBe('bob');
    });
  });

  describe('getPlayerMatches', () => {
    it('returns match history with ELO changes', () => {
      const p1 = tracker.getOrCreatePlayer('alice');
      const p2 = tracker.getOrCreatePlayer('bob');

      tracker.recordMatch('m1', 'seed-1', 15, 'A', [
        { id: p1.id, team: 'A', unitClass: 'warrior' },
        { id: p2.id, team: 'B', unitClass: 'archer' },
      ]);

      tracker.recordMatch('m2', 'seed-2', 20, 'B', [
        { id: p1.id, team: 'A', unitClass: 'mage' },
        { id: p2.id, team: 'B', unitClass: 'warrior' },
      ]);

      const matches = tracker.getPlayerMatches(p1.id);
      expect(matches.length).toBe(2);
      // Most recent first
      expect(matches[0].id).toBe('m2');
      expect(matches[1].id).toBe('m1');
      // First match: alice won
      expect(matches[1].eloBefore).toBe(1200);
      expect(matches[1].eloAfter).toBeGreaterThan(1200);
      expect(matches[1].team).toBe('A');
      expect(matches[1].unitClass).toBe('warrior');
      // Second match: alice lost
      expect(matches[0].eloBefore).toBe(matches[1].eloAfter);
      expect(matches[0].eloAfter).toBeLessThan(matches[0].eloBefore);
    });
  });
});
