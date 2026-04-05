import Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface Player {
  id: string;
  handle: string;
  elo: number;
  gamesPlayed: number;
  wins: number;
  createdAt: string;
}

export interface MatchRecord {
  id: string;
  mapSeed: string;
  turns: number;
  winnerTeam: 'A' | 'B' | null;
  startedAt: string;
  endedAt: string;
  replayData?: any;
}

export interface MatchPlayerRecord {
  matchId: string;
  playerId: string;
  team: 'A' | 'B';
  unitClass: string;
  eloBefore: number;
  eloAfter: number;
}

export class EloTracker {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initDb();
  }

  initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        handle TEXT UNIQUE NOT NULL,
        elo INTEGER DEFAULT 1200,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        map_seed TEXT NOT NULL,
        turns INTEGER,
        winner_team TEXT,
        started_at TEXT,
        ended_at TEXT,
        replay_data TEXT
      );

      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT REFERENCES matches(id),
        player_id TEXT REFERENCES players(id),
        team TEXT NOT NULL,
        class TEXT NOT NULL,
        elo_before INTEGER,
        elo_after INTEGER,
        PRIMARY KEY (match_id, player_id)
      );
    `);
  }

  getOrCreatePlayer(handle: string): Player {
    const existing = this.getPlayerByHandle(handle);
    if (existing) return existing;

    const id = crypto.randomUUID();
    this.db.prepare(
      'INSERT INTO players (id, handle) VALUES (?, ?)'
    ).run(id, handle);

    return this.getPlayer(id)!;
  }

  getPlayer(id: string): Player | null {
    const row = this.db.prepare('SELECT * FROM players WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToPlayer(row);
  }

  getPlayerByHandle(handle: string): Player | null {
    const row = this.db.prepare('SELECT * FROM players WHERE handle = ?').get(handle) as any;
    if (!row) return null;
    return this.rowToPlayer(row);
  }

  static calculateEloChange(
    teamElo: number,
    opponentElo: number,
    result: 'win' | 'loss' | 'draw',
    kFactor: number = 32
  ): number {
    const expected = 1 / (1 + Math.pow(10, (opponentElo - teamElo) / 400));
    const score = result === 'win' ? 1 : result === 'loss' ? 0 : 0.5;
    return Math.round(kFactor * (score - expected));
  }

  recordMatch(
    matchId: string,
    mapSeed: string,
    turns: number,
    winnerTeam: 'A' | 'B' | null,
    players: { id: string; team: 'A' | 'B'; unitClass: string }[],
    replayData?: any
  ): void {
    const now = new Date().toISOString();

    const teamA = players.filter(p => p.team === 'A');
    const teamB = players.filter(p => p.team === 'B');

    const avgElo = (team: typeof players) => {
      const elos = team.map(p => this.getPlayer(p.id)!.elo);
      return elos.reduce((a, b) => a + b, 0) / elos.length;
    };

    const teamAElo = avgElo(teamA);
    const teamBElo = avgElo(teamB);

    const transaction = this.db.transaction(() => {
      // Insert match record
      this.db.prepare(
        'INSERT INTO matches (id, map_seed, turns, winner_team, started_at, ended_at, replay_data) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(matchId, mapSeed, turns, winnerTeam, now, now, replayData ? JSON.stringify(replayData) : null);

      // Calculate and apply ELO changes for each player
      for (const p of players) {
        const player = this.getPlayer(p.id)!;
        const isTeamA = p.team === 'A';
        const myTeamElo = isTeamA ? teamAElo : teamBElo;
        const oppTeamElo = isTeamA ? teamBElo : teamAElo;

        let result: 'win' | 'loss' | 'draw';
        if (winnerTeam === null) {
          result = 'draw';
        } else if (winnerTeam === p.team) {
          result = 'win';
        } else {
          result = 'loss';
        }

        const delta = EloTracker.calculateEloChange(myTeamElo, oppTeamElo, result);
        const newElo = player.elo + delta;
        const won = result === 'win' ? 1 : 0;

        // Insert match_player record
        this.db.prepare(
          'INSERT INTO match_players (match_id, player_id, team, class, elo_before, elo_after) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(matchId, p.id, p.team, p.unitClass, player.elo, newElo);

        // Update player stats
        this.db.prepare(
          'UPDATE players SET elo = ?, games_played = games_played + 1, wins = wins + ? WHERE id = ?'
        ).run(newElo, won, p.id);
      }
    });

    transaction();
  }

  getLeaderboard(limit: number = 50, offset: number = 0): Player[] {
    const rows = this.db.prepare(
      'SELECT * FROM players ORDER BY elo DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as any[];
    return rows.map(r => this.rowToPlayer(r));
  }

  getPlayerMatches(
    playerId: string,
    limit: number = 20
  ): (MatchRecord & { team: string; unitClass: string; eloBefore: number; eloAfter: number })[] {
    const rows = this.db.prepare(`
      SELECT m.*, mp.team, mp.class AS unit_class, mp.elo_before, mp.elo_after
      FROM matches m
      JOIN match_players mp ON m.id = mp.match_id
      WHERE mp.player_id = ?
      ORDER BY m.rowid DESC
      LIMIT ?
    `).all(playerId, limit) as any[];

    return rows.map(r => ({
      id: r.id,
      mapSeed: r.map_seed,
      turns: r.turns,
      winnerTeam: r.winner_team as 'A' | 'B' | null,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      replayData: r.replay_data ? JSON.parse(r.replay_data) : undefined,
      team: r.team,
      unitClass: r.unit_class,
      eloBefore: r.elo_before,
      eloAfter: r.elo_after,
    }));
  }

  close(): void {
    this.db.close();
  }

  private rowToPlayer(row: any): Player {
    return {
      id: row.id,
      handle: row.handle,
      elo: row.elo,
      gamesPlayed: row.games_played,
      wins: row.wins,
      createdAt: row.created_at,
    };
  }
}
