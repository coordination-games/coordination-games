import { useEffect, useState } from 'react';
import { fetchLeaderboard } from '../api';

interface Player {
  handle: string;
  elo: number;
  gamesPlayed: number;
  wins: number;
}

function rankStyle(rank: number) {
  if (rank === 1) return { color: 'var(--color-amber-glow)', fontWeight: 700 };
  if (rank === 2) return { color: 'var(--color-wood-light)', fontWeight: 700 };
  if (rank === 3) return { color: 'var(--color-amber-dim)', fontWeight: 700 };
  return { color: 'var(--color-ink-faint)' };
}

function eloStyle(rank: number) {
  if (rank <= 3) return { color: 'var(--color-amber)' };
  return { color: 'var(--color-ink)' };
}

export default function LeaderboardPage() {
  const [players, setPlayers] = useState<Player[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await fetchLeaderboard();
        if (!cancelled) setPlayers(data as Player[]);
      } catch {}
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = [...players].sort((a, b) => b.elo - a.elo);

  return (
    <div>
      <h2
        className="font-heading mb-4 sm:mb-6 text-xl sm:text-2xl font-bold tracking-wide"
        style={{ color: 'var(--color-ink)' }}
      >
        Leaderboard
      </h2>

      <div className="overflow-x-auto rounded-xl parchment-strong">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left font-heading text-xs uppercase tracking-wider"
              style={{
                borderBottom: '2px solid rgba(42, 31, 14, 0.1)',
                color: 'var(--color-ink-faint)',
              }}
            >
              <th className="px-2 sm:px-5 py-2 sm:py-3 w-10 sm:w-16">#</th>
              <th className="px-2 sm:px-5 py-2 sm:py-3">Handle</th>
              <th className="px-2 sm:px-5 py-2 sm:py-3 text-right">ELO</th>
              <th className="hidden sm:table-cell px-5 py-3 text-right">Games</th>
              <th className="hidden sm:table-cell px-5 py-3 text-right">Wins</th>
              <th className="px-2 sm:px-5 py-2 sm:py-3 text-right">W%</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((player, i) => {
              const rank = i + 1;
              const winRate =
                player.gamesPlayed > 0 ? Math.round((player.wins / player.gamesPlayed) * 100) : 0;

              return (
                <tr
                  key={player.handle}
                  className="transition-colors"
                  style={{
                    borderBottom: '1px solid rgba(42, 31, 14, 0.06)',
                    background: rank % 2 === 0 ? 'rgba(42, 31, 14, 0.02)' : 'transparent',
                  }}
                >
                  <td className="px-2 sm:px-5 py-2 sm:py-3 font-heading" style={rankStyle(rank)}>
                    {rank}
                  </td>
                  <td className="px-2 sm:px-5 py-2 sm:py-3">
                    <span
                      className="font-mono text-xs sm:text-sm"
                      style={{ color: 'var(--color-ink)' }}
                    >
                      {rank === 1 && <span className="mr-1.5">🦞</span>}
                      {player.handle}
                    </span>
                  </td>
                  <td
                    className="px-2 sm:px-5 py-2 sm:py-3 text-right text-sm sm:text-base font-bold font-heading"
                    style={eloStyle(rank)}
                  >
                    {player.elo}
                  </td>
                  <td
                    className="hidden sm:table-cell px-5 py-3 text-right"
                    style={{ color: 'var(--color-ink-light)' }}
                  >
                    {player.gamesPlayed}
                  </td>
                  <td
                    className="hidden sm:table-cell px-5 py-3 text-right"
                    style={{ color: 'var(--color-ink-light)' }}
                  >
                    {player.wins}
                  </td>
                  <td
                    className="px-2 sm:px-5 py-2 sm:py-3 text-right font-medium"
                    style={{ color: winRate >= 50 ? 'var(--color-forest)' : 'var(--color-blood)' }}
                  >
                    {winRate}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
