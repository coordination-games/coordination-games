/**
 * Async D1-backed ELO tracker.
 * Mirrors the synchronous better-sqlite3 interface from packages/plugins/elo/src/tracker.ts
 * but uses D1 via awaited queries.
 */

import type { Env } from '../env.js';
import { type Player, rowToPlayer } from './player.js';

export type { Player } from './player.js';

export interface MatchRecord {
  id: string;
  gameType: string;
  mapSeed: string | null;
  turns: number | null;
  winnerTeam: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export class D1EloTracker {
  constructor(private db: D1Database) {}

  static fromEnv(env: Env): D1EloTracker {
    return new D1EloTracker(env.DB);
  }

  // ---------------------------------------------------------------------------
  // Player reads
  // ---------------------------------------------------------------------------

  async getPlayer(id: string): Promise<Player | null> {
    // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
    const row = await this.db.prepare('SELECT * FROM players WHERE id = ?').bind(id).first<any>();
    return row ? rowToPlayer(row) : null;
  }

  async getPlayerByHandle(handle: string): Promise<Player | null> {
    const row = await this.db
      .prepare('SELECT * FROM players WHERE handle = ?')
      .bind(handle)
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      .first<any>();
    return row ? rowToPlayer(row) : null;
  }

  async getLeaderboard(limit: number = 50, offset: number = 0): Promise<Player[]> {
    const result = await this.db
      .prepare('SELECT * FROM players ORDER BY elo DESC LIMIT ? OFFSET ?')
      .bind(limit, offset)
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      .all<any>();
    return result.results.map(rowToPlayer);
  }

  // ---------------------------------------------------------------------------
  // ELO calculation (static — no DB needed)
  // ---------------------------------------------------------------------------

  static calculateEloChange(
    teamElo: number,
    opponentElo: number,
    result: 'win' | 'loss' | 'draw',
    kFactor: number = 32,
  ): number {
    const expected = 1 / (1 + 10 ** ((opponentElo - teamElo) / 400));
    const score = result === 'win' ? 1 : result === 'loss' ? 0 : 0.5;
    return Math.round(kFactor * (score - expected));
  }

  // ---------------------------------------------------------------------------
  // Match recording — generic payout-based (mirrors EloTracker.recordGameResult)
  // ---------------------------------------------------------------------------

  async recordGameResult(
    matchId: string,
    gameType: string,
    players: { handle: string; payout: number }[],
  ): Promise<void> {
    if (players.length < 2) return;

    // Resolve players — must exist via resolvePlayer() from auth
    const dbPlayers: { handle: string; payout: number; db: Player }[] = [];
    for (const p of players) {
      const existing = await this.getPlayerByHandle(p.handle);
      if (!existing) {
        console.error(
          `[elo] Player "${p.handle}" not found — skipping (was resolvePlayer called during auth?)`,
        );
        continue;
      }
      dbPlayers.push({ ...p, db: existing });
    }
    if (dbPlayers.length < 2) return;

    const winners = dbPlayers.filter((p) => p.payout > 0);
    const losers = dbPlayers.filter((p) => p.payout < 0);
    const isAllDraw = winners.length === 0 && losers.length === 0;

    const avgElo = (group: typeof dbPlayers) =>
      group.length === 0 ? 1200 : group.reduce((s, p) => s + p.db.elo, 0) / group.length;

    const winnerElo = avgElo(winners.length > 0 ? winners : dbPlayers);
    const loserElo = avgElo(losers.length > 0 ? losers : dbPlayers);

    const now = new Date().toISOString();

    // Insert match
    await this.db
      .prepare(
        'INSERT INTO matches (id, game_type, map_seed, turns, winner_team, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(matchId, gameType, null, 0, isAllDraw ? null : 'W', now, now)
      .run();

    // Process each player
    for (const p of dbPlayers) {
      let result: 'win' | 'loss' | 'draw';
      if (isAllDraw || p.payout === 0) {
        result = 'draw';
      } else if (p.payout > 0) {
        result = 'win';
      } else {
        result = 'loss';
      }

      const myGroupElo =
        result === 'win' ? winnerElo : result === 'loss' ? loserElo : avgElo(dbPlayers);
      const oppGroupElo =
        result === 'win' ? loserElo : result === 'loss' ? winnerElo : avgElo(dbPlayers);

      const delta = D1EloTracker.calculateEloChange(myGroupElo, oppGroupElo, result);
      const newElo = p.db.elo + delta;
      const won = result === 'win' ? 1 : 0;

      await this.db
        .prepare(
          'INSERT INTO match_players (match_id, player_id, team, class, elo_before, elo_after) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          matchId,
          p.db.id,
          result === 'win' ? 'W' : result === 'loss' ? 'L' : 'D',
          'unknown',
          p.db.elo,
          newElo,
        )
        .run();

      await this.db
        .prepare(
          'UPDATE players SET elo = ?, games_played = games_played + 1, wins = wins + ? WHERE id = ?',
        )
        .bind(newElo, won, p.db.id)
        .run();
    }
  }

  // ---------------------------------------------------------------------------
  // Match history
  // ---------------------------------------------------------------------------

  // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
  async getPlayerMatches(playerId: string, limit: number = 20): Promise<any[]> {
    const result = await this.db
      .prepare(`
      SELECT m.*, mp.team, mp.class AS unit_class, mp.elo_before, mp.elo_after
      FROM matches m
      JOIN match_players mp ON m.id = mp.match_id
      WHERE mp.player_id = ?
      ORDER BY m.rowid DESC
      LIMIT ?
    `)
      .bind(playerId, limit)
      // biome-ignore lint/suspicious/noExplicitAny: pre-existing any usage; type unification deferred — TODO(4.1)
      .all<any>();

    return result.results.map((r) => ({
      id: r.id,
      gameType: r.game_type,
      mapSeed: r.map_seed,
      turns: r.turns,
      winnerTeam: r.winner_team,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      team: r.team,
      unitClass: r.unit_class,
      eloBefore: r.elo_before,
      eloAfter: r.elo_after,
    }));
  }
}
